"""
Backend FastAPI - Dashboard Lexmark
Lee desde PostgreSQL. Los datos son escritos por api_server.py
que recibe del agente_lexmark via REST. Sin dependencia de Google Sheets.
"""
import logging
import os
import threading
import time
import smtplib
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path

os.environ.setdefault("LANG",             "C")
os.environ.setdefault("LC_ALL",           "C")
os.environ.setdefault("PGCLIENTENCODING", "UTF8")

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env", encoding="latin-1")
except ImportError:
    pass

import psycopg2
import psycopg2.extras
import psycopg2.pool
from datetime import date, datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel

# ── CONFIG ───────────────────────────────────────────────────────────────────
CACHE_TTL    = 60
DATABASE_URL = os.getenv("DATABASE_URL", "")
ADMIN_PIN    = os.getenv("ADMIN_PIN", "")   # sin fallback: vacío → login siempre falla

# CORS: lista de orígenes LAN autorizados separados por coma.
# Ejemplo en .env:  ALLOWED_ORIGINS=http://192.168.1.50:3000,http://localhost:3000
_raw_origins  = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:3001")
ALLOWED_ORIGINS = [o.strip() for o in _raw_origins.split(",") if o.strip()]

# Rate-limit PIN: N intentos por ventana de T segundos por IP
PIN_MAX_ATTEMPTS = int(os.getenv("PIN_MAX_ATTEMPTS", "5"))
PIN_WINDOW_S     = int(os.getenv("PIN_WINDOW_S",     "30"))

# ── EMAIL ────────────────────────────────────────────────────────────────────
EMAIL_FROM      = os.getenv("EMAIL_FROM", "")
EMAIL_PASS      = os.getenv("EMAIL_PASS", "")
EMAIL_TO        = os.getenv("EMAIL_TO", "helpdesk@comutelperu.com")
SMTP_HOST       = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT       = int(os.getenv("SMTP_PORT", "587"))
ALERT_THRESHOLD = 25

SUMINISTROS_LABELS = {
    "TONER_NEGRO": "Toner Negro",       "TONER_CIAN": "Toner Cian",
    "TONER_MAGENTA": "Toner Magenta",   "TONER_AMARILLO": "Toner Amarillo",
    "FOTO_NEGRO": "Fotoconductor Negro","FOTO_CIAN": "Fotoconductor Cian",
    "FOTO_MAGENTA": "Fotoconductor Magenta","FOTO_AMARILLO": "Fotoconductor Amarillo",
    "REVELADOR_NEGRO": "Revelador Negro","KIT_MANTENIMIENTO": "Kit Mantenimiento",
    "KIT_FUSOR": "Kit Fusor",           "CONTENEDOR_DESECHO": "Contenedor Desecho",
}
SUPPLY_COLS = list(SUMINISTROS_LABELS.keys())

# ── AUDIT LOG ────────────────────────────────────────────────────────────────
_audit = logging.getLogger("audit")
_audit_handler = logging.FileHandler(Path(__file__).parent / "audit.log", encoding="utf-8")
_audit_handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
_audit.addHandler(_audit_handler)
_audit.setLevel(logging.INFO)
_audit.propagate = False   # no contamina el log principal

# ── RATE LIMITER (en memoria, sliding window por IP) ─────────────────────────
_rl_lock  = threading.Lock()
_rl_state: dict[str, list[float]] = defaultdict(list)

def _rate_limit_ok(key: str, max_calls: int, window_s: int) -> bool:
    now = time.time()
    with _rl_lock:
        recent = [t for t in _rl_state[key] if now - t < window_s]
        if len(recent) >= max_calls:
            _rl_state[key] = recent
            return False
        recent.append(now)
        _rl_state[key] = recent
    return True

# ── APP ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="Lexmark Monitor API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
    allow_credentials=False,
)

# ── ESTADO GLOBAL ────────────────────────────────────────────────────────────
_cache:          dict                                        = {}
_pr_cache:       dict                                        = {}
_refresh_lock    = threading.Lock()
_db_pool:        psycopg2.pool.ThreadedConnectionPool | None = None
_db_last_error:  float                                       = 0.0
DB_ERROR_BACKOFF = 30
DB_INIT_RETRIES  = int(os.getenv("DB_INIT_RETRIES", "60"))   # 60 x 5 s = 5 min
DB_INIT_DELAY    = int(os.getenv("DB_INIT_DELAY",   "5"))

# ── DB: POOL ─────────────────────────────────────────────────────────────────
def _get_pool() -> psycopg2.pool.ThreadedConnectionPool | None:
    global _db_pool, _db_last_error
    if _db_pool is not None:
        return _db_pool
    if not DATABASE_URL:
        return None
    if time.time() - _db_last_error < DB_ERROR_BACKOFF:
        return None
    try:
        from urllib.parse import urlparse
        u = urlparse(DATABASE_URL)
        _db_pool = psycopg2.pool.ThreadedConnectionPool(
            1, 5,
            host=u.hostname, port=u.port or 5432,
            dbname=u.path.lstrip("/"),
            user=u.username, password=u.password,
            connect_timeout=5,
            keepalives=1, keepalives_idle=30,
            keepalives_interval=10, keepalives_count=3,
        )
        return _db_pool
    except Exception as e:
        _db_last_error = time.time()
        print(f"[db] sin conexion: {e}")
        return None

def _reset_pool():
    global _db_pool
    try:
        if _db_pool:
            _db_pool.closeall()
    except Exception:
        pass
    _db_pool = None

@contextmanager
def get_db():
    pool = _get_pool()
    if pool is None:
        raise RuntimeError("PostgreSQL no disponible")
    conn = pool.getconn()
    try:
        if conn.closed or conn.status != psycopg2.extensions.STATUS_READY:
            raise psycopg2.OperationalError("conexión no disponible")
        conn.reset()
    except psycopg2.OperationalError:
        try: pool.putconn(conn, close=True)
        except Exception: pass
        _reset_pool()
        raise RuntimeError("Conexión a PostgreSQL rota, reintentando...")
    broken = False
    try:
        yield conn
        conn.commit()
    except psycopg2.OperationalError:
        broken = True
        _reset_pool()
        raise
    except Exception:
        try:
            conn.rollback()
        except psycopg2.OperationalError:
            broken = True
            _reset_pool()
        raise
    finally:
        if not broken:
            try:
                pool.putconn(conn)
            except Exception:
                _reset_pool()

# ── DB: CREAR / MIGRAR TABLAS ────────────────────────────────────────────────
def _pk_columns(cur, tabla: str) -> list[str]:
    cur.execute("""
        SELECT a.attname
          FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = %s::regclass AND i.indisprimary
         ORDER BY a.attnum
    """, (tabla,))
    return [r[0] for r in cur.fetchall()]

def _migrar_clave_a_serie(cur) -> None:
    """Pasa estado_actual e historial de estar identificados por ip a estarlo
    por serie. No hace nada si ya estan migrados."""
    if _pk_columns(cur, "estado_actual") != ["ip"]:
        return

    cur.execute("SELECT count(*) FROM estado_actual")
    filas_estado = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM historial")
    filas_hist = cur.fetchone()[0]

    if filas_estado or filas_hist:
        raise RuntimeError(
            f"estado_actual todavia usa la ip como clave y tiene datos "
            f"({filas_estado} filas en estado_actual, {filas_hist} en historial). "
            f"La migracion automatica solo corre con las tablas vacias porque "
            f"hay que deduplicar las filas fantasma (misma impresora bajo dos "
            f"ip) y decidir que hacer con las series vacias o repetidas. "
            f"Migrar a mano antes de arrancar."
        )

    print("[init] migrando la clave de estado_actual/historial: ip -> serie", flush=True)
    cur.execute("ALTER TABLE estado_actual DROP CONSTRAINT estado_actual_pkey")
    cur.execute("UPDATE estado_actual SET serie = '' WHERE serie IS NULL")
    cur.execute("ALTER TABLE estado_actual ALTER COLUMN serie SET NOT NULL")
    cur.execute("ALTER TABLE estado_actual ALTER COLUMN ip    SET NOT NULL")
    cur.execute("ALTER TABLE estado_actual ADD PRIMARY KEY (serie)")

    # historial: la unicidad del snapshot horario tambien pasa a la serie
    cur.execute("""
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'historial'::regclass AND contype = 'u'
    """)
    for (conname,) in cur.fetchall():
        cur.execute(f"ALTER TABLE historial DROP CONSTRAINT {conname}")
    cur.execute("ALTER TABLE historial ADD CONSTRAINT historial_serie_fecha_hora_key "
                "UNIQUE (serie, fecha, hora)")

