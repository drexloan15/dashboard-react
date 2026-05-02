"""
Backend FastAPI – Dashboard Lexmark
Google Sheets → PostgreSQL (sync) + API
- Google Sheets sigue siendo el transporte desde el agente SNMP
- En cada refresh se persiste en PostgreSQL local
- El dashboard sirve desde PostgreSQL (historial completo, sin límite de quota)
"""
import os, threading, time, smtplib
from contextlib import contextmanager
from pathlib import Path

# Forzar mensajes de error de libpq en inglés para evitar
# UnicodeDecodeError con la locale Spanish_Spain.1252 de Windows
os.environ.setdefault("LANG",             "C")
os.environ.setdefault("LC_ALL",           "C")
os.environ.setdefault("PGCLIENTENCODING", "UTF8")

try:
    from dotenv import load_dotenv
    # latin-1 para soportar comentarios con tildes en el .env de Windows
    load_dotenv(Path(__file__).parent / ".env", encoding="latin-1")
except ImportError:
    pass

import pandas as pd
import psycopg2
import psycopg2.extras
import psycopg2.pool
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google.oauth2.service_account import Credentials
import gspread

# ── CONFIG ──────────────────────────────────────────────────────────────────
SHEET_ID    = "1kFuY-ckmMQw82YoMeqh9ASR5tImK1lG4KV5OgLZqlC0"
HOJA_ESTADO = "estado_actual"
HOJA_HIST   = "historial"
SCOPES      = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]
CACHE_TTL = 240    # segundos entre refrescos
GC_TTL    = 3000   # segundos antes de re-autenticar gspread

CRED_PATH    = os.path.join(os.path.dirname(os.path.abspath(__file__)), "monitoreo-impresoras.json")
DATABASE_URL = os.getenv("DATABASE_URL", "")

# ── EMAIL ────────────────────────────────────────────────────────────────────
EMAIL_FROM      = os.getenv("EMAIL_FROM", "")
EMAIL_PASS      = os.getenv("EMAIL_PASS", "")
EMAIL_TO        = os.getenv("EMAIL_TO", "helpdesk@comutelperu.com")
SMTP_HOST       = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT       = int(os.getenv("SMTP_PORT", "587"))
ALERT_THRESHOLD = 25

