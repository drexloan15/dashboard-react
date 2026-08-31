"""
Agente PR_STATS — Firebird -> api_server (PostgreSQL)
Extrae trabajos de impresion desde la tabla PR_STATS de Firebird
y los envia al api_server en el Servidor B.

Compilar a .exe:
    pip install -r requirements-prstats.txt pyinstaller
    pyinstaller --onefile pr_stats_agent.py

Colocar junto al .exe:
    - agent.env          (credenciales — NO subir a git)
    - last_id.txt        (se crea automatico en la primera ejecucion)
    - pr_stats_agent.log (se crea automatico)
"""

import os
import sys
import logging
import traceback
from datetime import datetime
from pathlib import Path

# api_url solo usa la stdlib al importarse (requests se carga perezosamente),
# asi que es seguro tenerlo aca arriba pese al import tardio de requests.
from api_url import resolve_api_url, ApiUrlError

# ─────────────────────────────────────────────
# BASE_DIR: funciona como .py y como .exe
# ─────────────────────────────────────────────
if getattr(sys, "frozen", False):
    BASE_DIR = Path(sys.executable).parent
else:
    BASE_DIR = Path(__file__).parent

LOG_FILE     = BASE_DIR / "pr_stats_agent.log"
LAST_ID_FILE = BASE_DIR / "pr_stats_last_id.txt"

# Log temprano — captura errores de importacion antes de que falle
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger(__name__)

# ─────────────────────────────────────────────
# CARGAR VARIABLES DESDE agent.env (sin dependencias externas)
# ─────────────────────────────────────────────
def _load_env(filename: str = "agent.env") -> None:
    env_path = BASE_DIR / filename
    if not env_path.exists():
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
                os.environ.setdefault(key, val)

_load_env()

try:
    import requests
    from firebird.driver import connect as fb_connect, driver_config
except Exception as _e:
    log.error(f"Error al importar dependencias: {_e}")
    log.error(traceback.format_exc())
    sys.exit(1)

# ─────────────────────────────────────────────
# CONFIG — todos los valores sensibles desde entorno
# ─────────────────────────────────────────────
FIREBIRD_HOST     = os.environ.get("FIREBIRD_HOST",    "localhost")
FIREBIRD_DB       = os.environ.get("FIREBIRD_DB",      "")
FIREBIRD_USER     = os.environ.get("FIREBIRD_USER",    "SYSDBA")
FIREBIRD_PASSWORD = os.environ.get("FIREBIRD_PASSWORD", "")
FIREBIRD_CHARSET  = os.environ.get("FIREBIRD_CHARSET",  "UTF8")
FIREBIRD_LIB      = os.environ.get("FIREBIRD_LIB",     "")

# API_URL apunta al túnel cloudflared que expone api_server.py en Red B.
# Se resuelve en cada ejecución (ver api_url.py): con API_URL_FILE la lee de
# un archivo compartido o una URL, así el cambio de túnel se hace en un solo
# sitio y no hay que tocar cada máquina.
API_KEY     = os.environ.get("AGENT_API_KEY",  "")
try:
    API_URL = resolve_api_url(BASE_DIR, log)
except ApiUrlError as _e:
    log.error(str(_e))
    sys.exit(1)
API_TIMEOUT = int(os.environ.get("API_TIMEOUT", "120"))
BATCH_SIZE  = int(os.environ.get("BATCH_SIZE",  "500"))

FECHA_INICIO = os.environ.get("FECHA_INICIO", "2026-04-23")

# Validar variables obligatorias
_missing = [v for v, k in [("FIREBIRD_DB", FIREBIRD_DB), ("FIREBIRD_PASSWORD", FIREBIRD_PASSWORD),
                             ("AGENT_API_KEY", API_KEY), ("FIREBIRD_LIB", FIREBIRD_LIB)]
            if not k]
if _missing:
    log.error(f"Variables no configuradas en agent.env: {', '.join(m for m, _ in _missing)}")
    sys.exit(1)

try:
    driver_config.fb_client_library.value = FIREBIRD_LIB
except Exception as _e:
    log.error(f"Error al configurar fbclient.dll: {_e}")
    sys.exit(1)

# ─────────────────────────────────────────────
# ULTIMO ID SINCRONIZADO
# ─────────────────────────────────────────────
def leer_last_id() -> int:
    if LAST_ID_FILE.exists():
        try:
            return int(LAST_ID_FILE.read_text().strip())
        except ValueError:
            pass
    return 0

def guardar_last_id(last_id: int):
    LAST_ID_FILE.write_text(str(last_id))