def init_db():
    supply_ddl = "\n".join(f"    {c.lower()} REAL," for c in SUPPLY_COLS)
    with get_db() as conn:
        cur = conn.cursor()

        # La identidad de una impresora es su SERIE, no su IP: la IP se muda
        # (cambio de red, DHCP) y la serie no. Cuando la clave era la IP, mover
        # una impresora creaba una fila nueva y dejaba la vieja como fantasma
        # "desactivada" para siempre. La serie es el DNI del equipo.
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS estado_actual (
                serie       TEXT PRIMARY KEY,
                ip          TEXT NOT NULL,
                sede        TEXT, area       TEXT, zona TEXT,
                estado      TEXT,
                modelo_inv  TEXT, tipo       TEXT,
                conexion    TEXT, modelo_snmp TEXT,
                fecha       TEXT, hora       SMALLINT,
                contador    REAL,
                {supply_ddl}
                updated_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        for col, coltype in [("tipo","TEXT"),("serie","TEXT"),("conexion","TEXT"),
                              ("modelo_snmp","TEXT"),("fecha","TEXT"),("hora","SMALLINT"),
                              ("serie_snmp","TEXT")]:
            cur.execute(f"ALTER TABLE estado_actual ADD COLUMN IF NOT EXISTS {col} {coltype}")

        # ── Migracion de identidad: ip -> serie ───────────────────────────
        # CREATE TABLE IF NOT EXISTS no toca una tabla que ya existe, asi que
        # las instalaciones anteriores (clave = ip) hay que convertirlas aca.
        # Es idempotente: si ya esta migrada, no hace nada.
        #
        # Solo se hace en automatico con la tabla vacia. Con datos haria falta
        # deduplicar filas fantasma y decidir que hacer con series repetidas o
        # en blanco, y eso no se resuelve a ciegas dentro de un arranque.
        _migrar_clave_a_serie(cur)

        # serie_snmp (numero de serie real, leido por SNMP) identifica la
        # impresora de forma mas robusta que la IP -- indice unico parcial
        # para permitir multiples impresoras sin serial leido (NULL/vacio)
        # sin que colisionen entre si.
        cur.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS estado_actual_serie_snmp_uk
                ON estado_actual (serie_snmp)
                WHERE serie_snmp IS NOT NULL AND serie_snmp <> ''
        """)

        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS historial (
                id          SERIAL PRIMARY KEY,
                ip          TEXT        NOT NULL,
                fecha       DATE        NOT NULL,
                hora        SMALLINT    NOT NULL,
                timestamp   TIMESTAMPTZ NOT NULL,
                sede        TEXT, zona  TEXT, area      TEXT,
                modelo_inv  TEXT, tipo  TEXT, serie     TEXT,
                conexion    TEXT, modelo_snmp TEXT,
                estado      TEXT,
                contador    REAL,
                {supply_ddl}
                UNIQUE (serie, fecha, hora)
            )
        """)
        for col, coltype in [("zona","TEXT"),("area","TEXT"),("modelo_inv","TEXT"),
                              ("tipo","TEXT"),("serie","TEXT"),("conexion","TEXT"),("modelo_snmp","TEXT"),
                              ("serie_snmp","TEXT")]:
            cur.execute(f"ALTER TABLE historial ADD COLUMN IF NOT EXISTS {col} {coltype}")

        cur.execute("CREATE INDEX IF NOT EXISTS estado_ip_idx   ON estado_actual(ip)")
        cur.execute("CREATE INDEX IF NOT EXISTS hist_ip_idx     ON historial(ip)")
        cur.execute("CREATE INDEX IF NOT EXISTS hist_serie_idx  ON historial(serie)")
        cur.execute("CREATE INDEX IF NOT EXISTS hist_ts_idx     ON historial(timestamp DESC)")
        cur.execute("CREATE INDEX IF NOT EXISTS hist_fecha_idx  ON historial(fecha)")
        cur.execute("CREATE INDEX IF NOT EXISTS hist_sede_idx   ON historial(sede)")
        cur.execute("CREATE INDEX IF NOT EXISTS hist_estado_idx ON historial(estado)")
        cur.execute("CREATE INDEX IF NOT EXISTS hist_serie_snmp_idx ON historial(serie_snmp)")

        cur.execute("""
            CREATE TABLE IF NOT EXISTS alerta_estado (
                alert_key  TEXT        PRIMARY KEY,
                estado     TEXT        NOT NULL,
                updated_by TEXT,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS solicitudes_suministros (
                id             SERIAL       PRIMARY KEY,
                printer_ip     TEXT         NOT NULL,
                sede           TEXT,
                area           TEXT,
                modelo         TEXT,
                suministros    TEXT[]       NOT NULL,
                to_email       TEXT         NOT NULL,
                notas          TEXT         DEFAULT '',
                reportado_por  TEXT         NOT NULL,
                created_at     TIMESTAMPTZ  DEFAULT NOW()
            )
        """)
        # ── Inventario editable desde el dashboard ────────────────────
        # Fuente de verdad de QUE impresoras se monitorean. El agente lo
        # descarga en cada ciclo y escribe su inventario2026.csv local, en
        # vez de que alguien edite el CSV a mano en el servidor de Red A.
        # La clave es la serie, igual que en estado_actual: la IP se muda.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS inventario (
                serie      TEXT PRIMARY KEY,
                ip         TEXT NOT NULL,
                sede       TEXT NOT NULL DEFAULT '',
                area       TEXT NOT NULL DEFAULT '',
                zona       TEXT NOT NULL DEFAULT '',
                modelo     TEXT NOT NULL DEFAULT '',
                tipo       TEXT NOT NULL DEFAULT '',
                conexion   TEXT NOT NULL DEFAULT '',
                activo     BOOLEAN NOT NULL DEFAULT TRUE,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_by TEXT NOT NULL DEFAULT ''
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS inv_ip_idx   ON inventario(ip)")
        cur.execute("CREATE INDEX IF NOT EXISTS inv_sede_idx ON inventario(sede)")

        # Siembra inicial: estado_actual ya tiene las impresoras que el agente
        # viene reportando desde su CSV, con los mismos campos. Solo corre si
        # inventario esta vacio, asi que no pisa ediciones posteriores.
        cur.execute("SELECT count(*) FROM inventario")
        if cur.fetchone()[0] == 0:
            cur.execute("""
                INSERT INTO inventario (serie, ip, sede, area, zona, modelo,
                                        tipo, conexion, updated_by)
                SELECT serie, ip,
                       COALESCE(sede,''),  COALESCE(area,''),
                       COALESCE(zona,''),  COALESCE(modelo_inv,''),
                       COALESCE(tipo,''),  COALESCE(conexion,''),
                       'siembra-inicial'
                  FROM estado_actual
                 WHERE serie <> ''
                ON CONFLICT (serie) DO NOTHING
            """)
            if cur.rowcount:
                print(f"[db] inventario sembrado con {cur.rowcount} impresoras "
                      f"desde estado_actual")

    print("[db] tablas listas")

# ── PR_STATS: CACHE ───────────────────────────────────────────────────────────
def _load_pr_cache():
    global _pr_cache
    try:
        with get_db() as conn:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute("SELECT to_regclass('public.pr_stats')")
            row = cur.fetchone()
            if row is None or row["to_regclass"] is None:
                _pr_cache = {"exists": False}
                return

            cur.execute("""
                SELECT COUNT(*) AS jobs,
                       COALESCE(SUM(numpages),0) AS pages,
                       COUNT(DISTINCT userid) AS users
                FROM pr_stats WHERE numpages > 0 AND UPPER(finalaction) IN ('P','C')
            """)
            totales = dict(cur.fetchone())

            cur.execute("""
                SELECT userid, COUNT(*) AS jobs, COALESCE(SUM(numpages),0) AS pages
                FROM pr_stats WHERE numpages > 0 AND UPPER(finalaction) IN ('P','C')
                  AND userid IS NOT NULL
                GROUP BY userid ORDER BY pages DESC LIMIT 30
            """)
            top_usuarios = [dict(r) for r in cur.fetchall()]

            cur.execute("""
                SELECT DATE(submitdate) AS fecha,
                       COALESCE(SUM(numpages),0) AS pages, COUNT(*) AS jobs
                FROM pr_stats
                WHERE submitdate >= '2026-04-23' AND numpages > 0 AND UPPER(finalaction) IN ('P','C')
                GROUP BY DATE(submitdate) ORDER BY fecha
            """)
            por_dia = [{"fecha": str(r["fecha"]), "pages": int(r["pages"]), "jobs": int(r["jobs"])}
                       for r in cur.fetchall()]

            cur.execute("""
                SELECT site, COALESCE(SUM(numpages),0) AS pages,
                       COUNT(*) AS jobs, COUNT(DISTINCT userid) AS users
                FROM pr_stats WHERE numpages > 0 AND UPPER(finalaction) IN ('P','C')
                  AND site IS NOT NULL
                GROUP BY site ORDER BY pages DESC
            """)
            por_sede = [dict(r) for r in cur.fetchall()]

            cur.execute("""
                SELECT releasemodel, COALESCE(SUM(numpages),0) AS pages, COUNT(*) AS jobs
                FROM pr_stats
                WHERE numpages > 0 AND UPPER(finalaction) IN ('P','C')
                  AND releasemodel IS NOT NULL
                GROUP BY releasemodel ORDER BY pages DESC LIMIT 20
            """)
            por_modelo = [dict(r) for r in cur.fetchall()]

        _pr_cache = {
            "exists":       True,
            "totales":      {k: int(v) for k, v in totales.items()},
            "top_usuarios": [{k: (int(v) if k != "userid" else v) for k, v in r.items()} for r in top_usuarios],
            "por_dia":      por_dia,
            "por_sede":     [{k: (int(v) if k not in ("site",) else v) for k, v in r.items()} for r in por_sede],
            "por_modelo":   [{k: (int(v) if k != "releasemodel" else v) for k, v in r.items()} for r in por_modelo],
            "ts":           datetime.now().isoformat(),
        }
        print(f"[pr_cache] {totales['jobs']} jobs · {totales['users']} usuarios")
    except Exception as e:
        print(f"[pr_cache] error: {e}")
        import traceback; traceback.print_exc()

