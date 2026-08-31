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

import gzip
import json
import os
import sys
import time
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
# (conectar, leer) por separado: si el enlace no deja abrir la conexion,
# conviene fallar rapido y reintentar en vez de esperar el timeout completo.
CONNECT_TIMEOUT = int(os.environ.get("CONNECT_TIMEOUT", "15"))
# Lotes grandes a proposito: comprimido, un lote de 2000 filas son ~130 KB,
# que sobre el enlace de Red A se transfieren en menos de 2 s. Lo caro no son
# los bytes sino el viaje de ida y vuelta, asi que conviene hacer pocos
# viajes grandes en vez de muchos pequenos: 485.000 filas pasan de ~970
# peticiones a ~240.
BATCH_SIZE  = int(os.environ.get("BATCH_SIZE",  "2000"))
REINTENTOS  = int(os.environ.get("REINTENTOS",  "4"))
ESPERA_BASE = int(os.environ.get("ESPERA_BASE", "5"))   # segundos, se duplica

FECHA_INICIO = os.environ.get("FECHA_INICIO", "2026-04-23")

# Validar variables obligatorias
_missing = [v for v, k in [("FIREBIRD_DB", FIREBIRD_DB), ("FIREBIRD_PASSWORD", FIREBIRD_PASSWORD),
                             ("AGENT_API_KEY", API_KEY), ("FIREBIRD_LIB", FIREBIRD_LIB)]
            if not k]
if _missing:
    # _missing ya es la lista de NOMBRES; desempaquetarlos como pares hacia
    # que este propio log.error reventara con ValueError y el agente muriera
    # sin decir que faltaba.
    log.error(f"Variables no configuradas en agent.env: {', '.join(_missing)}")
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

def extraer_lotes(last_id: int):
    """Genera lotes de BATCH_SIZE filas ya convertidas a dict, leyendo de
    Firebird a medida que se necesitan en vez de cargarlo todo."""
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

        # fetchmany y no fetchall: la primera sincronizacion trae ~485k filas y
        # materializarlas todas eran mas de 1 GB de dicts. El servidor se ponia
        # a paginar a disco y un lote de 500 filas tardaba 53 s en enviarse,
        # hasta que la conexion se caia. Asi la memoria queda acotada al lote.
        while True:
            rows = cur.fetchmany(BATCH_SIZE)
            if not rows:
                break
            lote = []
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
                lote.append(fila)
            yield lote
    finally:
        con.close()

# ─────────────────────────────────────────────
# ENVIAR AL API SERVER
# ─────────────────────────────────────────────
# Una sola sesion para todo el ciclo: mantiene viva la conexion TCP/TLS
# entre lotes. Sin esto, cada lote rehacia el handshake completo contra
# Cloudflare -- medido 2,9x mas lento desde la LAN, y desde Red A era peor:
# los ConnectTimeout del log salian justo de ahi.
_sesion = requests.Session()


def enviar_batch(filas: list[dict]) -> bool:
    """Envia un lote comprimido, con reintentos.

    Comprimido porque Red A sube por un enlace lento: el JSON de 500 filas
    pesa ~340 KB y en gzip queda en ~32 KB. El api_server lo desenvuelve.

    Con reintentos porque una sincronizacion completa son ~970 peticiones:
    abandonar el ciclo al primer tropiezo de red significaba no terminar
    nunca. Se reintenta con espera creciente antes de darse por vencido.
    """
    url = f"{API_URL}/pr_stats"
    cuerpo = gzip.compress(json.dumps({"filas": filas}).encode("utf-8"), 6)

    for intento in range(1, REINTENTOS + 1):
        try:
            resp = _sesion.post(
                url,
                data=cuerpo,
                headers={
                    "x-api-key": API_KEY,
                    "Content-Type": "application/json",
                    "Content-Encoding": "gzip",
                },
                timeout=(CONNECT_TIMEOUT, API_TIMEOUT),
            )
            resp.raise_for_status()
            return True
        except requests.exceptions.HTTPError as e:
            # 4xx es culpa del payload: reintentar no lo va a arreglar.
            codigo = e.response.status_code if e.response is not None else 0
            if 400 <= codigo < 500:
                detalle = e.response.text[:300] if e.response is not None else ""
                log.error(f"El servidor rechazo el lote (HTTP {codigo}): {detalle}")
                return False
            motivo = f"HTTP {codigo}"
        except requests.exceptions.RequestException as e:
            motivo = f"{type(e).__name__}"
        except Exception as e:
            log.error(f"Error inesperado al enviar: {e}")
            return False

        if intento < REINTENTOS:
            espera = ESPERA_BASE * (2 ** (intento - 1))
            log.warning(f"Envio fallido ({motivo}), intento {intento}/{REINTENTOS}. "
                        f"Reintentando en {espera}s...")
            time.sleep(espera)
        else:
            log.error(f"Envio fallido ({motivo}) tras {REINTENTOS} intentos.")
    return False

# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def main():
    inicio = datetime.now()
    log.info(f"=== Inicio ciclo {inicio.strftime('%Y-%m-%d %H:%M:%S')} ===")

    last_id = leer_last_id()
    log.info(f"Ultimo ID sincronizado: {last_id}")

    total_ok      = 0
    total_leidas  = 0
    nuevo_last_id = last_id
    n_lote        = 0
    corte         = False

    try:
        for batch in extraer_lotes(last_id):
            n_lote += 1
            total_leidas += len(batch)
            if enviar_batch(batch):
                total_ok += len(batch)
                ids = [int(f["ID"]) for f in batch if f.get("ID")]
                if ids:
                    nuevo_last_id = max(nuevo_last_id, max(ids))
                # El last_id se guarda en cada lote y no al final: si el ciclo
                # se corta a mitad de una sincronizacion larga, la siguiente
                # corrida retoma donde quedo en vez de empezar de cero.
                guardar_last_id(nuevo_last_id)
                # Cada lote, no cada 20: en la primera sincronizacion son
                # ~970 peticiones sobre un enlace lento, y sin senal de vida
                # frecuente no hay forma de distinguir "avanzando despacio"
                # de "colgado".
                ritmo = (datetime.now() - inicio).total_seconds()
                vel = total_ok / ritmo if ritmo > 0 else 0
                log.info(f"Lote {n_lote}: {total_ok} filas enviadas "
                         f"({vel:.0f} filas/s, ultimo ID {nuevo_last_id})")
            else:
                log.error(f"Batch {n_lote} fallo. Deteniendo para reintentar "
                          f"en la proxima corrida desde el ID {nuevo_last_id}.")
                corte = True
                break
    except Exception as e:
        log.error(f"Error al consultar Firebird: {e}")
        corte = True

    if total_leidas == 0 and not corte:
        log.info("Sin filas nuevas. Nada que enviar.")

    fin = datetime.now()
    log.info(f"=== Ciclo completado: {total_ok}/{total_leidas} filas en "
             f"{round((fin - inicio).total_seconds(), 1)}s ===")

if __name__ == "__main__":
    main()
