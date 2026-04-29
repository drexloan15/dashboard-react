"""
Backend FastAPI – Dashboard Lexmark
Lee estado_actual e historial desde Google Sheets.
Optimizaciones:
  - Cliente gspread cacheado (evita re-autenticar en cada request)
  - Refresh en background thread (respuesta siempre instantánea)
  - Stale-while-revalidate: si el caché está desactualizado se devuelve
    el dato anterior y se dispara actualización en segundo plano
"""
import os, threading, time, smtplib
from pathlib import Path
# Carga .env si existe (desarrollo local)
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass
import numpy as np
import pandas as pd
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google.oauth2.service_account import Credentials
import gspread

# ── CONFIG ─────────────────────────────────────────────────────────────────
SHEET_ID    = "1kFuY-ckmMQw82YoMeqh9ASR5tImK1lG4KV5OgLZqlC0"
HOJA_ESTADO = "estado_actual"
HOJA_HIST   = "historial"
SCOPES      = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]
CACHE_TTL   = 240   # segundos antes de refrescar
GC_TTL      = 3000  # segundos antes de re-autenticar (50 min)

CRED_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "monitoreo-impresoras.json")

# ── EMAIL CONFIG ────────────────────────────────────────────────────────────
EMAIL_FROM  = os.getenv("EMAIL_FROM", "")
EMAIL_PASS  = os.getenv("EMAIL_PASS", "")
EMAIL_TO    = os.getenv("EMAIL_TO", "helpdesk@comutelperu.com")
SMTP_HOST   = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT   = int(os.getenv("SMTP_PORT", "587"))
ALERT_THRESHOLD = 25  # % por debajo del cual se notifica

SUMINISTROS_LABELS = {
    "TONER_NEGRO": "Tóner Negro", "TONER_CIAN": "Tóner Cián",
    "TONER_MAGENTA": "Tóner Magenta", "TONER_AMARILLO": "Tóner Amarillo",
    "FOTO_NEGRO": "Fotocond. Negro", "FOTO_CIAN": "Fotocond. Cián",
    "FOTO_MAGENTA": "Fotocond. Magenta", "FOTO_AMARILLO": "Fotocond. Amarillo",
    "REVELADOR_NEGRO": "Revelador Negro", "KIT_MANTENIMIENTO": "Kit Mantenimiento",
    "KIT_FUSOR": "Kit Fusor", "CONTENEDOR_DESECHO": "Contenedor Desecho",
}