# ── DB: QUERIES ───────────────────────────────────────────────────────────────
def _query_estado(conn) -> list[dict]:
    sc = ", ".join(f'{c.lower()} AS "{c}"' for c in SUPPLY_COLS)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(f"""
        SELECT serie AS "SERIE", ip AS "IP", sede AS "SEDE", area AS "AREA",
               zona AS "ZONA", estado AS "ESTADO", modelo_inv AS "MODELO_INV",
               contador AS "CONTADOR",
               {sc}
        FROM estado_actual
    """)
    return [dict(r) for r in cur.fetchall()]

def _query_historial_recent(conn, days: int = 30) -> list[dict]:
    sc = ", ".join(f'{c.lower()} AS "{c}"' for c in SUPPLY_COLS)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(f"""
        SELECT serie AS "SERIE", ip AS "IP", sede AS "SEDE", estado AS "ESTADO",
               contador AS "CONTADOR",
               {sc},
               timestamp::text AS "TIMESTAMP", fecha::text AS "FECHA",
               timestamp::text AS "_ts",        fecha::text AS "_fecha"
        FROM historial
        WHERE timestamp >= NOW() - (%s * INTERVAL '1 day')
        ORDER BY timestamp DESC
    """, (days,))
    return [dict(r) for r in cur.fetchall()]

# ── CACHE (solo estado_actual) ────────────────────────────────────────────────
def _load_cache_from_db():
    global _cache
    try:
        with get_db() as conn:
            estado = _query_estado(conn)
        if estado:
            _cache = {
                "payload": {"estado": estado, "ts": datetime.now().strftime("DB %H:%M:%S")},
                "ts_dt":   datetime.now(),
            }
            print(f"[cache] {datetime.now().strftime('%H:%M:%S')} · {len(estado)} equipos")
    except Exception as e:
        print(f"[cache] error: {e}")
        import traceback; traceback.print_exc()

def _do_refresh():
    if not _refresh_lock.acquire(blocking=False):
        return
    try:
        _load_cache_from_db()
    finally:
        _refresh_lock.release()

def _bg_loop():
    while True:
        time.sleep(CACHE_TTL)
        _do_refresh()

# Arranque — orden importante:
# 1. init_db  : crea tablas si no existen (necesario antes de cualquier query)
# 2. cache    : carga estado_actual en memoria (rápido, ~filas de impresoras)
# 3. pr_cache : 5 queries agregadas sobre pr_stats — se mueve a background
#               para que uvicorn pueda abrir el puerto de inmediato.
#               /pr_stats devuelve {"exists": False} hasta que esté listo.
#
# init_db reintenta: tras un apagado sucio, Postgres hace fsync de todo el
# datadir antes de aceptar conexiones (~45 s observados). En un reboot del host
# Docker ignora depends_on/healthcheck y arranca los contenedores en paralelo,
# asi que el backend debe esperar por su cuenta en vez de morir en bucle.
for _intento in range(1, DB_INIT_RETRIES + 1):
    try:
        init_db()
        break
    except Exception as _e:
        if _intento == DB_INIT_RETRIES:
            raise
        print(f"[init] BD no lista ({_intento}/{DB_INIT_RETRIES}): {_e}", flush=True)
        _db_last_error = 0          # anular el backoff de 30 s durante el arranque
        time.sleep(DB_INIT_DELAY)
_load_cache_from_db()
threading.Thread(target=_load_pr_cache,  daemon=True).start()
threading.Thread(target=_bg_loop,        daemon=True).start()
threading.Thread(target=lambda: [time.sleep(300) or _load_pr_cache() for _ in iter(int, 1)], daemon=True).start()

# ── MODELOS PYDANTIC ──────────────────────────────────────────────────────────
class AlertaStatusBody(BaseModel):
    estado:     str
    updated_by: str = "admin"

class InventarioBody(BaseModel):
    ip:       str
    sede:     str = ""
    area:     str = ""
    zona:     str = ""
    modelo:   str = ""
    tipo:     str = ""
    conexion: str = ""
    activo:   bool = True

class PinBody(BaseModel):
    pin: str

class SolicitudBody(BaseModel):
    printer_ip:    str
    suministros:   list[str]
    to_email:      str
    notas:         str = ""
    reportado_por: str

# ── HELPERS ───────────────────────────────────────────────────────────────────
def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

# ── ENDPOINTS ────────────────────────────────────────────────────────────────

@app.get("/data")
async def get_data():
    """Compatibilidad: devuelve estado sin historial completo."""
    now = datetime.now()
    if _cache and (now - _cache["ts_dt"]).total_seconds() < CACHE_TTL:
        p = _cache["payload"]
        return {"estado": p["estado"], "historial": [], "ts": p["ts"]}
    if _cache:
        threading.Thread(target=_do_refresh, daemon=True).start()
        p = _cache["payload"]
        return {"estado": p["estado"], "historial": [], "ts": p["ts"] + " ↻"}
    _do_refresh()
    if _cache:
        p = _cache["payload"]
        return {"estado": p["estado"], "historial": [], "ts": p["ts"]}
    return {"error": "Sin datos aun", "estado": [], "historial": [], "ts": "—"}

@app.get("/estado")
async def get_estado():
    if not _cache:
        _do_refresh()
    if not _cache:
        return {"estado": [], "ts": "—"}
    return {"estado": _cache["payload"]["estado"], "ts": _cache["payload"]["ts"]}

@app.get("/historial/recent")
async def get_historial_recent(days: int = Query(30, ge=1, le=365)):
    try:
        with get_db() as conn:
            historial = _query_historial_recent(conn, days)
        return {"historial": historial, "ts": datetime.now().strftime("DB %H:%M:%S")}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/historial")
