"""
Migración única: Google Sheets -> PostgreSQL
Lee todo el contenido de estado_actual e historial desde GSheets
e inserta en PostgreSQL. Seguro de re-ejecutar (upsert/ON CONFLICT).
"""
import os, sys
from pathlib import Path

os.environ.setdefault("LANG",             "C")
os.environ.setdefault("LC_ALL",           "C")
os.environ.setdefault("PGCLIENTENCODING", "UTF8")

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env", encoding="latin-1")
except ImportError:
    pass

import pandas as pd
import psycopg2, psycopg2.pool, psycopg2.extras
from urllib.parse import urlparse
from contextlib import contextmanager
from google.oauth2.service_account import Credentials
import gspread

# -- CONFIG ------------------------------------------------------------------─
SHEET_ID    = "1kFuY-ckmMQw82YoMeqh9ASR5tImK1lG4KV5OgLZqlC0"
HOJA_ESTADO = "estado_actual"
HOJA_HIST   = "historial"
SCOPES      = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]
CRED_PATH    = Path(__file__).parent / "monitoreo-impresoras.json"
DATABASE_URL = os.getenv("DATABASE_URL", "")

SUPPLY_COLS = [
    "TONER_NEGRO", "TONER_CIAN", "TONER_MAGENTA", "TONER_AMARILLO",
    "FOTO_NEGRO",  "FOTO_CIAN",  "FOTO_MAGENTA",  "FOTO_AMARILLO",
    "REVELADOR_NEGRO", "KIT_MANTENIMIENTO", "KIT_FUSOR", "CONTENEDOR_DESECHO",
]

# -- DB ------------------------------------------------------------------------
def make_pool():
    u = urlparse(DATABASE_URL)
    return psycopg2.pool.ThreadedConnectionPool(
        1, 3,
        host=u.hostname, port=u.port or 5432,
        dbname=u.path.lstrip("/"),
        user=u.username, password=u.password,
    )

@contextmanager
def get_db(pool):
    conn = pool.getconn()
    try:
        yield conn; conn.commit()
    except Exception:
        conn.rollback(); raise
    finally:
        pool.putconn(conn)

def _f(val):
    if val is None or str(val).strip() in ("", "nan", "None", "NaT", "<NA>", "N/A"):
        return None
    try:
        return float(str(val).replace("%", "").strip())
    except (ValueError, TypeError):
        return None

def _s(val):
    v = str(val).strip() if val is not None else ""
    return None if v in ("", "nan", "None", "NaT", "<NA>", "N/A") else v

