"""
Agente Monitor Lexmark
Consulta impresoras via SNMP y envía los datos a la API REST en Red B.
Fuente de verdad: inventario2026.csv (debe estar junto al .exe)
"""

import os
import sys
import time
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

# ─────────────────────────────────────────────
# BASE_DIR: funciona tanto como .py como .exe
# ─────────────────────────────────────────────
if getattr(sys, "frozen", False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ─────────────────────────────────────────────
# LOG TEMPRANO — antes de los imports pesados.
# Si pandas o puresnmp fallan al cargar (falta una dependencia en el .exe,
# metadata no empaquetada, etc.) el error tiene que quedar escrito en
# agente.log. Con el log armado despues, esos fallos no dejaban rastro:
# la ventana se cerraba y no habia forma de saber que paso.
# ─────────────────────────────────────────────
LOG_FILE = os.path.join(BASE_DIR, "agente.log")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger(__name__)

try:
    import pandas as pd
    import requests
    from puresnmp import get
    import puresnmp.exc
    from api_url import resolve_api_url, ApiUrlError
except Exception as _e:
    logging.getLogger(__name__).exception(f"Error al importar dependencias: {_e}")
    sys.exit(1)

# ─────────────────────────────────────────────
# CARGAR VARIABLES DE ENTORNO DESDE agent.env
# Se usa un parser propio para no depender de python-dotenv en el .exe.
# Las variables del OS tienen precedencia sobre el archivo.
# ─────────────────────────────────────────────
def _load_env(filename: str = "agent.env") -> None:
    env_path = os.path.join(BASE_DIR, filename)
    if not os.path.exists(env_path):
        return
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key:
                os.environ.setdefault(key, val)   # OS tiene prioridad

_load_env()

# ─────────────────────────────────────────────
# CONFIG — todos los valores sensibles vienen del entorno
# ─────────────────────────────────────────────
INVENTARIO       = os.path.join(BASE_DIR, "inventario2026.csv")

# API_URL apunta al túnel cloudflared que expone api_server.py en Red B.
# Red A y Red B no comparten LAN, así que no hay IP directa que usar.
# Se resuelve en cada ejecución: si está API_URL_FILE, la lee de ahí (archivo
# compartido o URL), así un cambio del túnel se actualiza en un solo sitio.
# Ver api_url.py.
API_KEY          = os.environ.get("AGENT_API_KEY", "")

if not API_KEY:
    log.error("AGENT_API_KEY no configurada en agent.env "
              "(el archivo va junto al .exe).")
    sys.exit(1)

API_TIMEOUT      = int(os.environ.get("API_TIMEOUT", "60"))
SNMP_MAX_WORKERS = int(os.environ.get("SNMP_MAX_WORKERS", "20"))
SNMP_TIMEOUT     = float(os.environ.get("SNMP_TIMEOUT", "2.0"))
SNMP_COMMUNITY   = os.environ.get("SNMP_COMMUNITY", "public")

try:
    API_URL = resolve_api_url(BASE_DIR, log)
except ApiUrlError as _e:
    log.error(str(_e))
    sys.exit(1)

COLUMNAS = [
    "TIMESTAMP", "FECHA", "HORA", "IP", "ZONA", "SEDE", "AREA",
    "MODELO_INV", "TIPO", "SERIE", "CONEXION",
    "ESTADO", "MODELO_SNMP", "CONTADOR",
    "TONER_NEGRO", "TONER_CIAN", "TONER_MAGENTA", "TONER_AMARILLO",
    "FOTO_NEGRO", "FOTO_CIAN", "FOTO_MAGENTA", "FOTO_AMARILLO",
    "REVELADOR_NEGRO",
    "KIT_MANTENIMIENTO", "KIT_FUSOR",
    "CONTENEDOR_DESECHO"
]

# ─────────────────────────────────────────────
# SNMP
# ─────────────────────────────────────────────
def snmp_get(ip, oid, timeout=None):
    return get(ip, SNMP_COMMUNITY, oid, timeout=timeout or SNMP_TIMEOUT)

def decode(val):
    if isinstance(val, bytes):
        return val.decode("utf-8", "ignore")
    return str(val)

def consultar_impresora(row):
    ip = row["IP"]
    resultado = {
        "IP": ip,
        "ESTADO": "Offline",
        "MODELO_SNMP": "N/A", "CONTADOR": "N/A",
        "TONER_NEGRO": "N/A", "TONER_CIAN": "N/A",
        "TONER_MAGENTA": "N/A", "TONER_AMARILLO": "N/A",
        "FOTO_NEGRO": "N/A", "FOTO_CIAN": "N/A",
        "FOTO_MAGENTA": "N/A", "FOTO_AMARILLO": "N/A",
        "REVELADOR_NEGRO": "N/A",
        "KIT_MANTENIMIENTO": "N/A", "KIT_FUSOR": "N/A",
        "CONTENEDOR_DESECHO": "N/A"
    }

    try:
        mod_raw = snmp_get(ip, "1.3.6.1.2.1.1.1.0")
        con_raw = snmp_get(ip, "1.3.6.1.2.1.43.10.2.1.4.1.1")
        resultado["ESTADO"]      = "Online"
        resultado["MODELO_SNMP"] = decode(mod_raw).split("version")[0].strip()[:40]
        resultado["CONTADOR"]    = decode(con_raw).strip()

        for i in range(1, 41):
            try:
                nombre = decode(snmp_get(ip, f"1.3.6.1.2.1.43.11.1.1.6.1.{i}", 1.0)).lower()
                actual = float(snmp_get(ip, f"1.3.6.1.2.1.43.11.1.1.9.1.{i}", 1.0))
                maximo = float(snmp_get(ip, f"1.3.6.1.2.1.43.11.1.1.8.1.{i}", 1.0))

                if actual < 0 or maximo <= 0:
                    val = "OK"
                else:
                    val = f"{round((actual / maximo) * 100, 1)}%"

                if   "desecho" in nombre or "waste"       in nombre: resultado["CONTENEDOR_DESECHO"]  = val
                elif "fusor"   in nombre or "fuser"       in nombre: resultado["KIT_FUSOR"]           = val
                elif "manten"  in nombre or "maintenance" in nombre: resultado["KIT_MANTENIMIENTO"]   = val
                elif "revela"  in nombre or "developer"   in nombre: resultado["REVELADOR_NEGRO"]     = val
                elif any(x in nombre for x in ["imagen", "imaging", "fotocond", "photocond", "drum"]):
                    if   "cyan" in nombre or "cian"  in nombre: resultado["FOTO_CIAN"]     = val
                    elif "magenta"                   in nombre: resultado["FOTO_MAGENTA"]  = val
                    elif "yellow" in nombre or "amar" in nombre: resultado["FOTO_AMARILLO"] = val
                    else:                                        resultado["FOTO_NEGRO"]    = val
                elif any(x in nombre for x in ["cart", "toner", "tóner"]):
                    if   "cyan" in nombre or "cian"  in nombre: resultado["TONER_CIAN"]     = val
                    elif "magenta"                   in nombre: resultado["TONER_MAGENTA"]  = val
                    elif "yellow" in nombre or "amar" in nombre: resultado["TONER_AMARILLO"] = val
                    else:                                        resultado["TONER_NEGRO"]    = val

            except puresnmp.exc.SnmpError:
                continue
            except (TimeoutError, Exception):
                continue

    except TimeoutError:
        resultado["ESTADO"] = "Offline"
    except Exception as e:
        resultado["ESTADO"] = "Error"
        log.warning(f"[{ip}] excepción: {e}")

    return resultado

# ─────────────────────────────────────────────
# API REST
# ─────────────────────────────────────────────
def enviar(endpoint: str, filas: list):
    url = f"{API_URL}/{endpoint}"
    resp = requests.post(
        url,
        json={"filas": filas},
        headers={"x-api-key": API_KEY},
        timeout=API_TIMEOUT
    )
    resp.raise_for_status()
    data = resp.json()
    log.info(f"{endpoint}: {data.get('filas', '?')} filas enviadas.")
    return data

# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def descargar_inventario() -> bool:
    """Baja el inventario vigente del servidor y reescribe el CSV local.

    Devuelve True si se actualizo. Ante cualquier problema devuelve False y
    deja el CSV que ya estaba: es preferible monitorear con un inventario de
    ayer que no monitorear nada.
    """
    try:
        resp = requests.get(
            f"{API_URL}/inventario",
            headers={"x-api-key": API_KEY},
            timeout=API_TIMEOUT,
        )
        resp.raise_for_status()
        texto = resp.text
    except Exception as e:
        if os.path.exists(INVENTARIO):
            log.warning(f"No se pudo bajar el inventario del servidor ({e}). "
                        f"Se usa la copia local.")
        else:
            log.error(f"No se pudo bajar el inventario del servidor ({e}) y no "
                      f"hay copia local en {INVENTARIO}.")
        return False

    lineas = [l for l in texto.splitlines() if l.strip()]
    if len(lineas) < 2:
        log.warning("El servidor devolvio un inventario vacio. Se conserva la "
                    "copia local por seguridad.")
        return False

    # Escritura atomica: si el proceso muere a media escritura, el CSV bueno
    # sigue intacto en vez de quedar truncado.
    tmp = INVENTARIO + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as fh:
        fh.write(texto)
    os.replace(tmp, INVENTARIO)
    log.info(f"Inventario actualizado desde el servidor: {len(lineas) - 1} impresoras.")
    return True


def main():
    inicio = time.time()
    ahora  = datetime.now()
    ts     = ahora.strftime("%Y-%m-%d %H:%M:%S")
    fecha  = ahora.strftime("%Y-%m-%d")
    hora   = ahora.strftime("%H:%M:%S")

    log.info(f"=== Inicio ciclo {ts} ===")

    # Cargar inventario: primero se intenta bajar el vigente del servidor,
    # que es donde se edita ahora (dashboard -> tabla inventario). El CSV
    # local queda como copia y como respaldo si el servidor no responde, para
    # que una caida de red no deje un ciclo sin monitorear nada.
    descargar_inventario()

    if not os.path.exists(INVENTARIO):
        log.error(f"No se encontro el inventario: {INVENTARIO}. "
                  f"Tiene que estar junto al .exe, con las columnas IP y SERIE.")
        sys.exit(1)
    inv = pd.read_csv(INVENTARIO)
    inv.columns = [c.strip().upper() for c in inv.columns]
    faltantes = [c for c in ("IP", "SERIE") if c not in inv.columns]
    if faltantes:
        log.error(f"Al inventario le faltan columnas obligatorias: {', '.join(faltantes)}. "
                  f"La SERIE es la identidad de la impresora y el servidor la exige.")
        sys.exit(1)
    inv["IP"] = inv["IP"].str.strip()
    log.info(f"Inventario cargado: {len(inv)} impresoras.")

    # Consultar SNMP en paralelo
    log.info(f"Consultando SNMP con {SNMP_MAX_WORKERS} workers...")
    resultados = {}
    with ThreadPoolExecutor(max_workers=SNMP_MAX_WORKERS) as ex:
        futuros = {ex.submit(consultar_impresora, row): row["IP"]
                   for _, row in inv.iterrows()}
        for fut in as_completed(futuros):
            ip = futuros[fut]
            try:
                resultados[ip] = fut.result()
            except Exception as e:
                log.error(f"[{ip}] fallo grave: {e}")
                resultados[ip] = {"IP": ip, "ESTADO": "Error"}

    # Armar lista de filas
    filas = []
    for _, row in inv.iterrows():
        ip   = row["IP"]
        snmp = resultados.get(ip, {"IP": ip, "ESTADO": "Error"})
        filas.append({
            "TIMESTAMP":          ts,
            "FECHA":              fecha,
            "HORA":               hora,
            "IP":                 ip,
            "ZONA":               row.get("ZONA", ""),
            "SEDE":               row.get("SEDE", ""),
            "AREA":               row.get("AREA", ""),
            "MODELO_INV":         row.get("MODELO", ""),
            "TIPO":               row.get("TIPO", ""),
            "SERIE":              row.get("SERIE", ""),
            "CONEXION":           row.get("CONEXION", ""),
            "ESTADO":             snmp.get("ESTADO", "Error"),
            "MODELO_SNMP":        snmp.get("MODELO_SNMP", "N/A"),
            "CONTADOR":           snmp.get("CONTADOR", "N/A"),
            "TONER_NEGRO":        snmp.get("TONER_NEGRO", "N/A"),
            "TONER_CIAN":         snmp.get("TONER_CIAN", "N/A"),
            "TONER_MAGENTA":      snmp.get("TONER_MAGENTA", "N/A"),
            "TONER_AMARILLO":     snmp.get("TONER_AMARILLO", "N/A"),
            "FOTO_NEGRO":         snmp.get("FOTO_NEGRO", "N/A"),
            "FOTO_CIAN":          snmp.get("FOTO_CIAN", "N/A"),
            "FOTO_MAGENTA":       snmp.get("FOTO_MAGENTA", "N/A"),
            "FOTO_AMARILLO":      snmp.get("FOTO_AMARILLO", "N/A"),
            "REVELADOR_NEGRO":    snmp.get("REVELADOR_NEGRO", "N/A"),
            "KIT_MANTENIMIENTO":  snmp.get("KIT_MANTENIMIENTO", "N/A"),
            "KIT_FUSOR":          snmp.get("KIT_FUSOR", "N/A"),
            "CONTENEDOR_DESECHO": snmp.get("CONTENEDOR_DESECHO", "N/A"),
        })

    online  = sum(1 for f in filas if f["ESTADO"] == "Online")
    offline = sum(1 for f in filas if f["ESTADO"] == "Offline")
    error   = len(filas) - online - offline
    log.info(f"Resultados — Online: {online} | Offline: {offline} | Error: {error}")

    # Enviar a la API
    log.info(f"Enviando datos a {API_URL} ...")
    try:
        enviar("estado_actual", filas)
        enviar("historial", filas)
    except requests.exceptions.ConnectionError:
        log.error("No se pudo conectar con la API. Verifica IP y puerto en agent.env.")
    except requests.exceptions.HTTPError as e:
        log.error(f"Error HTTP de la API: {e}")
    except Exception as e:
        log.error(f"Error inesperado al enviar: {e}")

    fin = time.time()
    log.info(f"=== Ciclo completado en {round(fin - inicio, 1)}s ===\n")

if __name__ == "__main__":
    main()