async def get_historial_page(
    page:      int = Query(1,   ge=1),
    page_size: int = Query(50,  ge=1, le=200),
    search:    str = Query(""),
    sede:      str = Query(""),
    area:      str = Query(""),
    ip:        str = Query(""),
    estado:    str = Query(""),
    fecha:     str = Query(""),
):
    sc = ", ".join(f'{c.lower()} AS "{c}"' for c in SUPPLY_COLS)
    where_parts: list[str] = []
    params: list = []

    if sede:
        where_parts.append("sede = %s"); params.append(sede)
    if area:
        where_parts.append("area = %s"); params.append(area)
    if ip:
        where_parts.append("ip = %s"); params.append(ip)
    if estado:
        where_parts.append("LOWER(estado) = LOWER(%s)"); params.append(estado)
    if fecha:
        where_parts.append("fecha::text = %s"); params.append(fecha)
    if search:
        where_parts.append(
            "(ip ILIKE %s OR COALESCE(sede,'') ILIKE %s OR COALESCE(estado,'') ILIKE %s"
            " OR fecha::text ILIKE %s OR COALESCE(contador::text,'') ILIKE %s)"
        )
        s = f"%{search}%"
        params.extend([s, s, s, s, s])

    where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
    offset = (page - 1) * page_size

    try:
        with get_db() as conn:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(f"SELECT COUNT(*) AS total FROM historial {where_sql}", params)
            total = cur.fetchone()["total"]
            cur.execute(f"""
                SELECT serie AS "SERIE", ip AS "IP", sede AS "SEDE",
                       COALESCE(area, '') AS "AREA", estado AS "ESTADO",
                       contador AS "CONTADOR",
                       {sc},
                       timestamp::text AS "TIMESTAMP", fecha::text AS "FECHA",
                       timestamp::text AS "_ts",        fecha::text AS "_fecha"
                FROM historial {where_sql}
                ORDER BY timestamp DESC
                LIMIT %s OFFSET %s
            """, params + [page_size, offset])
            items = [dict(r) for r in cur.fetchall()]

        total_pages = max(1, (total + page_size - 1) // page_size)
        return {"items": items, "total": total, "page": page,
                "page_size": page_size, "total_pages": total_pages}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── AUTH ──────────────────────────────────────────────────────────────────────
@app.post("/auth/pin")
async def verify_pin(body: PinBody, request: Request):
    """
    Valida PIN de administrador contra ADMIN_PIN del entorno.
    Rate-limit: PIN_MAX_ATTEMPTS intentos por PIN_WINDOW_S segundos por IP.
    No revela si el PIN existe o no en mensajes de error.
    """
    if not ADMIN_PIN:
        # ADMIN_PIN no configurado en .env → acceso admin deshabilitado
        raise HTTPException(status_code=503, detail="Acceso admin no configurado.")

    client = _client_ip(request)
    if not _rate_limit_ok(f"pin:{client}", PIN_MAX_ATTEMPTS, PIN_WINDOW_S):
        _audit.warning(f"PIN_RATE_LIMITED ip={client}")
        raise HTTPException(
            status_code=429,
            detail={"message": f"Demasiados intentos. Espera {PIN_WINDOW_S} segundos.", "retry_after": PIN_WINDOW_S}
        )

    ok = body.pin == ADMIN_PIN
    if not ok:
        # Pequeño delay para desalentar enumeración — no bloquea el event loop
        # porque es LAN y los intentos son lentos de todas formas.
        _audit.warning(f"PIN_FAIL ip={client}")
        time.sleep(0.4)
    else:
        _audit.info(f"PIN_OK ip={client}")

    return {"ok": ok}

# ── ALERTAS: CHECKS COMPARTIDOS ───────────────────────────────────────────────
@app.get("/alertas/status")
async def get_alertas_status():
    try:
        with get_db() as conn:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute("SELECT alert_key, estado FROM alerta_estado")
            return {r["alert_key"]: r["estado"] for r in cur.fetchall()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.put("/alertas/status/{alert_key:path}")
async def put_alerta_status(alert_key: str, body: AlertaStatusBody, request: Request):
    if body.estado not in ("listo", "enviado"):
        raise HTTPException(status_code=422, detail="estado debe ser 'listo' o 'enviado'")
    try:
        with get_db() as conn:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO alerta_estado (alert_key, estado, updated_by, updated_at)
                VALUES (%s, %s, %s, NOW())
                ON CONFLICT (alert_key) DO UPDATE SET
                    estado     = EXCLUDED.estado,
                    updated_by = EXCLUDED.updated_by,
                    updated_at = NOW()
            """, (alert_key, body.estado, body.updated_by))
        _audit.info(
            f"ALERT_PUT ip={_client_ip(request)!r} key={alert_key!r} "
            f"estado={body.estado!r} by={body.updated_by!r}"
        )
        return {"ok": True, "alert_key": alert_key, "estado": body.estado}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/alertas/status/{alert_key:path}")
async def delete_alerta_status(alert_key: str, request: Request):
    try:
        with get_db() as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM alerta_estado WHERE alert_key = %s", (alert_key,))
        _audit.info(f"ALERT_DELETE ip={_client_ip(request)!r} key={alert_key!r}")
        return {"ok": True, "alert_key": alert_key}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── SOLICITUDES DE SUMINISTROS ────────────────────────────────────────────────

# ── INVENTARIO ────────────────────────────────────────────────────────────────
# Fuente de verdad de que impresoras se monitorean. El agente lo descarga en
# cada ciclo, asi que un error aca deja de monitorear equipos: por eso las
# mutaciones exigen el PIN CONTRA EL SERVIDOR y no solo contra el frontend,
# a diferencia de /alertas/status.

def _exigir_pin(pin: str | None, request: Request, accion: str) -> None:
    if not ADMIN_PIN:
        raise HTTPException(status_code=503, detail="Acceso admin no configurado.")
    client = _client_ip(request)
    if not _rate_limit_ok(f"inv:{client}", PIN_MAX_ATTEMPTS, PIN_WINDOW_S):
        _audit.warning(f"INV_RATE_LIMITED ip={client}")
        raise HTTPException(status_code=429, detail="Demasiados intentos. Espera un momento.")
    if pin != ADMIN_PIN:
        _audit.warning(f"INV_PIN_FAIL ip={client} accion={accion}")
        time.sleep(0.4)
        raise HTTPException(status_code=403, detail="PIN invalido.")

def _serie_valida(serie: str) -> str:
    serie = (serie or "").strip()
    if not serie:
        raise HTTPException(status_code=422, detail="La serie es obligatoria: identifica la impresora.")
    return serie

@app.get("/inventario")
def get_inventario():
    with get_db() as conn:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT serie, ip, sede, area, zona, modelo, tipo, conexion, activo,
                   updated_at::text AS updated_at, updated_by
              FROM inventario
             ORDER BY sede, area, serie
        """)
        return {"items": [dict(r) for r in cur.fetchall()]}

@app.put("/inventario/{serie}")
def put_inventario(serie: str, body: InventarioBody, request: Request,
                   x_admin_pin: str | None = Header(default=None)):
    _exigir_pin(x_admin_pin, request, f"PUT {serie}")
    serie = _serie_valida(serie)
    if not body.ip.strip():
        raise HTTPException(status_code=422, detail="La IP es obligatoria.")
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO inventario (serie, ip, sede, area, zona, modelo, tipo,
                                    conexion, activo, updated_at, updated_by)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s, NOW(), %s)
            ON CONFLICT (serie) DO UPDATE SET
                ip=EXCLUDED.ip, sede=EXCLUDED.sede, area=EXCLUDED.area,
                zona=EXCLUDED.zona, modelo=EXCLUDED.modelo, tipo=EXCLUDED.tipo,
                conexion=EXCLUDED.conexion, activo=EXCLUDED.activo,
                updated_at=NOW(), updated_by=EXCLUDED.updated_by
        """, (serie, body.ip.strip(), body.sede, body.area, body.zona,
              body.modelo, body.tipo, body.conexion, body.activo, "admin"))
    _audit.info(f"INV_PUT ip={_client_ip(request)!r} serie={serie!r} nueva_ip={body.ip!r}")
    return {"ok": True, "serie": serie}

@app.delete("/inventario/{serie}")
def delete_inventario(serie: str, request: Request,
                      x_admin_pin: str | None = Header(default=None)):
    _exigir_pin(x_admin_pin, request, f"DELETE {serie}")
    serie = _serie_valida(serie)
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM inventario WHERE serie = %s", (serie,))
        borradas = cur.rowcount
    if not borradas:
        raise HTTPException(status_code=404, detail=f"No existe la serie {serie}.")
    _audit.info(f"INV_DELETE ip={_client_ip(request)!r} serie={serie!r}")
    return {"ok": True, "serie": serie}

@app.get("/inventario/export.csv", response_class=PlainTextResponse)
def export_inventario():
    """El mismo CSV que consume el agente, para descargarlo o respaldarlo."""
    import csv, io as _io
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("""SELECT ip, zona, sede, area, modelo, tipo, serie, conexion
                         FROM inventario WHERE activo ORDER BY sede, area, serie""")
        filas = cur.fetchall()
    buf = _io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["IP", "ZONA", "SEDE", "AREA", "MODELO", "TIPO", "SERIE", "CONEXION"])
    w.writerows(filas)
    return PlainTextResponse(buf.getvalue(), media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="inventario2026.csv"'})

@app.get("/config/email")
async def get_email_config():
    """Devuelve el destinatario de correo por defecto configurado en .env."""
    return {"email_to": EMAIL_TO}

@app.get("/solicitudes")
async def get_solicitudes(
    page:      int = Query(1,  ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    try:
        with get_db() as conn:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute("SELECT COUNT(*) AS total FROM solicitudes_suministros")
            total = cur.fetchone()["total"]
            offset = (page - 1) * page_size
            cur.execute("""
                SELECT id, printer_ip, sede, area, modelo, suministros,
                       to_email, notas, reportado_por,
                       created_at::text AS created_at
                FROM solicitudes_suministros
                ORDER BY created_at DESC
                LIMIT %s OFFSET %s
            """, (page_size, offset))
            items = [dict(r) for r in cur.fetchall()]
        total_pages = max(1, (total + page_size - 1) // page_size)
        return {"items": items, "total": total, "page": page,
                "page_size": page_size, "total_pages": total_pages}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/solicitudes/enviar")
async def enviar_solicitud(body: SolicitudBody, request: Request):
    if not EMAIL_FROM or not EMAIL_PASS:
        raise HTTPException(status_code=503, detail="Credenciales de correo no configuradas.")
    if not body.suministros:
        raise HTTPException(status_code=422, detail="Selecciona al menos un suministro.")
    if not body.to_email.strip():
        raise HTTPException(status_code=422, detail="El correo destinatario es requerido.")
    if not body.reportado_por.strip():
        raise HTTPException(status_code=422, detail="El nombre del reportante es requerido.")

    # Buscar impresora en caché para obtener info actualizada
    printer: dict | None = None
    if _cache and "payload" in _cache:
        for p in _cache["payload"].get("estado", []):
            if p.get("IP") == body.printer_ip:
                printer = p
                break

    sede   = printer.get("SEDE", "—")       if printer else "—"
    area   = printer.get("AREA") or "—"     if printer else "—"
    modelo = printer.get("MODELO_INV") or "—" if printer else "—"

    # Guardar en BD
    try:
        with get_db() as conn:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO solicitudes_suministros
                    (printer_ip, sede, area, modelo, suministros, to_email, notas, reportado_por)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
            """, (body.printer_ip, sede, area, modelo, body.suministros,
                  body.to_email, body.notas, body.reportado_por))
            sol_id = cur.fetchone()[0]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Construir filas de suministros para el correo
    supply_rows = ""
    for key in body.suministros:
        label = SUMINISTROS_LABELS.get(key, key)
        nivel = "—"
        if printer:
            raw = printer.get(key)
            if raw is not None and str(raw).strip() not in ("", "N/A", "nan", "None"):
                try:
                    nivel = f"{float(str(raw).replace('%','').strip()):.0f}%"
                except ValueError:
                    pass
        supply_rows += f"""
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee">{label}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;font-family:monospace;font-weight:600">{nivel}</td>
        </tr>"""

    notas_block = ""
    if body.notas.strip():
        notas_block = f"""
        <p style="margin:16px 0 6px;font-size:13px;color:#374151;font-weight:600">Anotaciones:</p>
        <div style="padding:10px 14px;background:#f3f4f6;border-radius:6px;font-size:13px;color:#6b7280;white-space:pre-wrap">{body.notas}</div>"""

    now_str = datetime.now().strftime("%d/%m/%Y %H:%M")
    html = f"""
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
      <div style="background:#1a2235;padding:24px 32px;border-radius:8px 8px 0 0">
        <h2 style="color:#fff;margin:0;font-size:20px">Solicitud de Suministros</h2>
        <p style="color:#8aa0c0;margin:6px 0 0;font-size:13px">{now_str} &middot; Comutel Per&uacute;</p>
      </div>
      <div style="background:#f9fafb;padding:24px 32px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb">
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <tr><td style="color:#6b7280;font-size:12px;padding:4px 0;width:130px">IP</td>
              <td style="font-family:monospace;font-size:13px;color:#111">{body.printer_ip}</td></tr>
          <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Sede</td>
              <td style="font-size:13px;color:#111">{sede}</td></tr>
          <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">&Aacute;rea</td>
              <td style="font-size:13px;color:#111">{area}</td></tr>
          <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Modelo</td>
              <td style="font-size:13px;color:#111">{modelo}</td></tr>
          <tr><td style="color:#6b7280;font-size:12px;padding:4px 0">Reportado por</td>
              <td style="font-size:13px;color:#111;font-weight:700">{body.reportado_por}</td></tr>
        </table>
        <p style="margin:0 0 8px;font-size:13px;color:#374151;font-weight:600">Suministros solicitados:</p>
        <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
          <thead>
            <tr style="background:#1a2235">
              <th style="padding:10px 12px;color:#8aa0c0;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em">SUMINISTRO</th>
              <th style="padding:10px 12px;color:#8aa0c0;text-align:center;font-size:11px;font-weight:600;letter-spacing:.05em">NIVEL ACTUAL</th>
            </tr>
          </thead>
          <tbody>{supply_rows}</tbody>
        </table>
        {notas_block}
        <p style="color:#9ca3af;font-size:11px;margin-top:20px">
          Solicitud #{sol_id} &middot; Generado por Dashboard Lexmark &mdash; Comutel Per&uacute;.
        </p>
      </div>
    </div>"""

    to_list = [a.strip() for a in body.to_email.replace(";", ",").split(",") if a.strip()]
    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"Solicitud de Suministros – {sede} ({body.printer_ip}) – {body.reportado_por}"
    msg["From"]    = EMAIL_FROM
    msg["To"]      = ", ".join(to_list)
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.ehlo(); server.starttls()
            server.login(EMAIL_FROM, EMAIL_PASS)
            server.sendmail(EMAIL_FROM, to_list, msg.as_string())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error al enviar correo: {e}")

    _audit.info(
        f"SOLICITUD_ENVIADA ip={_client_ip(request)!r} id={sol_id} "
        f"printer={body.printer_ip!r} por={body.reportado_por!r} to={body.to_email!r}"
    )
    return {"ok": True, "id": sol_id}

