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
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
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
def init_db():
    supply_ddl = "\n".join(f"    {c.lower()} REAL," for c in SUPPLY_COLS)
    with get_db() as conn:
        cur = conn.cursor()

        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS estado_actual (
                ip          TEXT PRIMARY KEY,
                sede        TEXT, area       TEXT, zona TEXT,
                estado      TEXT,
                modelo_inv  TEXT, tipo       TEXT, serie      TEXT,
                conexion    TEXT, modelo_snmp TEXT,
                fecha       TEXT, hora       SMALLINT,
                contador    REAL,
                {supply_ddl}
                updated_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        for col, coltype in [("tipo","TEXT"),("serie","TEXT"),("conexion","TEXT"),
                              ("modelo_snmp","TEXT"),("fecha","TEXT"),("hora","SMALLINT")]:
            cur.execute(f"ALTER TABLE estado_actual ADD COLUMN IF NOT EXISTS {col} {coltype}")

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
                UNIQUE (ip, fecha, hora)
            )
        """)
        for col, coltype in [("zona","TEXT"),("area","TEXT"),("modelo_inv","TEXT"),
                              ("tipo","TEXT"),("serie","TEXT"),("conexion","TEXT"),("modelo_snmp","TEXT")]:
            cur.execute(f"ALTER TABLE historial ADD COLUMN IF NOT EXISTS {col} {coltype}")

        cur.execute("CREATE INDEX IF NOT EXISTS hist_ip_idx     ON historial(ip)")
        cur.execute("CREATE INDEX IF NOT EXISTS hist_ts_idx     ON historial(timestamp DESC)")
        cur.execute("CREATE INDEX IF NOT EXISTS hist_fecha_idx  ON historial(fecha)")
        cur.execute("CREATE INDEX IF NOT EXISTS hist_sede_idx   ON historial(sede)")
        cur.execute("CREATE INDEX IF NOT EXISTS hist_estado_idx ON historial(estado)")

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
        SELECT ip AS "IP", sede AS "SEDE", area AS "AREA", zona AS "ZONA",
               estado AS "ESTADO", modelo_inv AS "MODELO_INV", contador AS "CONTADOR",
               {sc}
        FROM estado_actual
    """)
    return [dict(r) for r in cur.fetchall()]

def _query_historial_recent(conn, days: int = 30) -> list[dict]:
    sc = ", ".join(f'{c.lower()} AS "{c}"' for c in SUPPLY_COLS)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(f"""
        SELECT ip AS "IP", sede AS "SEDE", estado AS "ESTADO", contador AS "CONTADOR",
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
init_db()
_load_cache_from_db()
threading.Thread(target=_load_pr_cache,  daemon=True).start()
threading.Thread(target=_bg_loop,        daemon=True).start()
threading.Thread(target=lambda: [time.sleep(300) or _load_pr_cache() for _ in iter(int, 1)], daemon=True).start()

# ── MODELOS PYDANTIC ──────────────────────────────────────────────────────────
class AlertaStatusBody(BaseModel):
    estado:     str
    updated_by: str = "admin"

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
    ip:        str = Query(""),
    estado:    str = Query(""),
    fecha:     str = Query(""),
):
    sc = ", ".join(f'{c.lower()} AS "{c}"' for c in SUPPLY_COLS)
    where_parts: list[str] = []
    params: list = []

    if sede:
        where_parts.append("sede = %s"); params.append(sede)
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
                SELECT ip AS "IP", sede AS "SEDE", estado AS "ESTADO", contador AS "CONTADOR",
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
