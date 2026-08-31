r"""
Resolucion de API_URL en tiempo de ejecucion.

El quick tunnel gratuito de cloudflared cambia de URL cada vez que se
reinicia. Editar la configuracion de cada maquina de Red A tras cada reinicio
no escala, asi que la URL vive en un archivo que los agentes leen en cada
ciclo. Como los agentes van empaquetados como .exe (en Red A no hay Python),
esto tambien evita tener que reempaquetarlos.

Orden de precedencia:
  1. API_URL en el entorno o en agent.env  -> gana siempre (override manual)
  2. API_URL_FILE, y si no esta, la ruta por convencion C:\imp\url.txt
       - ruta local o de red:  C:\imp\url.txt  |  \SERVIDOR\monitoreo\url.txt
       - URL http(s):          https://.../url.txt   (gist, GitHub raw)
  3. cache local del ultimo valor bueno    -> si (2) no responde

El paso 3 es lo que evita que un corte momentaneo del origen tumbe el ciclo:
se sigue usando la ultima URL conocida y queda el aviso en el log.

Formato de C:\imp\url.txt -- la primera linea util, en cualquiera de estas
dos formas:

    # actualizado por el script de cloudflared en Red B
    URL=https://algo-aleatorio.trycloudflare.com
"""

import os
from pathlib import Path

CACHE_NAME = ".api_url.cache"

# Ruta por convencion en las maquinas de Red A. Se puede sobreescribir con
# API_URL_FILE, pero si no se configura nada el agente busca aca.
DEFAULT_URL_FILE = r"C:\imp\url.txt"


class ApiUrlError(RuntimeError):
    """No se pudo determinar a que URL enviar los datos."""


def _parse(texto: str) -> str:
    r"""Primera linea util del archivo. Acepta 'URL=https://...' (el formato
    de C:\imp\url.txt) y tambien una URL pelada."""
    for linea in texto.splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#"):
            continue
        if not linea.lower().startswith(("http://", "https://")) and "=" in linea:
            # formato CLAVE=valor: se toma lo que viene despues del primer '='
            _, _, linea = linea.partition("=")
            linea = linea.strip().strip('"').strip("'")
        if not linea.lower().startswith(("http://", "https://")):
            raise ApiUrlError(f"no se encontro una URL http(s) valida, se leyo: {linea!r}")
        return linea.rstrip("/")
    raise ApiUrlError("el archivo no contiene ninguna URL")


def _leer_origen(origen: str, timeout: float) -> str:
    if origen.lower().startswith(("http://", "https://")):
        import requests                      # perezoso: pr_stats_agent lo importa tarde
        resp = requests.get(origen, timeout=timeout)
        resp.raise_for_status()
        return _parse(resp.text)
    ruta = Path(origen)
    if not ruta.exists():
        # FileNotFoundError y no ApiUrlError: mas abajo se usa el tipo para
        # distinguir "no llegue al archivo" de "el archivo dice cualquier cosa".
        raise FileNotFoundError(f"no existe: {ruta}")
    # utf-8-sig: el Bloc de notas de Windows guarda con BOM, y ese BOM
    # invisible al principio de la linea rompe la deteccion de "https://".
    return _parse(ruta.read_text(encoding="utf-8-sig"))


def resolve_api_url(base_dir, log=None) -> str:
    """Devuelve la URL base de api_server, sin barra final.

    base_dir: carpeta del .exe/.py, donde se guarda el cache.
    log:      logger opcional; si falta, los avisos se pierden, asi que
              conviene pasarlo siempre.
    """
    def _log(nivel, msg):
        if log is not None:
            getattr(log, nivel)(msg)

    directa = os.environ.get("API_URL", "").strip()
    if directa:
        return directa.rstrip("/")

    origen = os.environ.get("API_URL_FILE", "").strip() or DEFAULT_URL_FILE
    cache = Path(base_dir) / CACHE_NAME
    timeout = float(os.environ.get("API_URL_FILE_TIMEOUT", "10"))

    try:
        url = _leer_origen(origen, timeout)
    except Exception as e:
        # El origen no sirve: seguir con la ultima URL buena antes que parar.
        causa = ("contenido invalido" if isinstance(e, ApiUrlError)
                 else "origen inalcanzable")
        if cache.exists():
            url = cache.read_text(encoding="utf-8").strip()
            _log("warning", f"API_URL_FILE ({origen}): {causa} -- {e}. "
                            f"Se sigue con la ultima URL conocida: {url}. "
                            f"REVISAR: si el tunel cambio, esta URL ya no sirve.")
            return url
        raise ApiUrlError(
            f"No se pudo leer la URL del tunel desde {origen} ({causa}: {e}), "
            f"y no hay cache local en {cache}. "
            f"Crear el archivo con una linea 'URL=https://...' o definir "
            f"API_URL en agent.env."
        ) from e

    try:
        if not cache.exists() or cache.read_text(encoding="utf-8").strip() != url:
            cache.write_text(url, encoding="utf-8")
            _log("info", f"API_URL resuelta desde {origen}: {url}")
    except OSError as e:
        _log("warning", f"No se pudo escribir el cache de API_URL: {e}")

    return url