# ── PR_STATS ──────────────────────────────────────────────────────────────────
@app.get("/pr_stats")
async def get_pr_stats():
    if not _pr_cache:
        _load_pr_cache()
    return _pr_cache if _pr_cache else {"exists": False}

@app.get("/pr_stats/usuario/{userid}")
async def get_usuario_jobs(userid: str):
    try:
        with get_db() as conn:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute("""
                SELECT printjobname, numpages,
                       submitdate::text AS submitdate,
                       COALESCE(finalaction, '') AS finalaction,
                       COALESCE(site, '')         AS site,
                       COALESCE(releasemodel, '')  AS releasemodel
                FROM pr_stats WHERE userid = %s AND numpages > 0
                ORDER BY submitdate DESC
            """, (userid,))
            jobs = [dict(r) for r in cur.fetchall()]

            cur.execute("""
                SELECT DATE(submitdate) AS fecha,
                       COALESCE(SUM(numpages), 0) AS pages, COUNT(*) AS jobs
                FROM pr_stats
                WHERE userid = %s AND numpages > 0 AND UPPER(finalaction) IN ('P','C')
                GROUP BY DATE(submitdate) ORDER BY fecha
            """, (userid,))
            por_dia = [{"fecha": str(r["fecha"]), "pages": int(r["pages"]), "jobs": int(r["jobs"])}
                       for r in cur.fetchall()]

            cur.execute("""
                SELECT COALESCE(finalaction, '') AS tipo,
                       COUNT(*) AS jobs, COALESCE(SUM(numpages), 0) AS pages
                FROM pr_stats WHERE userid = %s AND numpages > 0
                GROUP BY finalaction
            """, (userid,))
            por_tipo = [{"tipo": r["tipo"], "jobs": int(r["jobs"]), "pages": int(r["pages"])}
                        for r in cur.fetchall()]

        return {"userid": userid, "jobs": jobs, "por_dia": por_dia, "por_tipo": por_tipo}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── ANALITICA: DESCRIPTIVA Y PREDICTIVA ───────────────────────────────────────
#
# Todo lo de esta seccion sale de pr_stats (trabajos de impresion), no de
# historial (SNMP). El motivo es de datos, no de gusto:
#
#   historial  -> arranco el 2026-08-31. El servidor 192.168.1.191 murio el
#                 2026-08-28 y se llevo el historico entero. Un toner dura
#                 semanas: con unos pocos dias de lecturas no se ha observado
#                 ni un ciclo completo, asi que no hay nada que extrapolar.
#   pr_stats   -> ~495 mil trabajos desde el 2026-04-23, y de buena calidad
#                 (0 nulos en numpages y site, 0.6% sin serialnumber).
#
# Codigos de finalaction, que es la columna que decide si una pagina llego al
# papel:  P = impresa | C = cancelada | E = expirada (enviada y nunca liberada)
#         D = borrada.  Solo P se imprime; C, E y D son papel que nadie recogio.
#
# RENDIMIENTO -- por que esta escrito asi:
#
#   1. Una sola pasada por tabla. La version ingenua sacaba totales, sedes,
#      meses, dia-de-semana y color/duplex con una consulta cada una: cinco
#      escaneos de 187 MB para responder lo mismo. Aqui se agrega UNA vez por
#      (fecha, sede) -- 266 filas -- y de ahi se derivan todas en Python.
#   2. Seq scan a proposito. El WHERE toca el 97% de la tabla; forzar el indice
#      de submitdate seria mas lento, no mas rapido. El indice si trabaja en la
#      consulta de la ventana de 28 dias, que es la unica selectiva.
#   3. Nunca en el event loop. psycopg2 es bloqueante: un `async def` que
#      consulta la BD congela TODAS las peticiones mientras dura. El calculo
#      completo son ~560 ms, que bloquearian el backend entero. Por eso corre en
#      un hilo aparte y el endpoint solo sirve cache ya calentada.
#   4. Stale-while-revalidate. Si la cache vencio se devuelve la vieja y se
#      refresca de fondo, en vez de hacer esperar a quien pregunto.

# Fecha en que el sistema entro en produccion real. Antes hay dos pilotos
# (2024-03 a 2024-07 y 2025-03 a 2025-08) con 1-4 usuarios y ~3 mil trabajos al
# mes; desde el 2026-04-23 son 230+ usuarios y ~112 mil al mes. Mezclarlos hace
# que cualquier modelo lea el dia del despliegue como una tendencia de negocio.
PR_REGIMEN_INICIO = os.getenv("PR_REGIMEN_INICIO", "2026-04-23")

# Ventana de la tasa de consumo por impresora, en dias NATURALES. Se divide
# entre dias naturales y no entre dias con actividad: una impresora que no
# trabaja domingos gasta menos por dia de calendario, y el calendario es lo que
# hay que predecir.
VENTANA_CONSUMO_D = 28

# Semanas que mira la linea base del pronostico de volumen.
PRONOSTICO_SEMANAS = 8

# Rendimiento asumido por suministro, en paginas.
#
# NO son valores medidos: son estimaciones para poder ordenar por urgencia
# mientras historial acumula lecturas reales. Sustituir por el rendimiento del
# fabricante por modelo en cuanto se tenga.
#
# Dentro de un mismo suministro el ORDEN no depende de estos numeros, porque son
# un factor de escala comun a todas las impresoras. Los dias absolutos si. Por
# eso cada fila viaja marcada con el metodo que se uso para calcularla.
RENDIMIENTO_PAGINAS = {
    "TONER_NEGRO":        6000, "TONER_CIAN":         6000,
    "TONER_MAGENTA":      6000, "TONER_AMARILLO":     6000,
    "FOTO_NEGRO":        40000, "FOTO_CIAN":         40000,
    "FOTO_MAGENTA":      40000, "FOTO_AMARILLO":     40000,
    "REVELADOR_NEGRO":   40000, "KIT_MANTENIMIENTO": 150000,
    "KIT_FUSOR":        150000, "CONTENEDOR_DESECHO": 30000,
}

DOW_NOMBRE = {1: "Lunes", 2: "Martes", 3: "Miercoles", 4: "Jueves",
              5: "Viernes", 6: "Sabado", 7: "Domingo"}

ANA_CACHE_TTL   = 600     # 10 min; los datos que resume son diarios
_ana_cache: dict          = {}
_ana_cache_ts:  float     = 0.0
_ana_lock                 = threading.Lock()


def _mediana(valores: list[float]) -> float:
    """Mediana, no media, y a proposito: la distribucion de paginas por trabajo
    tiene mediana 2 y maximo 6900, asi que un solo manual largo desplaza el
    promedio de una sede entera."""
    if not valores:
        return 0.0
    s = sorted(valores)
    n = len(s)
    m = n // 2
    return float(s[m]) if n % 2 else (s[m - 1] + s[m]) / 2.0