# ─────────────────────────────────────────────
# QUERY FIREBIRD
# ─────────────────────────────────────────────
COLUMNAS = [
    "ID", "SITE", "SUBMITIP", "USERID", "PRINTJOBNAME",
    "SUBMITDATE", "FINALDATE", "FINALACTION", "FINALSITE",
    "NUMPAGES", "RELEASEIP", "RELEASEUSERID", "RELEASEMETHOD",
    "PRINTJOBCOLOR", "PRINTJOBDUPLEX", "PRINTJOBPAPERSIZE",
    "RELEASEMODEL", "RELEASEMODELTYPE", "RELEASEHOSTNAME",
    "DESTINATION", "PROFILE", "CUSTOM1", "CUSTOM2", "CUSTOM3",
    "SERIALNUMBER", "JOBFILESIZE", "DISPLAYJOBFILESIZE",
    "SUBMITDATEUTC", "FINALDATEUTC",
]

def extraer_filas(last_id: int) -> list[dict]:
    cols = ", ".join(f"a.{c}" for c in COLUMNAS)

    if last_id == 0:
        sql = f"""
            SELECT {cols}
            FROM PR_STATS a
            WHERE a.SUBMITDATE >= CAST('{FECHA_INICIO} 00:00:00' AS TIMESTAMP)
            ORDER BY a.ID
        """
    else:
        sql = f"""
            SELECT {cols}
            FROM PR_STATS a
            WHERE a.ID > {last_id}
            ORDER BY a.ID
        """

    log.info(f"Conectando a Firebird (local): {FIREBIRD_DB}")
    con = fb_connect(
        database=FIREBIRD_DB,
        user=FIREBIRD_USER,
        password=FIREBIRD_PASSWORD,
        charset=FIREBIRD_CHARSET,
    )

    try:
        cur = con.cursor()
        cur.execute(sql)
        rows = cur.fetchall()
        log.info(f"Filas obtenidas de Firebird: {len(rows)}")

        result = []
        for row in rows:
            fila = {}
            for i, col in enumerate(COLUMNAS):
                val = row[i]
                if isinstance(val, datetime):
                    fila[col] = val.strftime("%Y-%m-%d %H:%M:%S")
                elif val is None:
                    fila[col] = None
                else:
                    fila[col] = str(val)
            result.append(fila)

        return result
    finally:
        con.close()

# ─────────────────────────────────────────────
# ENVIAR AL API SERVER
# ─────────────────────────────────────────────
def enviar_batch(filas: list[dict]) -> bool:
    url = f"{API_URL}/pr_stats"
    try:
        resp = requests.post(
            url,
            json={"filas": filas},
            headers={"x-api-key": API_KEY},
            timeout=API_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        log.info(f"Batch enviado: {data.get('filas', '?')} filas aceptadas.")
        return True
    except requests.exceptions.ConnectionError:
        log.error("No se pudo conectar con el api_server. Verifica API_URL en agent.env.")
        return False
    except requests.exceptions.HTTPError as e:
        log.error(f"Error HTTP: {e}")
        return False
    except Exception as e:
        log.error(f"Error inesperado al enviar: {e}")
        return False

# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def main():
    inicio = datetime.now()
    log.info(f"=== Inicio ciclo {inicio.strftime('%Y-%m-%d %H:%M:%S')} ===")

    last_id = leer_last_id()
    log.info(f"Ultimo ID sincronizado: {last_id}")

    try:
        filas = extraer_filas(last_id)
    except Exception as e:
        log.error(f"Error al consultar Firebird: {e}")
        return

    if not filas:
        log.info("Sin filas nuevas. Nada que enviar.")
        return

    total_ok      = 0
    nuevo_last_id = last_id

    for i in range(0, len(filas), BATCH_SIZE):
        batch = filas[i : i + BATCH_SIZE]
        if enviar_batch(batch):
            total_ok += len(batch)
            ids = [int(f["ID"]) for f in batch if f.get("ID")]
            if ids:
                nuevo_last_id = max(nuevo_last_id, max(ids))
        else:
            log.error(f"Batch {i//BATCH_SIZE + 1} fallo. Deteniendo para reintentar.")
            break

    if total_ok > 0:
        guardar_last_id(nuevo_last_id)
        log.info(f"Guardado last_id={nuevo_last_id}")

    fin = datetime.now()
    log.info(f"=== Ciclo completado: {total_ok}/{len(filas)} filas en "
             f"{round((fin - inicio).total_seconds(), 1)}s ===\n")

if __name__ == "__main__":
    main()