SUMINISTROS_LABELS = {
    "TONER_NEGRO": "Tóner Negro",       "TONER_CIAN": "Tóner Cián",
    "TONER_MAGENTA": "Tóner Magenta",   "TONER_AMARILLO": "Tóner Amarillo",
    "FOTO_NEGRO": "Fotocond. Negro",    "FOTO_CIAN": "Fotocond. Cián",
    "FOTO_MAGENTA": "Fotocond. Magenta","FOTO_AMARILLO": "Fotocond. Amarillo",
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
_cache:        dict                                          = {}
_gc_obj                                                      = None
_gc_ts:        datetime | None                               = None
_refresh_lock  = threading.Lock()
_db_pool:      psycopg2.pool.ThreadedConnectionPool | None   = None

# ── DB: POOL Y CONTEXTO ──────────────────────────────────────────────────────
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

# ── DB: CREAR TABLAS ─────────────────────────────────────────────────────────
def init_db():
    supply_ddl     = "\n".join(f"    {c.lower()} REAL," for c in SUPPLY_COLS)
    supply_ddl_h   = "\n".join(f"    {c.lower()} REAL," for c in SUPPLY_COLS)

    with get_db() as conn:
        cur = conn.cursor()

        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS estado_actual (
                ip          TEXT PRIMARY KEY,
                sede        TEXT,
                area        TEXT,
                zona        TEXT,
                estado      TEXT,
                modelo_inv  TEXT,
                contador    REAL,
                {supply_ddl}
                updated_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS historial (
                id        SERIAL PRIMARY KEY,
                ip        TEXT        NOT NULL,
                fecha     DATE        NOT NULL,
                hora      SMALLINT    NOT NULL,
                timestamp TIMESTAMPTZ NOT NULL,
                sede      TEXT,
                estado    TEXT,
                contador  REAL,
                {supply_ddl_h}
                UNIQUE (ip, fecha, hora)
            )
        """)

        cur.execute("CREATE INDEX IF NOT EXISTS hist_ip_idx ON historial(ip)")
        cur.execute("CREATE INDEX IF NOT EXISTS hist_ts_idx ON historial(timestamp)")

    print("[db] tablas listas")

# ── DB: HELPERS TIPO ─────────────────────────────────────────────────────────
def _f(val) -> float | None:
    if val is None or str(val).strip() in ("", "nan", "None", "NaT", "<NA>", "N/A"):
        return None
    try:
        return float(str(val).replace("%", "").strip())
    except (ValueError, TypeError):
        return None

def _s(val) -> str | None:
    v = str(val).strip() if val is not None else ""
    return None if v in ("", "nan", "None", "NaT", "<NA>", "N/A") else v

# ── DB: UPSERT ESTADO ACTUAL ─────────────────────────────────────────────────
def _upsert_estado(conn, df: pd.DataFrame):
    if df.empty:
        return
    sc  = ", ".join(c.lower() for c in SUPPLY_COLS)
    sph = ", ".join(["%s"] * len(SUPPLY_COLS))
    sup = ", ".join(f"{c.lower()} = EXCLUDED.{c.lower()}" for c in SUPPLY_COLS)
    sql = f"""
        INSERT INTO estado_actual
            (ip, sede, area, zona, estado, modelo_inv, contador, {sc})
        VALUES (%s, %s, %s, %s, %s, %s, %s, {sph})
        ON CONFLICT (ip) DO UPDATE SET
            sede       = EXCLUDED.sede,
            area       = EXCLUDED.area,
            zona       = EXCLUDED.zona,
            estado     = EXCLUDED.estado,
            modelo_inv = EXCLUDED.modelo_inv,
            contador   = EXCLUDED.contador,
            {sup},
            updated_at = NOW()
    """
    cur = conn.cursor()
    for _, row in df.iterrows():
        cur.execute(sql, [
            _s(row.get("IP")),   _s(row.get("SEDE")),  _s(row.get("AREA")),
            _s(row.get("ZONA")), _s(row.get("ESTADO")), _s(row.get("MODELO_INV")),
            _f(row.get("CONTADOR")),
            *[_f(row.get(c)) for c in SUPPLY_COLS],
        ])

# ── DB: INSERT HISTORIAL (1 por IP por hora) ─────────────────────────────────
def _insert_historial(conn, df: pd.DataFrame):
    if df.empty:
        return
    sc  = ", ".join(c.lower() for c in SUPPLY_COLS)
    sph = ", ".join(["%s"] * len(SUPPLY_COLS))
    sup = ", ".join(f"{c.lower()} = EXCLUDED.{c.lower()}" for c in SUPPLY_COLS)
    sql = f"""
        INSERT INTO historial
            (ip, fecha, hora, timestamp, sede, estado, contador, {sc})
        VALUES (%s, %s, %s, %s, %s, %s, %s, {sph})
        ON CONFLICT (ip, fecha, hora) DO UPDATE SET
            timestamp = EXCLUDED.timestamp,
            estado    = EXCLUDED.estado,
            contador  = EXCLUDED.contador,
            {sup}
    """
    cur = conn.cursor()
    for _, row in df.iterrows():
        ts_raw = row.get("_ts") or row.get("TIMESTAMP") or row.get("FECHA") or ""
        if not ts_raw:
            continue
        try:
            ts_dt = pd.to_datetime(ts_raw)
        except Exception:
            continue
        cur.execute(sql, [
            _s(row.get("IP")),
            ts_dt.date(),
            int(ts_dt.hour),
            ts_dt.to_pydatetime(),
            _s(row.get("SEDE")),
            _s(row.get("ESTADO")),
            _f(row.get("CONTADOR")),
            *[_f(row.get(c)) for c in SUPPLY_COLS],
        ])

# ── DB: QUERIES PARA EL CACHE ────────────────────────────────────────────────
def _query_estado(conn) -> list[dict]:
    sc = ", ".join(f'{c.lower()} AS "{c}"' for c in SUPPLY_COLS)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(f"""
        SELECT ip AS "IP", sede AS "SEDE", area AS "AREA", zona AS "ZONA",
               estado AS "ESTADO", modelo_inv AS "MODELO_INV",
               contador AS "CONTADOR", {sc}
        FROM estado_actual
    """)
    return [dict(r) for r in cur.fetchall()]

def _query_historial(conn) -> list[dict]:
    sc = ", ".join(f'{c.lower()} AS "{c}"' for c in SUPPLY_COLS)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(f"""
        SELECT ip AS "IP", sede AS "SEDE", estado AS "ESTADO",
               contador AS "CONTADOR", {sc},
               timestamp::text AS "_ts",
               fecha::text     AS "_fecha"
        FROM historial
        ORDER BY timestamp
    """)
    return [dict(r) for r in cur.fetchall()]

# ── GSPREAD ──────────────────────────────────────────────────────────────────
def _get_gc() -> gspread.Client:
    global _gc_obj, _gc_ts
    now = datetime.now()
    if _gc_obj is None or _gc_ts is None or (now - _gc_ts).total_seconds() > GC_TTL:
        creds   = Credentials.from_service_account_file(CRED_PATH, scopes=SCOPES)
        _gc_obj = gspread.authorize(creds)
        _gc_ts  = now
    return _gc_obj

def _ws_to_df(ws: gspread.Worksheet) -> pd.DataFrame:
    records = ws.get_all_records()
    return pd.DataFrame(records) if records else pd.DataFrame()

def reducir_historial(dh: pd.DataFrame) -> pd.DataFrame:
    if dh.empty:
        return dh
    ts_col = "TIMESTAMP" if "TIMESTAMP" in dh.columns else "FECHA"
    dh = dh.copy()
    dh["_ts"]   = pd.to_datetime(dh[ts_col], errors="coerce")
    dh = dh.dropna(subset=["_ts"])
    if dh.empty:
        return dh
    dh["_fecha"] = dh["_ts"].dt.date
    dh["_hora"]  = dh["_ts"].dt.hour
    dh = dh.sort_values("_ts").groupby(["IP", "_fecha", "_hora"], as_index=False).last()
    dh["_ts"]    = dh["_ts"].astype(str)
    dh["_fecha"] = dh["_fecha"].astype(str)
    return dh.drop(columns=["_hora"])

# ── REFRESH ──────────────────────────────────────────────────────────────────
def _load_cache_from_db():
    """Puebla el cache inmediatamente desde PostgreSQL sin tocar GSheets."""
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
            print(f"[cache] cargado desde DB · {len(estado)} equipos · {len(historial)} historial")
    except Exception as e:
        print(f"[cache] error cargando DB: {e}")

def _do_refresh():
    """Sincroniza GSheets -> PostgreSQL y actualiza el cache."""
    global _cache
    if not _refresh_lock.acquire(blocking=False):
        return
    try:
        now = datetime.now()
        gc  = _get_gc()
        sh  = gc.open_by_key(SHEET_ID)

        de     = _ws_to_df(sh.worksheet(HOJA_ESTADO))
        dh_raw = _ws_to_df(sh.worksheet(HOJA_HIST))
        dh     = reducir_historial(dh_raw) if not dh_raw.empty else pd.DataFrame()

        with get_db() as conn:
            if not de.empty:
                _upsert_estado(conn, de)
            if not dh.empty:
                _insert_historial(conn, dh)
            estado    = _query_estado(conn)
            historial = _query_historial(conn)

        _cache = {
            "payload": {
                "estado":    estado,
                "historial": historial,
                "ts":        now.strftime("SYNC %H:%M:%S"),
            },
            "ts_dt": now,
        }
        print(f"[cache] sync {now.strftime('%H:%M:%S')} · "
              f"{len(estado)} equipos · {len(historial)} filas historial")
    except Exception as e:
        print(f"[cache] error sync GSheets: {e}")
        import traceback; traceback.print_exc()
        # Si GSheets falla, al menos refrescar desde PostgreSQL
        _load_cache_from_db()
    finally:
        _refresh_lock.release()

def _bg_loop():
    while True:
        time.sleep(CACHE_TTL)
        _do_refresh()

# Arranque: primero DB (instantáneo), luego sync GSheets en background
init_db()
_load_cache_from_db()
threading.Thread(target=_do_refresh, daemon=True).start()
threading.Thread(target=_bg_loop,    daemon=True).start()

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
    return {"error": "Cargando datos…", "estado": [], "historial": [], "ts": "—"}

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
        raise HTTPException(status_code=503, detail="Sin datos en caché aún.")

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
                    "valor": val, "nivel": "CRÍTICO" if val <= 10 else "BAJO",
                })

    if not alertas:
        return {"sent": False, "message": f"No hay suministros por debajo del {ALERT_THRESHOLD}%."}

    alertas.sort(key=lambda x: x["valor"])

    rows_html = ""
    for a in alertas:
        color = "#f04545" if a["nivel"] == "CRÍTICO" else "#e0a020"
        bg    = "#fff1f1" if a["nivel"] == "CRÍTICO" else "#fffbea"
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
        <h2 style="color:#fff;margin:0;font-size:20px">⚠️ Alerta de Suministros – Lexmark Monitor</h2>
        <p style="color:#8aa0c0;margin:6px 0 0;font-size:13px">{now_str} · {len(alertas)} impresoras con suministros ≤{ALERT_THRESHOLD}%</p>
      </div>
      <div style="background:#f9fafb;padding:24px 32px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb">
        <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
          <thead>
            <tr style="background:#1a2235">
              <th style="padding:10px 12px;color:#8aa0c0;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em">IP</th>
              <th style="padding:10px 12px;color:#8aa0c0;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em">SEDE</th>
              <th style="padding:10px 12px;color:#8aa0c0;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em">ÁREA</th>
              <th style="padding:10px 12px;color:#8aa0c0;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em">SUMINISTRO</th>
              <th style="padding:10px 12px;color:#8aa0c0;text-align:center;font-size:11px;font-weight:600;letter-spacing:.05em">NIVEL</th>
              <th style="padding:10px 12px;color:#8aa0c0;text-align:center;font-size:11px;font-weight:600;letter-spacing:.05em">ESTADO</th>
            </tr>
          </thead>
          <tbody>{rows_html}</tbody>
        </table>
        <p style="color:#9ca3af;font-size:11px;margin-top:16px">Generado automáticamente por Dashboard Lexmark – Comutel Perú.</p>
      </div>
    </div>"""

    to_list = [a.strip() for a in EMAIL_TO.replace(";", ",").split(",") if a.strip()]
    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"⚠️ Alerta suministros Lexmark – {len(alertas)} impresoras al {now_str}"
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