# ── APP ─────────────────────────────────────────────────────────────────────
app = FastAPI(title="Lexmark Monitor API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

# ── ESTADO GLOBAL ───────────────────────────────────────────────────────────
_cache: dict = {}
_gc_obj  = None
_gc_ts: datetime | None = None
_refresh_lock = threading.Lock()

# ── HELPERS ─────────────────────────────────────────────────────────────────
def _get_gc() -> gspread.Client:
    """Devuelve cliente gspread cacheado; re-autentica si expira."""
    global _gc_obj, _gc_ts
    now = datetime.now()
    if _gc_obj is None or _gc_ts is None or (now - _gc_ts).total_seconds() > GC_TTL:
        creds = Credentials.from_service_account_file(CRED_PATH, scopes=SCOPES)
        _gc_obj = gspread.authorize(creds)
        _gc_ts  = now
    return _gc_obj

def _ws_to_df(ws: gspread.Worksheet) -> pd.DataFrame:
    records = ws.get_all_records()
    return pd.DataFrame(records) if records else pd.DataFrame()

def reducir_historial(dh: pd.DataFrame) -> pd.DataFrame:
    """Deduplica a una lectura por IP por hora (1 fila por IP por hora del día)."""
    if dh.empty:
        return dh
    ts_col = "TIMESTAMP" if "TIMESTAMP" in dh.columns else "FECHA"
    dh = dh.copy()
    dh["_ts"] = pd.to_datetime(dh[ts_col], errors="coerce")
    dh = dh.dropna(subset=["_ts"])
    if dh.empty:
        return dh
    dh["_fecha"] = dh["_ts"].dt.date
    dh["_hora"]  = dh["_ts"].dt.hour
    dh = dh.sort_values("_ts").groupby(["IP", "_fecha", "_hora"], as_index=False).last()
    dh["_ts"]    = dh["_ts"].astype(str)
    dh["_fecha"] = dh["_fecha"].astype(str)
    return dh.drop(columns=["_hora"])

def clean_df(df: pd.DataFrame) -> list[dict]:
    df = df.copy()
    for col in df.select_dtypes(include=["object"]).columns:
        df[col] = df[col].astype(str).replace({"nan": None, "NaT": None, "<NA>": None})
    df = df.where(pd.notna(df), None)
    return df.to_dict(orient="records")

# ── LÓGICA DE REFRESH ────────────────────────────────────────────────────────
def _do_refresh():
    """Carga datos frescos; hilo-seguro via lock no-bloqueante."""
    global _cache
    if not _refresh_lock.acquire(blocking=False):
        return  # ya hay un refresh en curso
    try:
        now = datetime.now()
        gc = _get_gc()
        sh = gc.open_by_key(SHEET_ID)

        de     = _ws_to_df(sh.worksheet(HOJA_ESTADO))
        dh_raw = _ws_to_df(sh.worksheet(HOJA_HIST))
        dh     = reducir_historial(dh_raw) if not dh_raw.empty else pd.DataFrame()

        _cache = {
            "payload": {
                "estado":    clean_df(de),
                "historial": clean_df(dh),
                "ts":        now.strftime("SYNC %H:%M:%S"),
            },
            "ts_dt": now,
        }
        print(f"[cache] actualizado {now.strftime('%H:%M:%S')} · "
              f"{len(de)} equipos · {len(dh)} registros historial")
    except Exception as e:
        print(f"[cache] error al refrescar: {e}")
    finally:
        _refresh_lock.release()

def _bg_loop():
    """Loop que refresca cada CACHE_TTL segundos en segundo plano."""
    while True:
        time.sleep(CACHE_TTL)
        _do_refresh()

# Carga inicial + hilo de background al arrancar el módulo
threading.Thread(target=_do_refresh, daemon=True).start()
threading.Thread(target=_bg_loop,    daemon=True).start()

# ── ENDPOINTS ────────────────────────────────────────────────────────────────
@app.get("/data")
async def get_data():
    now = datetime.now()

    # Caché fresco → respuesta inmediata
    if _cache and (now - _cache["ts_dt"]).total_seconds() < CACHE_TTL:
        return _cache["payload"]

    # Caché desactualizado pero existe → devolver dato anterior y refrescar en BG
    if _cache:
        threading.Thread(target=_do_refresh, daemon=True).start()
        stale = dict(_cache["payload"])
        stale["ts"] = stale["ts"] + " ↻"
        return stale

    # Sin caché (primer arranque, esperar carga inicial)
    _do_refresh()
    if _cache:
        return _cache["payload"]
    return {"error": "Cargando datos…", "estado": [], "historial": [], "ts": "—"}

@app.get("/health")
async def health():
    age = round((datetime.now() - _cache["ts_dt"]).total_seconds()) if _cache else -1
    return {"status": "ok", "cache_age_s": age, "ts": datetime.now().isoformat()}

@app.post("/send-alert")
async def send_alert():
    if not EMAIL_FROM or not EMAIL_PASS:
        raise HTTPException(status_code=503, detail="Credenciales de correo no configuradas (EMAIL_FROM / EMAIL_PASS).")

    if not _cache:
        raise HTTPException(status_code=503, detail="Sin datos en caché aún. Intenta en unos segundos.")

    printers = _cache["payload"].get("estado", [])

    alertas = []
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
                    "ip": p.get("IP", "—"),
                    "sede": p.get("SEDE", "—"),
                    "area": p.get("AREA") or "",
                    "suministro": label,
                    "valor": val,
                    "nivel": "CRÍTICO" if val <= 10 else "BAJO",
                })

    if not alertas:
        return {"sent": False, "message": f"No hay suministros por debajo del {ALERT_THRESHOLD}%."}

    alertas.sort(key=lambda x: x["valor"])

    # ── Construir HTML ───────────────────────────────────────────────────────
    rows_html = ""
    for a in alertas:
        color = "#f04545" if a["nivel"] == "CRÍTICO" else "#e0a020"
        bg    = "#fff1f1" if a["nivel"] == "CRÍTICO" else "#fffbea"
        area_cell = a['area'] if a['area'] else "—"
        rows_html += f"""
        <tr style="background:{bg}">
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace">{a['ip']}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee">{a['sede']}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#6b7280;font-size:12px">{area_cell}</td>
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
        <p style="color:#9ca3af;font-size:11px;margin-top:16px">Este mensaje fue generado automáticamente por el Dashboard Lexmark – Comutel Perú.</p>
      </div>
    </div>"""

    # ── Enviar ───────────────────────────────────────────────────────────────
    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"⚠️ Alerta suministros Lexmark – {len(alertas)} impresoras al {now_str}"
    msg["From"]    = EMAIL_FROM
    msg["To"]      = EMAIL_TO
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.ehlo()
            server.starttls()
            server.login(EMAIL_FROM, EMAIL_PASS)
            server.sendmail(EMAIL_FROM, EMAIL_TO, msg.as_string())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error al enviar correo: {e}")

    return {"sent": True, "alertas": len(alertas), "destinatario": EMAIL_TO}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=False)
