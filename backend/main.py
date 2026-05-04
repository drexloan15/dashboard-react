"""
Backend FastAPI - Dashboard Lexmark
Lee desde PostgreSQL. Los datos son escritos por api_server.py
que recibe del agente_lexmark via REST. Sin dependencia de Google Sheets.
"""
import os, threading, time, smtplib
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
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

# ── CONFIG ───────────────────────────────────────────────────────────────────
CACHE_TTL    = 60   # segundos entre refrescos desde PostgreSQL
DATABASE_URL = os.getenv("DATABASE_URL", "")

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

# ── APP ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="Lexmark Monitor API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ── ESTADO GLOBAL ────────────────────────────────────────────────────────────
_cache:       dict                                         = {}
_refresh_lock = threading.Lock()
_db_pool:     psycopg2.pool.ThreadedConnectionPool | None  = None

# ── DB: POOL ─────────────────────────────────────────────────────────────────
def _get_pool() -> psycopg2.pool.ThreadedConnectionPool | None:
    global _db_pool
    if _db_pool is None and DATABASE_URL:
        from urllib.parse import urlparse
        u = urlparse(DATABASE_URL)
        _db_pool = psycopg2.pool.ThreadedConnectionPool(
            1, 5,
            host=u.hostname, port=u.port or 5432,
            dbname=u.path.lstrip("/"),
            user=u.username, password=u.password,
        )
    return _db_pool

@contextmanager
def get_db():
    pool = _get_pool()
    if pool is None:
        raise RuntimeError("DATABASE_URL no configurado")
    conn = pool.getconn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)

# ── DB: CREAR / MIGRAR TABLAS ────────────────────────────────────────────────
def init_db():
    """
    Crea las tablas si no existen y agrega columnas faltantes con ALTER TABLE.
    Schema compatible con api_server.py (agente_lexmark).
    """
    supply_ddl = "\n".join(f"    {c.lower()} REAL," for c in SUPPLY_COLS)

    with get_db() as conn:
        cur = conn.cursor()

        # ── estado_actual ──────────────────────────────────────────────────
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

        # Columnas que api_server.py necesita y pueden faltar en tablas antiguas
        for col, coltype in [
            ("tipo",        "TEXT"),
            ("serie",       "TEXT"),
            ("conexion",    "TEXT"),
            ("modelo_snmp", "TEXT"),
            ("fecha",       "TEXT"),
            ("hora",        "SMALLINT"),
        ]:
            cur.execute(f"""
                ALTER TABLE estado_actual
                ADD COLUMN IF NOT EXISTS {col} {coltype}
            """)

        # ── historial ──────────────────────────────────────────────────────
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

        for col, coltype in [
            ("zona",        "TEXT"),
            ("area",        "TEXT"),
            ("modelo_inv",  "TEXT"),
            ("tipo",        "TEXT"),
            ("serie",       "TEXT"),
            ("conexion",    "TEXT"),
            ("modelo_snmp", "TEXT"),
        ]:
            cur.execute(f"""
                ALTER TABLE historial
                ADD COLUMN IF NOT EXISTS {col} {coltype}
            """)

        cur.execute("CREATE INDEX IF NOT EXISTS hist_ip_idx ON historial(ip)")
        cur.execute("CREATE INDEX IF NOT EXISTS hist_ts_idx ON historial(timestamp)")

    print("[db] tablas listas")

# ── DB: QUERIES ───────────────────────────────────────────────────────────────
def _query_estado(conn) -> list[dict]:
    sc = ", ".join(f'{c.lower()} AS "{c}"' for c in SUPPLY_COLS)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(f"""
        SELECT ip          AS "IP",
               sede        AS "SEDE",
               area        AS "AREA",
               zona        AS "ZONA",
               estado      AS "ESTADO",
               modelo_inv  AS "MODELO_INV",
               contador    AS "CONTADOR",
               {sc}
        FROM estado_actual
    """)
    return [dict(r) for r in cur.fetchall()]

def _query_historial(conn) -> list[dict]:
    sc = ", ".join(f'{c.lower()} AS "{c}"' for c in SUPPLY_COLS)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(f"""
        SELECT ip          AS "IP",
               sede        AS "SEDE",
               estado      AS "ESTADO",
               contador    AS "CONTADOR",
               {sc},
               timestamp::text AS "TIMESTAMP",
               fecha::text     AS "FECHA",
               timestamp::text AS "_ts",
               fecha::text     AS "_fecha"
        FROM historial
        ORDER BY timestamp
    """)
    return [dict(r) for r in cur.fetchall()]

# ── CACHE ─────────────────────────────────────────────────────────────────────
def _load_cache_from_db():
    global _cache
    try:
        with get_db() as conn:
            estado    = _query_estado(conn)
            historial = _query_historial(conn)
        if estado:
            _cache = {
                "payload": {
                    "estado":    estado,
                    "historial": historial,
                    "ts":        datetime.now().strftime("DB %H:%M:%S"),
                },
                "ts_dt": datetime.now(),
            }
            print(f"[cache] {datetime.now().strftime('%H:%M:%S')} · "
                  f"{len(estado)} equipos · {len(historial)} historial")
    except Exception as e:
        print(f"[cache] error: {e}")
        import traceback; traceback.print_exc()

def _do_refresh():
    global _cache
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

# Arranque
init_db()
_load_cache_from_db()
threading.Thread(target=_bg_loop, daemon=True).start()

# ── ENDPOINTS ────────────────────────────────────────────────────────────────
@app.get("/data")
async def get_data():
    now = datetime.now()
    if _cache and (now - _cache["ts_dt"]).total_seconds() < CACHE_TTL:
        return _cache["payload"]
    if _cache:
        threading.Thread(target=_do_refresh, daemon=True).start()
        stale = dict(_cache["payload"])
        stale["ts"] = stale["ts"] + " ↻"
        return stale
    _do_refresh()
    if _cache:
        return _cache["payload"]
    return {"error": "Sin datos aun", "estado": [], "historial": [], "ts": "—"}

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
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=False)