def _pronostico_por_dow(serie: dict[str, float], objetivo: list,
                        semanas: int = PRONOSTICO_SEMANAS) -> list[dict]:
    """Linea base: cada dia se predice con la MEDIANA de los ultimos `semanas`
    mismos dias de la semana.

    Es deliberadamente simple. Con ~22 semanas de datos no alcanza para entrenar
    nada complejo sin sobreajustar, y la estacionalidad semanal aqui es enorme
    (el domingo cae al 12% de un dia normal y el sabado se trabaja al 72%), asi
    que este modelo es dificil de batir. Y hace falta de todos modos: sin un
    piso de comparacion no hay forma de saber si un modelo mas caro aporta algo.

    La mediana sobre 8 semanas absorbe sola un feriado suelto; no hace falta un
    calendario de feriados para que la linea base se sostenga.

    `serie` es {fecha ISO -> paginas}. Devuelve una fila por dia de `objetivo`.
    """
    por_dow: dict[int, list] = defaultdict(list)
    for f_iso, v in serie.items():
        por_dow[date.fromisoformat(f_iso).isoweekday()].append((f_iso, v))
    for lista in por_dow.values():
        lista.sort()

    salida = []
    for d in objetivo:
        previos = [v for f_iso, v in por_dow.get(d.isoweekday(), [])
                   if f_iso < d.isoformat()]
        muestra = previos[-semanas:]
        salida.append({
            "fecha":     d.isoformat(),
            "dow":       d.isoweekday(),
            "nombre":    DOW_NOMBRE[d.isoweekday()],
            "paginas":   round(_mediana(muestra)),
            "muestra_n": len(muestra),
        })
    return salida


def _backtest(serie: dict[str, float], dias_prueba: int = 14) -> dict:
    """Valida el pronostico contra los ultimos `dias_prueba` dias reales.

    Particion CRONOLOGICA, nunca aleatoria: en una serie temporal, partir al
    azar entrena con el futuro para adivinar el pasado y devuelve metricas
    excelentes y falsas.

    MAE  = error medio en paginas.
    MAPE = error medio en %. Se saltan los dias de volumen casi nulo (domingos,
           feriados) porque dividir entre casi cero infla el porcentaje sin que
           eso signifique nada sobre la calidad del modelo.
    """
    fechas = sorted(serie.keys())
    if len(fechas) < dias_prueba + PRONOSTICO_SEMANAS * 7:
        return {"suficiente": False, "requiere_dias": dias_prueba + PRONOSTICO_SEMANAS * 7,
                "tiene_dias": len(fechas)}

    prueba = fechas[-dias_prueba:]
    pred   = _pronostico_por_dow(serie, [date.fromisoformat(f) for f in prueba])

    errores, pcts = [], []
    for p in pred:
        real = serie.get(p["fecha"], 0.0)
        errores.append(abs(real - p["paginas"]))
        if real >= 100:
            pcts.append(abs(real - p["paginas"]) / real * 100)

    return {
        "suficiente": True,
        "dias":       dias_prueba,
        "mae":        round(sum(errores) / len(errores)) if errores else 0,
        "mape":       round(sum(pcts) / len(pcts), 1) if pcts else None,
        "mape_n":     len(pcts),
    }


def _dias_restantes(nivel_pct: float, pag_dia: float, rendimiento: int):
    """Dias hasta agotar un suministro, por el puente paginas -> consumo.

    No se observa el nivel bajar (para eso harian falta meses de historial): se
    estima el gasto a partir de las paginas que esa impresora imprime de verdad,
    que si estan en pr_stats desde abril.

        %/dia = paginas_dia / rendimiento * 100
        dias  = nivel_actual / (%/dia)
    """
    if pag_dia <= 0 or rendimiento <= 0:
        return None
    pct_dia = pag_dia / rendimiento * 100.0
    return nivel_pct / pct_dia if pct_dia > 0 else None


def _consultar_analitica(conn) -> dict:
    """Las cuatro consultas. Bloqueante: llamar siempre desde un hilo.

    Cuatro y no once. Dos escaneos completos (el agregado diario y el de
    usuarios), uno parcial de 28 dias que si aprovecha pr_stats_submit_idx, y
    una lectura trivial de estado_actual. Medido en produccion: 318 + 89 + 153
    ms + ruido.
    """
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("SELECT to_regclass('public.pr_stats')")
    row = cur.fetchone()
    if row is None or row["to_regclass"] is None:
        return {"exists": False}

    # ── 1. Agregado diario x sede real x entorno LPM: la unica pasada completa
    #
    # OJO con pr_stats.site: NO es una ubicacion. Son dos entornos de LPM, y los
    # dos contienen impresoras de las 16 sedes reales -- las mismas impresoras
    # aparecen en ambos. Peor todavia, uno de esos entornos se llama "VENEZUELA"
    # y existe ademas una sede llamada VENEZUELA que no es lo mismo. Agrupar por
    # site y llamarlo "sede" produce comparaciones que no significan nada.
    #
    # La ubicacion de verdad esta en inventario (sede, zona, area), que se
    # mantiene desde el dashboard. Se cruza por serie: inventario.serie =
    # pr_stats.serialnumber, que empareja 113 de 119 impresoras.
    #
    # El LEFT JOIN cuesta ~76 ms sobre los 318 de la version sin cruce: es un
    # hash join contra una tabla de 115 filas y encima habilita paralelismo.
    # Barato para dejar de medir sobre una dimension equivocada.
    #
    # Lo NO impreso se parte en tres por releasemethod, no por finalaction.
    #
    # Motivo para no usar finalaction: se deriva de releasemethod y le pone
    # etiquetas distintas segun el entorno -- el MISMO evento sale como 'C' en un
    # entorno y como 'E' en el otro. releasemethod es consistente en los dos.
    #
    # Las tres causas, y lo que respalda cada nombre:
    #   T = sin liberar. Es la mayoria. Solo consta que no llego al papel; su
    #       finaldate viene copiado del submitdate en los 47 mil casos, asi que
    #       no dice cuanto espero, y ademas se comporta distinto en cada entorno
    #       (en uno consta quien lo libero, en el otro no). La CAUSA es
    #       desconocida: no llamarla "no recogida" ni cosas por el estilo.
    #   A = expirada. Aqui si hay evidencia: mediana 48.47 h y p95 48.96 h -- un
    #       temporizador de retencion de 48 h -- y ni uno solo tiene registrado
    #       quien lo libero, ni IP ni equipo. Nadie los toco nunca.
    #   U = eliminada. Mediana 23 min y SIEMPRE consta quien lo libero: alguien
    #       identificado actuo sobre el trabajo.
    #
    # Y ninguna de las tres es "desperdicio": si no se imprimio, no se gasto
    # papel ni toner. Es un indicador operativo, no un costo. El papel gastado de
    # verdad serian los duplicados, y NO se pueden medir aqui: printjobname es
    # generico (PDFServlet 23 mil veces, "document" 18 mil, formularios
    # recurrentes), asi que no distingue un reenvio accidental de un formato que
    # se imprime a diario.
    cur.execute("""
        SELECT p.submitdate::date::text                                        AS fecha,
               COALESCE(i.sede, '(fuera de inventario)')                       AS sede,
               COALESCE(i.zona, '')                                            AS zona,
               COALESCE(p.site, '')                                            AS lpm,
               COUNT(*)                                                        AS trabajos,
               COALESCE(SUM(p.numpages), 0)                                    AS paginas,
               COALESCE(SUM(p.numpages) FILTER (WHERE p.finalaction   = 'P'), 0) AS impresas,
               COALESCE(SUM(p.numpages) FILTER (WHERE p.releasemethod = 'T'), 0) AS sin_liberar,
               COALESCE(SUM(p.numpages) FILTER (WHERE p.releasemethod = 'A'), 0) AS expiradas,
               COALESCE(SUM(p.numpages) FILTER (WHERE p.releasemethod = 'U'), 0) AS eliminadas,
               COALESCE(SUM(p.numpages) FILTER (
                   WHERE p.finalaction = 'P' AND p.printjobcolor  = 'Y'), 0)   AS color,
               COALESCE(SUM(p.numpages) FILTER (
                   WHERE p.finalaction = 'P' AND p.printjobduplex = 'Y'), 0)   AS duplex
        FROM pr_stats p
        LEFT JOIN inventario i ON i.serie = p.serialnumber
        WHERE p.submitdate >= %s AND p.numpages > 0
        GROUP BY 1, 2, 3, 4
    """, (PR_REGIMEN_INICIO,))
    # Sin ORDER BY a proposito. Ordenar aqui obliga a PostgreSQL a ordenar las
    # 495 mil filas ANTES de agregar (GroupAggregate en vez de HashAggregate):
    # medido, 617 ms contra 318. Lo que hay que ordenar son las ~2 mil filas del
    # resultado, y eso sale gratis en Python.
    diario = [dict(r) for r in cur.fetchall()]

    # ── 2. Por usuario: sin LIMIT, para contar usuarios distintos sin otra
    #      pasada. Son ~660 filas, cabe de sobra en memoria.
    cur.execute("""
        SELECT COALESCE(userid, '')                                          AS userid,
               COALESCE(SUM(numpages) FILTER (WHERE finalaction =  'P'), 0)  AS impresas,
               COALESCE(SUM(numpages) FILTER (WHERE finalaction <> 'P'), 0)  AS no_impresas,
               COUNT(*)                FILTER (WHERE finalaction <> 'P')     AS trabajos_no_impresos
        FROM pr_stats
        WHERE submitdate >= %s AND numpages > 0
        GROUP BY 1
    """, (PR_REGIMEN_INICIO,))
    usuarios = [dict(r) for r in cur.fetchall()]

    # ── 3. Volumen por impresora en la ventana movil. Esta si es selectiva
    #      (~20% de la tabla) y usa el indice de submitdate.
    cur.execute("""
        SELECT serialnumber                                AS serie,
               COALESCE(SUM(numpages), 0)::float / %s      AS pag_dia,
               COUNT(DISTINCT submitdate::date)            AS dias_activos
        FROM pr_stats
        WHERE submitdate >= CURRENT_DATE - %s::int
          AND numpages > 0 AND finalaction = 'P'
          AND COALESCE(serialnumber, '') <> ''
        GROUP BY 1
    """, (VENTANA_CONSUMO_D, VENTANA_CONSUMO_D))
    consumo = {r["serie"]: {"pag_dia": float(r["pag_dia"]),
                            "dias_activos": int(r["dias_activos"])}
               for r in cur.fetchall()}

    # ── 4. Estado actual: 115 filas. La union con pr_stats es por serie
    #      (estado_actual.serie = pr_stats.serialnumber); cruzan 113 de 119.
    #      NO se usa serie_snmp: hoy esta vacia en el 100% de las filas.
    sc = ", ".join(f'{c.lower()} AS "{c}"' for c in SUPPLY_COLS)
    cur.execute(f"""
        SELECT serie, ip,
               COALESCE(sede, '')       AS sede,
               COALESCE(area, '')       AS area,
               COALESCE(modelo_inv, '') AS modelo,
               COALESCE(estado, '')     AS estado,
               {sc}
        FROM estado_actual
    """)
    equipos = [dict(r) for r in cur.fetchall()]

    return {"exists": True, "diario": diario, "usuarios": usuarios,
            "consumo": consumo, "equipos": equipos}


