r"""
Resolucion de API_URL en tiempo de ejecucion.

El quick tunnel gratuito de cloudflared cambia de URL cada vez que se
reinicia. Editar el agent.env de cada maquina en Red A tras cada reinicio no
escala, asi que la URL puede vivir en UN solo sitio compartido y los agentes
la leen en cada ciclo.

Orden de precedencia:
  1. API_URL en el entorno o en agent.env  -> gana siempre (override manual)
  2. API_URL_FILE                          -> de donde leerla; admite
       - ruta de red o local:  \\SERVIDOR\monitoreo\api_url.txt
       - URL http(s):          https://.../api_url.txt   (gist, GitHub raw)
  3. cache local del ultimo valor bueno    -> si (2) no responde

El paso 3 es lo que evita que un corte momentaneo del recurso compartido
tumbe el ciclo: se sigue usando la ultima URL conocida.

Formato del archivo: la primera linea no vacia que no empiece con '#'.

    # actualizado por el script de cloudflared en Red B
    https://algo-aleatorio.trycloudflare.com
"""

import os
from pathlib import Path

CACHE_NAME = ".api_url.cache"


class ApiUrlError(RuntimeError):
    """No se pudo determinar a que URL enviar los datos."""


def _parse(texto: str) -> str:
    for linea in texto.splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#"):
            continue
        if not linea.startswith(("http://", "https://")):
            raise ApiUrlError(f"la URL leida no empieza con http(s): {linea!r}")
        return linea.rstrip("/")
    raise ApiUrlError("el archivo no contiene ninguna URL")


def _leer_origen(origen: str, timeout: float) -> str:
    if origen.startswith(("http://", "https://")):
        import requests                      # perezoso: pr_stats_agent lo importa tarde
        resp = requests.get(origen, timeout=timeout)
        resp.raise_for_status()
        return _parse(resp.text)
    ruta = Path(origen)
    if not ruta.exists():
        # FileNotFoundError y no ApiUrlError: arriba se usa el tipo para
        # distinguir "no llego al archivo" de "el archivo dice cualquier cosa".
        raise FileNotFoundError(f"no existe: {ruta}")
    return _parse(ruta.read_text(encoding="utf-8"))


def resolve_api_url(base_dir, log=None) -> str:
    """Devuelve la URL base de api_server, sin barra final.

    base_dir: carpeta del .exe/.py, donde se guarda el cache.
    log:      logger opcional; si falta, no imprime nada.
    """
    def _log(nivel, msg):
        if log is not None:
            getattr(log, nivel)(msg)

    directa = os.environ.get("API_URL", "").strip()
    if directa:
        return directa.rstrip("/")

    origen = os.environ.get("API_URL_FILE", "").strip()
    if not origen:
        raise ApiUrlError(
            "Falta API_URL (o API_URL_FILE) en agent.env. "
            "El agente no sabe a donde enviar los datos."
        )

    cache = Path(base_dir) / CACHE_NAME
    timeout = float(os.environ.get("API_URL_FILE_TIMEOUT", "10"))

    try:
        url = _leer_origen(origen, timeout)
    except Exception as e:
        # El origen no sirve: seguir con la ultima URL buena antes que parar.
        # Se distingue el contenido invalido (error de quien edito el archivo)
        # de un origen inalcanzable (red), porque se arreglan distinto.
        causa = ("contenido invalido" if isinstance(e, ApiUrlError)
                 else "origen inalcanzable")
        if cache.exists():
            url = cache.read_text(encoding="utf-8").strip()
            _log("warning", f"API_URL_FILE ({origen}): {causa} -- {e}. "
                            f"Se sigue con la ultima URL conocida: {url}. "
                            f"REVISAR: si el tunel cambio, esta URL ya no sirve.")
            return url
        raise ApiUrlError(
            f"No se pudo leer API_URL_FILE ({origen}): {e}. "
            f"Tampoco hay cache local en {cache}."
        ) from e

    try:
        if not cache.exists() or cache.read_text(encoding="utf-8").strip() != url:
            cache.write_text(url, encoding="utf-8")
            _log("info", f"API_URL resuelta desde {origen}: {url}")
    except OSError as e:
        _log("warning", f"No se pudo escribir el cache de API_URL: {e}")

    return url
