"""
Backend FastAPI – Dashboard Lexmark
Lee estado_actual e historial desde Google Sheets.
Optimizaciones:
  - Cliente gspread cacheado (evita re-autenticar en cada request)
  - Refresh en background thread (respuesta siempre instantánea)
  - Stale-while-revalidate: si el caché está desactualizado se devuelve
    el dato anterior y se dispara actualización en segundo plano
"""
import os, threading, time
import numpy as np
import pandas as pd
from datetime import datetime
from fastapi import FastAPI
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
    """Deduplica a una lectura por IP por día (sin corte de fecha)."""
    if dh.empty:
        return dh
    ts_col = "TIMESTAMP" if "TIMESTAMP" in dh.columns else "FECHA"
    dh = dh.copy()
    dh["_ts"] = pd.to_datetime(dh[ts_col], errors="coerce")
    dh = dh.dropna(subset=["_ts"])
    if dh.empty:
        return dh
    dh["_fecha"] = dh["_ts"].dt.date
    dh = dh.sort_values("_ts").groupby(["IP", "_fecha"], as_index=False).last()
    dh["_ts"]    = dh["_ts"].astype(str)
    dh["_fecha"] = dh["_fecha"].astype(str)
    return dh

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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=False)