def _derivar_descriptiva(diario: list[dict], usuarios: list[dict]) -> dict:
    """Deriva todas las vistas descriptivas del agregado diario, en memoria.

    Son ~2 mil filas: agregarlas en Python cuesta milisegundos y ahorra cuatro
    escaneos de 187 MB contra PostgreSQL.

    VOCABULARIO -- importa, porque la version anterior de esto mentia.

    Un trabajo o llego al papel o no llego. Nada mas. Lo que NO llego al papel
    NO es "desperdicio": si no se imprimio, no se gasto papel ni toner. Es un
    indicador operativo (cuanta friccion hay entre pedir una impresion y
    obtenerla), no un indicador de costo. Nombrarlo como costo llevo a afirmar
    que se tiraban 50 mil paginas al mes, y no se tira ninguna.

      impresas     -> finalaction 'P'. Salio en papel.
      sin_liberar  -> releasemethod 'T'. No salio. Causa DESCONOCIDA: su
                      finaldate viene copiado del submitdate, y se comporta
                      distinto en cada entorno de LPM. No inventarle una causa.
      expiradas    -> releasemethod 'A'. No salio, y aqui si hay evidencia de por
                      que: mediana 48.47 h con p95 48.96 h (retencion de 48 h) y
                      ni uno tiene registrado quien lo libero. Nadie lo toco.
      eliminadas   -> releasemethod 'U'. No salio; mediana 23 min y siempre
                      consta quien lo libero. Alguien identificado actuo.

    Las etiquetas 'C' (cancelada) y 'E' (expirada) de finalaction NO se usan: son
    el mismo hecho con dos nombres, uno por entorno. Comprobado -- cada valor de
    releasemethod produce exactamente un finalaction, sin una sola excepcion en
    495 mil trabajos, que es como se ve un campo derivado y no un hecho medido.
    """
    CAMPOS = ("trabajos", "paginas", "impresas", "sin_liberar", "expiradas",
              "eliminadas", "color", "duplex")
    tot   = dict.fromkeys(CAMPOS, 0)
    sedes: dict[str, dict] = {}
    zonas: dict[str, dict] = {}
    lpms:  dict[str, dict] = {}
    meses: dict[str, dict] = {}
    dows:  dict[int, dict] = {}
    serie_global: dict[str, float] = defaultdict(float)
    serie_sede:   dict[str, dict]  = defaultdict(lambda: defaultdict(float))

    for r in diario:
        f_iso = r["fecha"]
        vals  = {k: int(r[k]) for k in CAMPOS}
        for k, v in vals.items():
            tot[k] += v

        for grupo, clave in ((sedes, r["sede"]), (zonas, r["zona"] or "(sin zona)"),
                             (lpms,  r["lpm"] or "(sin entorno)")):
            acc = grupo.setdefault(clave, dict.fromkeys(CAMPOS, 0))
            for k, v in vals.items():
                acc[k] += v

        no_imp = vals["sin_liberar"] + vals["expiradas"] + vals["eliminadas"]
        m = meses.setdefault(f_iso[:7], {"impresas": 0, "no_impresas": 0})
        m["impresas"]    += vals["impresas"]
        m["no_impresas"] += no_imp

        dow = date.fromisoformat(f_iso).isoweekday()
        d = dows.setdefault(dow, {"impresas": 0, "dias": set()})
        d["impresas"] += vals["impresas"]
        d["dias"].add(f_iso)

        serie_global[f_iso] += float(vals["impresas"])
        serie_sede[r["sede"]][f_iso] += float(vals["impresas"])

    def _pct(parte: int, total: int) -> float:
        return round(100.0 * parte / total, 1) if total else 0.0

    tot["no_impresas"]     = tot["sin_liberar"] + tot["expiradas"] + tot["eliminadas"]
    tot["pct_no_impresas"] = _pct(tot["no_impresas"], tot["paginas"])
    tot["usuarios"]        = sum(1 for u in usuarios if u["userid"])
    tot["dias"]            = len(serie_global)
    tot["desde"]           = min(serie_global) if serie_global else None
    tot["hasta"]           = max(serie_global) if serie_global else None

    def _filas(grupo: dict, etiqueta: str) -> list[dict]:
        salida = []
        for nombre, g in sorted(grupo.items(), key=lambda kv: -kv[1]["paginas"]):
            no_imp = g["sin_liberar"] + g["expiradas"] + g["eliminadas"]
            salida.append({
                etiqueta: nombre, **{k: g[k] for k in CAMPOS},
                "no_impresas": no_imp,
                "pct_no_impresas": _pct(no_imp, g["paginas"]),
            })
        return salida

    # Aqui se trabaja SABADO (72% de un dia normal): un calendario laboral
    # generico lunes-viernes modelaria mal una porcion grande del volumen.
    por_dow = [{"dow": k, "nombre": DOW_NOMBRE[k], "impresas": v["impresas"],
                "dias": len(v["dias"]),
                "promedio": round(v["impresas"] / len(v["dias"])) if v["dias"] else 0}
               for k, v in sorted(dows.items())]

    por_mes = [{"mes": k, "impresas": v["impresas"], "no_impresas": v["no_impresas"],
                "pct_no_impresas": _pct(v["no_impresas"], v["impresas"] + v["no_impresas"])}
               for k, v in sorted(meses.items())]

    # Usuarios cuyos envios acaban mas veces sin imprimirse. No es una lista de
    # culpables de nada: puede ser que su flujo de liberacion falle.
    top = sorted((u for u in usuarios if u["userid"] and int(u["no_impresas"]) > 0),
                 key=lambda u: -int(u["no_impresas"]))[:25]
    top_no_impresas = [{
        "userid": u["userid"], "no_impresas": int(u["no_impresas"]),
        "impresas": int(u["impresas"]),
        "trabajos_no_impresos": int(u["trabajos_no_impresos"]),
        "pct": _pct(int(u["no_impresas"]), int(u["no_impresas"]) + int(u["impresas"])),
    } for u in top]

    return {
        "descriptiva": {
            "totales": tot,
            "por_sede": _filas(sedes, "sede"),
            "por_zona": _filas(zonas, "zona"),
            # Los dos entornos de LPM. No son ubicaciones: se exponen aparte solo
            # para que se vea de donde salen las expiradas y eliminadas, que
            # existen en uno y no en el otro.
            "por_lpm":  _filas(lpms, "entorno"),
            "por_mes": por_mes, "por_dow": por_dow,
            "top_no_impresas": top_no_impresas,
            "modo": {"color": tot["color"], "mono": tot["impresas"] - tot["color"],
                     "duplex": tot["duplex"], "simplex": tot["impresas"] - tot["duplex"],
                     "pct_color":  _pct(tot["color"],  tot["impresas"]),
                     "pct_duplex": _pct(tot["duplex"], tot["impresas"])},
        },
        "_series": {"global": dict(serie_global),
                    "sedes": {k: dict(v) for k, v in serie_sede.items()}},
    }