# -- CREAR TABLAS --------------------------------------------------------------
def init_db(pool):
    supply_ddl = "\n".join(f"    {c.lower()} REAL," for c in SUPPLY_COLS)
    with get_db(pool) as conn:
        cur = conn.cursor()
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS estado_actual (
                ip TEXT PRIMARY KEY, sede TEXT, area TEXT, zona TEXT,
                estado TEXT, modelo_inv TEXT, contador REAL,
                {supply_ddl}
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS historial (
                id        SERIAL PRIMARY KEY,
                ip        TEXT     NOT NULL,
                fecha     DATE     NOT NULL,
                hora      SMALLINT NOT NULL,
                timestamp TIMESTAMPTZ NOT NULL,
                sede TEXT, estado TEXT, contador REAL,
                {supply_ddl}
                UNIQUE (ip, fecha, hora)
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS hist_ip_idx ON historial(ip)")
        cur.execute("CREATE INDEX IF NOT EXISTS hist_ts_idx ON historial(timestamp)")
    print("[OK] Tablas listas")

# -- MIGRAR ESTADO ACTUAL ------------------------------------------------------
def migrar_estado(pool, df: pd.DataFrame):
    if df.empty:
        print("  estado_actual: hoja vacía, nada que migrar")
        return
    sc  = ", ".join(c.lower() for c in SUPPLY_COLS)
    sph = ", ".join(["%s"] * len(SUPPLY_COLS))
    sup = ", ".join(f"{c.lower()} = EXCLUDED.{c.lower()}" for c in SUPPLY_COLS)
    sql = f"""
        INSERT INTO estado_actual
            (ip, sede, area, zona, estado, modelo_inv, contador, {sc})
        VALUES (%s, %s, %s, %s, %s, %s, %s, {sph})
        ON CONFLICT (ip) DO UPDATE SET
            sede=EXCLUDED.sede, area=EXCLUDED.area, zona=EXCLUDED.zona,
            estado=EXCLUDED.estado, modelo_inv=EXCLUDED.modelo_inv,
            contador=EXCLUDED.contador, {sup}, updated_at=NOW()
    """
    ok = 0
    with get_db(pool) as conn:
        cur = conn.cursor()
        for _, row in df.iterrows():
            ip = _s(row.get("IP"))
            if not ip:
                continue
            cur.execute(sql, [
                ip, _s(row.get("SEDE")), _s(row.get("AREA")),
                _s(row.get("ZONA")), _s(row.get("ESTADO")), _s(row.get("MODELO_INV")),
                _f(row.get("CONTADOR")),
                *[_f(row.get(c)) for c in SUPPLY_COLS],
            ])
            ok += 1
    print(f"[OK] estado_actual: {ok} impresoras migradas")

# -- MIGRAR HISTORIAL ----------------------------------------------------------
def reducir(dh: pd.DataFrame) -> pd.DataFrame:
    ts_col = "TIMESTAMP" if "TIMESTAMP" in dh.columns else "FECHA"
    dh = dh.copy()
    dh["_ts"]    = pd.to_datetime(dh[ts_col], errors="coerce")
    dh = dh.dropna(subset=["_ts"])
    dh["_fecha"] = dh["_ts"].dt.date
    dh["_hora"]  = dh["_ts"].dt.hour
    dh = dh.sort_values("_ts").groupby(["IP", "_fecha", "_hora"], as_index=False).last()
    return dh

def migrar_historial(pool, df: pd.DataFrame):
    if df.empty:
        print("  historial: hoja vacía, nada que migrar")
        return

    print(f"  Procesando {len(df)} filas del sheet...")
    dh = reducir(df)
    print(f"  Tras deduplicar (1/IP/hora): {len(dh)} filas")

    sc  = ", ".join(c.lower() for c in SUPPLY_COLS)
    sph = ", ".join(["%s"] * len(SUPPLY_COLS))
    sup = ", ".join(f"{c.lower()} = EXCLUDED.{c.lower()}" for c in SUPPLY_COLS)
    sql = f"""
        INSERT INTO historial
            (ip, fecha, hora, timestamp, sede, estado, contador, {sc})
        VALUES (%s, %s, %s, %s, %s, %s, %s, {sph})
        ON CONFLICT (ip, fecha, hora) DO UPDATE SET
            timestamp=EXCLUDED.timestamp, estado=EXCLUDED.estado,
            contador=EXCLUDED.contador, {sup}
    """

    ok = err = 0
    BATCH = 500
    rows = dh.to_dict("records")

    with get_db(pool) as conn:
        cur = conn.cursor()
        for i, row in enumerate(rows):
            ts_raw = row.get("_ts") or row.get("TIMESTAMP") or row.get("FECHA") or ""
            if not ts_raw:
                err += 1; continue
            try:
                ts_dt = pd.to_datetime(ts_raw)
            except Exception:
                err += 1; continue
            ip = _s(row.get("IP"))
            if not ip:
                err += 1; continue
            try:
                cur.execute(sql, [
                    ip,
                    ts_dt.date(), int(ts_dt.hour), ts_dt.to_pydatetime(),
                    _s(row.get("SEDE")), _s(row.get("ESTADO")),
                    _f(row.get("CONTADOR")),
                    *[_f(row.get(c)) for c in SUPPLY_COLS],
                ])
                ok += 1
            except Exception as e:
                err += 1
                print(f"  Fila {i}: {e}")

            if (i + 1) % BATCH == 0:
                conn.commit()
                print(f"  ... {i+1}/{len(rows)} filas procesadas")

    print(f"[OK] historial: {ok} filas insertadas, {err} errores")

# -- MAIN ----------------------------------------------------------------------
def main():
    if not DATABASE_URL:
        print("ERROR: DATABASE_URL no está configurado en .env")
        sys.exit(1)
    if not CRED_PATH.exists():
        print(f"ERROR: No se encuentra {CRED_PATH}")
        sys.exit(1)

    print("=" * 55)
    print("  Migracion Google Sheets -> PostgreSQL")
    print("=" * 55)

    # Conectar a PostgreSQL
    print("\n[1/4] Conectando a PostgreSQL...")
    pool = make_pool()
    print("[OK] Conexión OK")

    # Crear tablas
    print("\n[2/4] Inicializando tablas...")
    init_db(pool)

    # Conectar a Google Sheets
    print("\n[3/4] Conectando a Google Sheets...")
    creds = Credentials.from_service_account_file(str(CRED_PATH), scopes=SCOPES)
    gc    = gspread.authorize(creds)
    sh    = gc.open_by_key(SHEET_ID)
    print("[OK] Google Sheets OK")

    # Migrar estado_actual
    print("\n[4/4] Migrando datos...")
    print("\n-- estado_actual --")
    de = pd.DataFrame(sh.worksheet(HOJA_ESTADO).get_all_records())
    migrar_estado(pool, de)

    # Migrar historial completo
    print("\n-- historial --")
    dh = pd.DataFrame(sh.worksheet(HOJA_HIST).get_all_records())
    migrar_historial(pool, dh)

    # Resumen final
    print("\n-- Resumen en PostgreSQL --")
    with get_db(pool) as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM estado_actual")
        n_estado = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM historial")
        n_hist = cur.fetchone()[0]
        cur.execute("SELECT MIN(timestamp), MAX(timestamp) FROM historial")
        rango = cur.fetchone()

    print(f"  Impresoras:      {n_estado}")
    print(f"  Filas historial: {n_hist}")
    if rango[0]:
        print(f"  Rango fechas:    {str(rango[0])[:10]} -> {str(rango[1])[:10]}")

    pool.closeall()
    print("\n[OK] Migración completada exitosamente")

if __name__ == "__main__":
    main()