def _derivar_predictiva(series: dict, consumo: dict, equipos: list[dict]) -> dict:
    """Pronostico de volumen y agotamiento de suministros."""
    hoy = date.today()
    horizonte = [hoy + timedelta(days=i) for i in range(1, 15)]

    volumen = {
        "horizonte_dias": len(horizonte),
        "global": {"pronostico": _pronostico_por_dow(series["global"], horizonte),
                   "backtest":   _backtest(series["global"])},
        "sedes": {sede: {"pronostico": _pronostico_por_dow(s, horizonte),
                         "backtest":   _backtest(s)}
                  for sede, s in series["sedes"].items()},
    }

    suministros, sin_volumen = [], 0
    for e in equipos:
        c = consumo.get(e["serie"])
        pag_dia = c["pag_dia"] if c else 0.0
        if not c:
            sin_volumen += 1
        for col in SUPPLY_COLS:
            nivel = e.get(col)
            if nivel is None:
                continue
            nivel = float(nivel)
            if nivel > 60:          # por encima de 60% no hay nada que decidir
                continue
            dias = _dias_restantes(nivel, pag_dia, RENDIMIENTO_PAGINAS.get(col, 6000))
            suministros.append({
                "serie": e["serie"], "ip": e["ip"], "sede": e["sede"],
                "area": e["area"], "modelo": e["modelo"], "estado": e["estado"],
                "suministro": col,
                "etiqueta":   SUMINISTROS_LABELS.get(col, col),
                "nivel":      round(nivel, 1),
                "pag_dia":    round(pag_dia, 1),
                # "volumen"   -> estimado con las paginas reales de esa impresora.
                # "sin_datos" -> no aparece en pr_stats en la ventana. No se le
                #                inventa una tasa: se marca y se manda al final.
                #                (La version anterior aplicaba en silencio un
                #                0.8%/dia fijo, que no era una prediccion.)
                "metodo":     "volumen" if pag_dia > 0 else "sin_datos",
                "dias":       round(dias, 1) if dias is not None else None,
                "agotamiento": (hoy + timedelta(days=int(min(dias, 3650)))).isoformat()
                               if dias is not None else None,
            })

    # Los sin estimacion van al final: son los que no se pueden ordenar, no los
    # menos urgentes.
    suministros.sort(key=lambda s: (s["dias"] is None, s["dias"] or 0))

    return {
        "volumen": volumen,
        "suministros": {
            "items": suministros[:200], "total": len(suministros),
            "equipos_sin_volumen": sin_volumen,
            "ventana_dias": VENTANA_CONSUMO_D,
            "rendimientos": RENDIMIENTO_PAGINAS,
            "nota": ("Los dias se estiman con las paginas reales de cada impresora "
                     "(pr_stats) y un rendimiento asumido por suministro, porque "
                     "historial todavia no tiene recorrido para medir el consumo. "
                     "El ORDEN dentro de un mismo suministro es fiable; los dias "
                     "absolutos son una estimacion."),
        },
    }


def _cargar_analitica() -> dict:
    """Recalcula el paquete completo. BLOQUEANTE: solo desde un hilo."""
    with get_db() as conn:
        crudo = _consultar_analitica(conn)
    if not crudo.get("exists"):
        return {"exists": False}

    desc = _derivar_descriptiva(crudo["diario"], crudo["usuarios"])
    pred = _derivar_predictiva(desc.pop("_series"), crudo["consumo"], crudo["equipos"])

    return {
        "exists": True,
        "generado": datetime.now().isoformat(timespec="seconds"),
        "regimen": {
            "desde": PR_REGIMEN_INICIO,
            "nota": ("pr_stats tiene filas desde 2024, pero son dos pilotos con 1-4 "
                     "usuarios. La produccion real arranca el 2026-04-23 y solo eso "
                     "se usa aqui: mezclarlas haria leer el dia del despliegue como "
                     "una tendencia de negocio."),
        },
        **desc,
        "predictiva": pred,
    }


def _refrescar_analitica() -> None:
    """Refresco en hilo. El lock evita que varias peticiones que llegan con la
    cache vencida disparen el mismo calculo a la vez."""
    global _ana_cache, _ana_cache_ts
    if not _ana_lock.acquire(blocking=False):
        return
    try:
        datos = _cargar_analitica()
        _ana_cache, _ana_cache_ts = datos, time.time()
    except Exception as e:
        logging.warning("analitica: fallo el refresco: %s", e)
    finally:
        _ana_lock.release()


@app.get("/analitica")
async def get_analitica():
    """Analitica descriptiva y predictiva sobre pr_stats.

    Nunca bloquea el event loop: si hay cache la devuelve al instante y refresca
    de fondo cuando toca; y el primer calculo, si la cache aun esta fria, se va a
    un hilo con run_in_threadpool en vez de congelar el resto de la API los
    ~560 ms que dura.
    """
    if _ana_cache:
        if time.time() - _ana_cache_ts >= ANA_CACHE_TTL:
            threading.Thread(target=_refrescar_analitica, daemon=True).start()
        return _ana_cache
    try:
        await run_in_threadpool(_refrescar_analitica)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    if not _ana_cache:
        raise HTTPException(status_code=503, detail="Analitica no disponible todavia")
    return _ana_cache


def _ana_loop() -> None:
    """Precalienta la cache al arrancar y la refresca cada ANA_CACHE_TTL, para
    que ninguna peticion pague los ~560 ms del calculo.

    Si la cache sigue vacia reintenta cada 30 s en vez de cada 10 min: al
    arrancar tras un corte de luz PostgreSQL puede tardar ~48 s en aceptar
    conexiones, y no tiene sentido dejar la analitica muerta 10 minutos por eso.
    """
    while True:
        _refrescar_analitica()
        time.sleep(30 if not _ana_cache else ANA_CACHE_TTL)


threading.Thread(target=_ana_loop, daemon=True).start()


@app.get("/health")
async def health():
    age  = round((datetime.now() - _cache["ts_dt"]).total_seconds()) if _cache else -1
    pool = _get_pool()
    return {
        "status":      "ok",
        "cache_age_s": age,
        "db":          "connected" if pool else "sin DATABASE_URL",
        "ts":          datetime.now().isoformat(),
    }

@app.post("/send-alert")
async def send_alert():
    if not EMAIL_FROM or not EMAIL_PASS:
        raise HTTPException(status_code=503, detail="Credenciales de correo no configuradas.")
    if not _cache:
        raise HTTPException(status_code=503, detail="Sin datos en cache aun.")

    printers = _cache["payload"].get("estado", [])
    alertas  = []
    for p in printers:
        for col, label in SUMINISTROS_LABELS.items():
            raw = p.get(col)
            if raw is None or str(raw).strip() in ("", "N/A", "nan", "None"):
                continue
            try:
                val = float(str(raw).replace("%", "").strip())
            except ValueError:
                continue
            if val <= ALERT_THRESHOLD:
                alertas.append({
                    "ip": p.get("IP", "—"), "sede": p.get("SEDE", "—"),
                    "area": p.get("AREA") or "", "suministro": label,
                    "valor": val, "nivel": "CRITICO" if val <= 10 else "BAJO",
                })

    if not alertas:
        return {"sent": False, "message": f"No hay suministros por debajo del {ALERT_THRESHOLD}%."}

    alertas.sort(key=lambda x: x["valor"])

    rows_html = ""
    for a in alertas:
        color = "#f04545" if a["nivel"] == "CRITICO" else "#e0a020"
        bg    = "#fff1f1" if a["nivel"] == "CRITICO" else "#fffbea"
        rows_html += f"""
        <tr style="background:{bg}">
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace">{a['ip']}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee">{a['sede']}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#6b7280;font-size:12px">{a['area'] or '—'}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee">{a['suministro']}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">
            <span style="color:{color};font-weight:bold">{a['valor']:.0f}%</span>
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">
            <span style="background:{color}22;color:{color};padding:2px 8px;border-radius:99px;font-size:11px;font-weight:bold">{a['nivel']}</span>
          </td>
        </tr>"""

    now_str = datetime.now().strftime("%d/%m/%Y %H:%M")
    html = f"""
    <div style="font-family:Arial,sans-serif;max-width:700px;margin:auto">
      <div style="background:#1a2235;padding:24px 32px;border-radius:8px 8px 0 0">
        <h2 style="color:#fff;margin:0;font-size:20px">Alerta de Suministros - Lexmark Monitor</h2>
        <p style="color:#8aa0c0;margin:6px 0 0;font-size:13px">{now_str} · {len(alertas)} impresoras con suministros &le;{ALERT_THRESHOLD}%</p>
      </div>
      <div style="background:#f9fafb;padding:24px 32px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb">
        <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
          <thead>
            <tr style="background:#1a2235">
              <th style="padding:10px 12px;color:#8aa0c0;text-align:left;font-size:11px;font-weight:600">IP</th>
              <th style="padding:10px 12px;color:#8aa0c0;text-align:left;font-size:11px;font-weight:600">SEDE</th>
              <th style="padding:10px 12px;color:#8aa0c0;text-align:left;font-size:11px;font-weight:600">AREA</th>
              <th style="padding:10px 12px;color:#8aa0c0;text-align:left;font-size:11px;font-weight:600">SUMINISTRO</th>
              <th style="padding:10px 12px;color:#8aa0c0;text-align:center;font-size:11px;font-weight:600">NIVEL</th>
              <th style="padding:10px 12px;color:#8aa0c0;text-align:center;font-size:11px;font-weight:600">ESTADO</th>
            </tr>
          </thead>
          <tbody>{rows_html}</tbody>
        </table>
        <p style="color:#9ca3af;font-size:11px;margin-top:16px">Generado automaticamente por Dashboard Lexmark - Comutel Peru.</p>
      </div>
    </div>"""

    to_list = [a.strip() for a in EMAIL_TO.replace(";", ",").split(",") if a.strip()]
    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"Alerta suministros Lexmark - {len(alertas)} impresoras al {now_str}"
    msg["From"]    = EMAIL_FROM
    msg["To"]      = ", ".join(to_list)
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.ehlo(); server.starttls()
            server.login(EMAIL_FROM, EMAIL_PASS)
            server.sendmail(EMAIL_FROM, to_list, msg.as_string())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error al enviar correo: {e}")

    return {"sent": True, "alertas": len(alertas), "destinatario": EMAIL_TO}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001, reload=False)
