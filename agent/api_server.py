"""
API REST para recibir datos del agente Lexmark y escribirlos en PostgreSQL.
Desplegar en Red B (servidor con la BD).

Inicio: uvicorn api_server:app --host 127.0.0.1 --port 8000

Requiere un archivo agent.env en el mismo directorio con:
    AGENT_API_KEY=...
    DB_HOST=localhost
    DB_PORT=5432
    DB_NAME=lexmark_monitor
    DB_USER=lexmark_user
    DB_PASSWORD=...
"""

import gzip
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import List, Optional

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

# ─────────────────────────────────────────────
# CARGAR VARIABLES DESDE agent.env (sin dependencias externas)
# ─────────────────────────────────────────────
def _load_env(filename: str = "agent.env") -> None:
    env_path = Path(__file__).parent / filename
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

# ─────────────────────────────────────────────
# CONFIG — todos los valores sensibles desde entorno
# ─────────────────────────────────────────────
DB_CONFIG = {
    "host":     os.environ.get("DB_HOST",     "localhost"),
    "port":     int(os.environ.get("DB_PORT", "5432")),
    "dbname":   os.environ.get("DB_NAME",     "lexmark_monitor"),
    "user":     os.environ.get("DB_USER",     "lexmark_user"),
    "password": os.environ.get("DB_PASSWORD", ""),
}
API_KEY        = os.environ.get("AGENT_API_KEY", "")
DIAS_HISTORIAL = int(os.environ.get("DIAS_HISTORIAL", "1827"))

if not API_KEY:
    raise RuntimeError("AGENT_API_KEY no configurada en agent.env. El servidor no puede arrancar.")
if not DB_CONFIG["password"]:
    raise RuntimeError("DB_PASSWORD no configurada en agent.env.")

LF = chr(10)

app = FastAPI(title="Agente Lexmark API")


class GzipRequestMiddleware:
    """Descomprime los cuerpos que llegan con Content-Encoding: gzip.

    Starlette no lo hace solo: gzip esta estandarizado para RESPUESTAS, no
    para peticiones, asi que hay que desenvolverlo a mano.

    Importa porque los agentes viven en Red A y suben por un enlace lento:
    la primera sincronizacion de pr_stats son ~485.000 filas y el JSON crudo
    pesa ~326 MB. Comprimido baja a ~30 MB (medido con datos realistas, 10,8x
    -- casi todo el ahorro viene de los 29 nombres de columna repetidos en
    cada fila). Sin esto los lotes tardaban decenas de segundos y la conexion
    se caia a mitad de la subida.

    Si el cuerpo no viene comprimido, no toca nada.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        cabeceras = dict(scope["headers"])
        if cabeceras.get(b"content-encoding", b"").lower() != b"gzip":
            return await self.app(scope, receive, send)

        crudo = b""
        while True:
            mensaje = await receive()
            crudo += mensaje.get("body", b"")
            if not mensaje.get("more_body", False):
                break

        try:
            cuerpo = gzip.decompress(crudo)
        except Exception as e:
            await send({"type": "http.response.start", "status": 400,
                        "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body",
                        "body": f'{{"detail":"cuerpo gzip invalido: {e}"}}'.encode()})
            return

        # Content-Length ya no corresponde al cuerpo descomprimido, y dejar el
        # Content-Encoding haria que capas de mas arriba intenten descomprimir
        # otra vez.
        limpias = [(k, v) for k, v in scope["headers"]
                   if k not in (b"content-encoding", b"content-length")]
        limpias.append((b"content-length", str(len(cuerpo)).encode()))
        scope = dict(scope, headers=limpias)

        entregado = False

        async def receive_descomprimido():
            nonlocal entregado
            if entregado:
                return {"type": "http.disconnect"}
            entregado = True
            return {"type": "http.request", "body": cuerpo, "more_body": False}

        return await self.app(scope, receive_descomprimido, send)


app.add_middleware(GzipRequestMiddleware)


# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────
def get_conn():
    return psycopg.connect(**DB_CONFIG)


def auth(x_api_key: str = Header(...)):
    if x_api_key != API_KEY:
        raise HTTPException(status_code=403, detail="API key inválida")


def parse_num(val: Optional[str]) -> Optional[float]:
    """Convierte '75.5%' → 75.5 | 'N/A' / 'OK' / None → None | '12345' → 12345.0"""
    if not val or val in ("N/A", "OK"):
        return None
    if isinstance(val, str) and val.endswith("%"):
        try:
            return float(val[:-1])
        except ValueError:
            return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def hora_int(hora_str: Optional[str]) -> Optional[int]:
    """'12:59:01' → 12"""
    if not hora_str:
        return None
    try:
        return int(hora_str.split(":")[0])
    except (ValueError, IndexError):
        return None


def parse_ts(ts_str: Optional[str]) -> Optional[datetime]:
    """'2026-05-04 12:59:01' → datetime"""
    if not ts_str:
        return None
    try:
        return datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def clean_serie(val: Optional[str]) -> Optional[str]:
    """'N/A' / vacío → None. Evita que un ciclo donde no se pudo leer el
    serial (impresora vieja, error puntual de SNMP) pise un valor ya
    confirmado -- ver COALESCE en el upsert de estado_actual -- y evita que
    'N/A' viole el índice único parcial de serie_snmp si dos impresoras lo
    reportan igual."""
    if not val:
        return None
    val = val.strip()
    if not val or val.upper() == "N/A":
        return None
    return val


def exigir_series(filas) -> None:
    """La serie es la PRIMARY KEY de estado_actual y la clave del snapshot en
    historial. Una fila sin serie no se puede guardar: con la cadena vacia
    todas las impresoras sin serie colisionarian en la misma fila, pisandose
    entre si. Se rechaza el lote entero antes de escribir nada, para que el
    problema se vea en el CSV de inventario y no quede enterrado en la BD."""
    sin_serie = [f.IP for f in filas if not clean_serie(f.SERIE)]
    if sin_serie:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{len(sin_serie)} fila(s) sin SERIE en inventario2026.csv: "
                f"{', '.join(sin_serie[:10])}"
                f"{' ...' if len(sin_serie) > 10 else ''}. "
                f"La serie es la identidad de la impresora y es obligatoria."
            ),
        )

    vistas, repetidas = set(), set()
    for f in filas:
        serie = clean_serie(f.SERIE)
        if serie in vistas:
            repetidas.add(serie)
        vistas.add(serie)
    if repetidas:
        raise HTTPException(
            status_code=422,
            detail=(
                f"SERIE repetida en inventario2026.csv: "
                f"{', '.join(sorted(repetidas)[:10])}. "
                f"Dos impresoras con la misma serie se fusionarian en una."
            ),
        )


# Claves canónicas de suministro -- las mismas de SUPPLY_COLS en backend/main.py.
SUPPLY_TIPOS = [
    "TONER_NEGRO", "TONER_CIAN", "TONER_MAGENTA", "TONER_AMARILLO",
    "FOTO_NEGRO", "FOTO_CIAN", "FOTO_MAGENTA", "FOTO_AMARILLO",
    "REVELADOR_NEGRO", "KIT_MANTENIMIENTO", "KIT_FUSOR", "CONTENEDOR_DESECHO",
]


def _init_extra_tables(cur):
    """Tablas de identidad/contador/suministros -- solo las escribe este
    servicio, igual que _init_pr_stats() más abajo, así que su DDL vive acá
    y no en backend/main.py."""
    cur.execute("""
        CREATE TABLE IF NOT EXISTS eventos_identidad (
            id           SERIAL PRIMARY KEY,
            ip_anterior  TEXT NOT NULL,
            ip_nueva     TEXT NOT NULL,
            serie_snmp   TEXT NOT NULL,
            detectado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS eventos_contador (
            id                SERIAL PRIMARY KEY,
            ip                TEXT NOT NULL,
            serie_snmp        TEXT,
            contador_anterior REAL NOT NULL,
            contador_nuevo    REAL NOT NULL,
            detectado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS suministros_actual (
            ip                TEXT NOT NULL,
            tipo_suministro   TEXT NOT NULL,
            serie_suministro  TEXT NOT NULL,
            nivel_pct         REAL,
            primera_deteccion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (ip, tipo_suministro)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS suministros_eventos (
            id                        SERIAL PRIMARY KEY,
            ip                        TEXT NOT NULL,
            tipo_suministro           TEXT NOT NULL,
            tipo_evento               TEXT NOT NULL,
            serie_suministro_anterior TEXT,
            serie_suministro_nueva    TEXT,
            ip_origen                 TEXT,
            detectado_en              TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS suministros_actual_serie_idx  ON suministros_actual(serie_suministro)")
    cur.execute("CREATE INDEX IF NOT EXISTS suministros_eventos_ip_idx    ON suministros_eventos(ip)")
    cur.execute("CREATE INDEX IF NOT EXISTS suministros_eventos_serie_idx ON suministros_eventos(serie_suministro_nueva)")
    cur.execute("CREATE INDEX IF NOT EXISTS eventos_contador_ip_idx       ON eventos_contador(ip)")
    cur.execute("CREATE INDEX IF NOT EXISTS eventos_contador_fecha_idx    ON eventos_contador(detectado_en DESC)")


# ─────────────────────────────────────────────
# MODELOS
# ─────────────────────────────────────────────
class FilaImpresora(BaseModel):
    TIMESTAMP:          Optional[str] = None
    FECHA:              Optional[str] = None
    HORA:               Optional[str] = None
    IP:                 str
    ZONA:               Optional[str] = None
    SEDE:               Optional[str] = None
    AREA:               Optional[str] = None
    MODELO_INV:         Optional[str] = None
    TIPO:               Optional[str] = None
    SERIE:              Optional[str] = None
    CONEXION:           Optional[str] = None
    ESTADO:             Optional[str] = None
    MODELO_SNMP:        Optional[str] = None
    SERIE_SNMP:         Optional[str] = None
    CONTADOR:           Optional[str] = None
    TONER_NEGRO:        Optional[str] = None
    TONER_CIAN:         Optional[str] = None
    TONER_MAGENTA:      Optional[str] = None
    TONER_AMARILLO:     Optional[str] = None
    FOTO_NEGRO:         Optional[str] = None
    FOTO_CIAN:          Optional[str] = None
    FOTO_MAGENTA:       Optional[str] = None
    FOTO_AMARILLO:      Optional[str] = None
    REVELADOR_NEGRO:    Optional[str] = None
    KIT_MANTENIMIENTO:  Optional[str] = None
    KIT_FUSOR:          Optional[str] = None
    CONTENEDOR_DESECHO: Optional[str] = None
    # Numero de serie de cada suministro/cartucho -- pendiente del OID real
    # (ver agent/v2/drivers/lexmark.py), el agente v2 los envia como "N/A"
    # hasta confirmarlo. Optional para no romper al agente v1 (no los envia).
    TONER_NEGRO_SERIE:        Optional[str] = None
    TONER_CIAN_SERIE:         Optional[str] = None
    TONER_MAGENTA_SERIE:      Optional[str] = None
    TONER_AMARILLO_SERIE:     Optional[str] = None
    FOTO_NEGRO_SERIE:         Optional[str] = None
    FOTO_CIAN_SERIE:          Optional[str] = None
    FOTO_MAGENTA_SERIE:       Optional[str] = None
    FOTO_AMARILLO_SERIE:      Optional[str] = None
    REVELADOR_NEGRO_SERIE:    Optional[str] = None
    KIT_MANTENIMIENTO_SERIE:  Optional[str] = None
    KIT_FUSOR_SERIE:          Optional[str] = None
    CONTENEDOR_DESECHO_SERIE: Optional[str] = None


class Payload(BaseModel):
    filas: List[FilaImpresora]


# ─────────────────────────────────────────────
# ENDPOINTS
# ─────────────────────────────────────────────
@app.get("/health")
def health():
    try:
        conn = get_conn()
        conn.close()
        return {"status": "ok", "db": "conectada"}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"BD no disponible: {e}")


_ESTADO_ACTUAL_UPSERT = """
    INSERT INTO estado_actual (
        ip, sede, area, zona, estado,
        modelo_inv, tipo, serie, conexion, modelo_snmp, serie_snmp,
        fecha, hora,
        contador,
        toner_negro, toner_cian, toner_magenta, toner_amarillo,
        foto_negro, foto_cian, foto_magenta, foto_amarillo,
        revelador_negro, kit_mantenimiento, kit_fusor, contenedor_desecho
    ) VALUES (
        %s, %s, %s, %s, %s,
        %s, %s, %s, %s, %s, %s,
        %s, %s,
        %s,
        %s, %s, %s, %s,
        %s, %s, %s, %s,
        %s, %s, %s, %s
    )
    -- Conflicto por SERIE, no por ip: la serie es la identidad estable del
    -- equipo. Asi, si la impresora cambia de ip, se ACTUALIZA su fila (y con
    -- ella la columna ip) en vez de crear una nueva y dejar la vieja colgada.
    ON CONFLICT (serie) DO UPDATE SET
        ip                 = EXCLUDED.ip,
        sede               = EXCLUDED.sede,
        area               = EXCLUDED.area,
        zona               = EXCLUDED.zona,
        estado             = EXCLUDED.estado,
        modelo_inv         = EXCLUDED.modelo_inv,
        tipo               = EXCLUDED.tipo,
        conexion           = EXCLUDED.conexion,
        modelo_snmp        = EXCLUDED.modelo_snmp,
        serie_snmp         = COALESCE(EXCLUDED.serie_snmp, estado_actual.serie_snmp),
        fecha              = EXCLUDED.fecha,
        hora               = EXCLUDED.hora,
        contador           = EXCLUDED.contador,
        toner_negro        = EXCLUDED.toner_negro,
        toner_cian         = EXCLUDED.toner_cian,
        toner_magenta      = EXCLUDED.toner_magenta,
        toner_amarillo     = EXCLUDED.toner_amarillo,
        foto_negro         = EXCLUDED.foto_negro,
        foto_cian          = EXCLUDED.foto_cian,
        foto_magenta       = EXCLUDED.foto_magenta,
        foto_amarillo      = EXCLUDED.foto_amarillo,
        revelador_negro    = EXCLUDED.revelador_negro,
        kit_mantenimiento  = EXCLUDED.kit_mantenimiento,
        kit_fusor          = EXCLUDED.kit_fusor,
        contenedor_desecho = EXCLUDED.contenedor_desecho,
        updated_at         = now()
"""


@app.get("/inventario", response_class=PlainTextResponse)
def get_inventario(_=Depends(auth)):
    """Devuelve el inventario vigente como CSV, para que el agente lo guarde
    y lo use en vez de un archivo editado a mano en Red A.

    Mismas columnas y mismo orden que el inventario2026.csv de siempre, asi
    que el agente no necesita cambiar como lo lee.

    Se sirven solo las filas activas: desactivar una impresora en el
    dashboard la saca del ciclo sin perder su historial ni su ficha.
    """
    import csv
    import io as _io

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('inventario')")
            if cur.fetchone()[0] is None:
                # backend/main.py todavia no creo la tabla
                raise HTTPException(status_code=503,
                                    detail="El inventario aun no esta inicializado.")
            cur.execute("""SELECT ip, zona, sede, area, modelo, tipo, serie, conexion
                             FROM inventario
                            WHERE activo AND serie <> ''
                            ORDER BY sede, area, serie""")
            filas = cur.fetchall()
    finally:
        conn.close()

    buf = _io.StringIO()
    w = csv.writer(buf, lineterminator=LF)
    w.writerow(["IP", "ZONA", "SEDE", "AREA", "MODELO", "TIPO", "SERIE", "CONEXION"])
    w.writerows(filas)
    return PlainTextResponse(buf.getvalue(), media_type="text/csv")


@app.post("/estado_actual")
def post_estado_actual(payload: Payload, _=Depends(auth)):
    """UPSERT en estado_actual — una fila por SERIE, se actualiza en cada ciclo.
    Ademas: detecta el mismo serie_snmp bajo otra IP (eventos_identidad),
    caidas del contador de paginas (eventos_contador), y altas/cambios/
    movimientos de suministros por numero de serie (suministros_actual /
    suministros_eventos). Los campos de identidad/suministro son opcionales
    -- el agente v1 (sin estos campos) sigue funcionando igual que hoy."""

    exigir_series(payload.filas)

    ips = [f.IP for f in payload.filas]
    series_snmp_nuevas = list({s for f in payload.filas if (s := clean_serie(f.SERIE_SNMP))})
    series_suministro_nuevas = list({
        s
        for f in payload.filas
        for tipo in SUPPLY_TIPOS
        if (s := clean_serie(getattr(f, f"{tipo}_SERIE", None)))
    })

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                _init_extra_tables(cur)

                prev_by_ip = {}
                if ips:
                    cur.execute(
                        "SELECT ip, contador, serie_snmp FROM estado_actual WHERE ip = ANY(%s)",
                        (ips,),
                    )
                    prev_by_ip = {ip: (contador, serie) for ip, contador, serie in cur.fetchall()}

                ip_by_serie_snmp = {}
                if series_snmp_nuevas:
                    cur.execute(
                        "SELECT ip, serie_snmp FROM estado_actual WHERE serie_snmp = ANY(%s)",
                        (series_snmp_nuevas,),
                    )
                    ip_by_serie_snmp = dict(cur.fetchall())

                slot_previo = {}
                if ips:
                    cur.execute(
                        "SELECT ip, tipo_suministro, serie_suministro FROM suministros_actual WHERE ip = ANY(%s)",
                        (ips,),
                    )
                    slot_previo = {(ip, tipo): serie for ip, tipo, serie in cur.fetchall()}

                ubicacion_por_serie = {}
                if series_suministro_nuevas:
                    cur.execute(
                        "SELECT ip, tipo_suministro, serie_suministro FROM suministros_actual WHERE serie_suministro = ANY(%s)",
                        (series_suministro_nuevas,),
                    )
                    ubicacion_por_serie = {serie: (ip, tipo) for ip, tipo, serie in cur.fetchall()}

                eventos_identidad   = []
                eventos_contador     = []
                eventos_suministro   = []
                upsert_suministros   = []
                borrar_slots_origen  = set()

                for f in payload.filas:
                    serie_snmp = clean_serie(f.SERIE_SNMP)
                    if serie_snmp:
                        ip_previa = ip_by_serie_snmp.get(serie_snmp)
                        if ip_previa and ip_previa != f.IP:
                            eventos_identidad.append((ip_previa, f.IP, serie_snmp))

                    prev = prev_by_ip.get(f.IP)
                    contador_nuevo = parse_num(f.CONTADOR)
                    if prev and prev[0] is not None and contador_nuevo is not None and contador_nuevo < prev[0]:
                        eventos_contador.append((f.IP, serie_snmp, prev[0], contador_nuevo))

                    for tipo in SUPPLY_TIPOS:
                        serie_nueva = clean_serie(getattr(f, f"{tipo}_SERIE", None))
                        if not serie_nueva:
                            continue
                        nivel_pct = parse_num(getattr(f, tipo, None))
                        serie_anterior_local = slot_previo.get((f.IP, tipo))

                        if serie_anterior_local != serie_nueva:
                            ubicacion_previa = ubicacion_por_serie.get(serie_nueva)
                            if serie_anterior_local is None and ubicacion_previa and ubicacion_previa[0] != f.IP:
                                eventos_suministro.append(
                                    (f.IP, tipo, "MOVIMIENTO", serie_anterior_local, serie_nueva, ubicacion_previa[0])
                                )
                                borrar_slots_origen.add(ubicacion_previa)
                            elif serie_anterior_local is None:
                                eventos_suministro.append((f.IP, tipo, "ALTA", None, serie_nueva, None))
                            else:
                                eventos_suministro.append(
                                    (f.IP, tipo, "CAMBIO", serie_anterior_local, serie_nueva, None)
                                )

                        upsert_suministros.append((f.IP, tipo, serie_nueva, nivel_pct))

                if eventos_identidad:
                    cur.executemany(
                        "INSERT INTO eventos_identidad (ip_anterior, ip_nueva, serie_snmp) VALUES (%s, %s, %s)",
                        eventos_identidad,
                    )
                if eventos_contador:
                    cur.executemany(
                        "INSERT INTO eventos_contador (ip, serie_snmp, contador_anterior, contador_nuevo) "
                        "VALUES (%s, %s, %s, %s)",
                        eventos_contador,
                    )
                if eventos_suministro:
                    cur.executemany(
                        """INSERT INTO suministros_eventos
                               (ip, tipo_suministro, tipo_evento, serie_suministro_anterior,
                                serie_suministro_nueva, ip_origen)
                           VALUES (%s, %s, %s, %s, %s, %s)""",
                        eventos_suministro,
                    )
                for ip_origen, tipo_origen in borrar_slots_origen:
                    cur.execute(
                        "DELETE FROM suministros_actual WHERE ip = %s AND tipo_suministro = %s",
                        (ip_origen, tipo_origen),
                    )
                if upsert_suministros:
                    cur.executemany(
                        """INSERT INTO suministros_actual (ip, tipo_suministro, serie_suministro, nivel_pct)
                           VALUES (%s, %s, %s, %s)
                           ON CONFLICT (ip, tipo_suministro) DO UPDATE SET
                               serie_suministro = EXCLUDED.serie_suministro,
                               nivel_pct        = EXCLUDED.nivel_pct,
                               actualizado_en   = NOW()""",
                        upsert_suministros,
                    )

                records = [(
                    f.IP, f.SEDE, f.AREA, f.ZONA, f.ESTADO,
                    f.MODELO_INV, f.TIPO, f.SERIE, f.CONEXION, f.MODELO_SNMP,
                    clean_serie(f.SERIE_SNMP),
                    f.FECHA, hora_int(f.HORA),
                    parse_num(f.CONTADOR),
                    parse_num(f.TONER_NEGRO), parse_num(f.TONER_CIAN),
                    parse_num(f.TONER_MAGENTA), parse_num(f.TONER_AMARILLO),
                    parse_num(f.FOTO_NEGRO), parse_num(f.FOTO_CIAN),
                    parse_num(f.FOTO_MAGENTA), parse_num(f.FOTO_AMARILLO),
                    parse_num(f.REVELADOR_NEGRO), parse_num(f.KIT_MANTENIMIENTO),
                    parse_num(f.KIT_FUSOR), parse_num(f.CONTENEDOR_DESECHO),
                ) for f in payload.filas]

                cur.executemany(_ESTADO_ACTUAL_UPSERT, records)
    finally:
        conn.close()

    return {"ok": True, "filas": len(payload.filas)}


@app.post("/historial")
def post_historial(payload: Payload, _=Depends(auth)):
    """INSERT en historial con UPSERT por (serie, fecha, hora) y purga de registros antiguos."""
    exigir_series(payload.filas)
    fecha_limite = (date.today() - timedelta(days=DIAS_HISTORIAL)).strftime("%Y-%m-%d")

    query = """
        INSERT INTO historial (
            ip, fecha, hora, timestamp,
            sede, zona, area, modelo_inv, tipo, serie, conexion, modelo_snmp, serie_snmp,
            estado, contador,
            toner_negro, toner_cian, toner_magenta, toner_amarillo,
            foto_negro, foto_cian, foto_magenta, foto_amarillo,
            revelador_negro, kit_mantenimiento, kit_fusor, contenedor_desecho
        ) VALUES (
            %s, %s, %s, %s,
            %s, %s, %s, %s, %s, %s, %s, %s, %s,
            %s, %s,
            %s, %s, %s, %s,
            %s, %s, %s, %s,
            %s, %s, %s, %s
        )
        ON CONFLICT (serie, fecha, hora) DO UPDATE SET
            ip                 = EXCLUDED.ip,
            timestamp          = EXCLUDED.timestamp,
            serie_snmp         = EXCLUDED.serie_snmp,
            estado             = EXCLUDED.estado,
            contador           = EXCLUDED.contador,
            toner_negro        = EXCLUDED.toner_negro,
            toner_cian         = EXCLUDED.toner_cian,
            toner_magenta      = EXCLUDED.toner_magenta,
            toner_amarillo     = EXCLUDED.toner_amarillo,
            foto_negro         = EXCLUDED.foto_negro,
            foto_cian          = EXCLUDED.foto_cian,
            foto_magenta       = EXCLUDED.foto_magenta,
            foto_amarillo      = EXCLUDED.foto_amarillo,
            revelador_negro    = EXCLUDED.revelador_negro,
            kit_mantenimiento  = EXCLUDED.kit_mantenimiento,
            kit_fusor          = EXCLUDED.kit_fusor,
            contenedor_desecho = EXCLUDED.contenedor_desecho
    """

    records = [(
        f.IP, f.FECHA, hora_int(f.HORA), parse_ts(f.TIMESTAMP),
        f.SEDE, f.ZONA, f.AREA, f.MODELO_INV, f.TIPO, f.SERIE, f.CONEXION, f.MODELO_SNMP,
        clean_serie(f.SERIE_SNMP),
        f.ESTADO, parse_num(f.CONTADOR),
        parse_num(f.TONER_NEGRO), parse_num(f.TONER_CIAN),
        parse_num(f.TONER_MAGENTA), parse_num(f.TONER_AMARILLO),
        parse_num(f.FOTO_NEGRO), parse_num(f.FOTO_CIAN),
        parse_num(f.FOTO_MAGENTA), parse_num(f.FOTO_AMARILLO),
        parse_num(f.REVELADOR_NEGRO), parse_num(f.KIT_MANTENIMIENTO),
        parse_num(f.KIT_FUSOR), parse_num(f.CONTENEDOR_DESECHO),
    ) for f in payload.filas]

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM historial WHERE fecha < %s", (fecha_limite,))
                cur.executemany(query, records)
    finally:
        conn.close()

    return {"ok": True, "filas": len(payload.filas)}


# ─────────────────────────────────────────────
# PR_STATS — trabajos de impresion desde Firebird
# ─────────────────────────────────────────────
class FilaPrStats(BaseModel):
    ID:                   Optional[str] = None
    SITE:                 Optional[str] = None
    SUBMITIP:             Optional[str] = None
    USERID:               Optional[str] = None
    PRINTJOBNAME:         Optional[str] = None
    SUBMITDATE:           Optional[str] = None
    FINALDATE:            Optional[str] = None
    FINALACTION:          Optional[str] = None
    FINALSITE:            Optional[str] = None
    NUMPAGES:             Optional[str] = None
    RELEASEIP:            Optional[str] = None
    RELEASEUSERID:        Optional[str] = None
    RELEASEMETHOD:        Optional[str] = None
    PRINTJOBCOLOR:        Optional[str] = None
    PRINTJOBDUPLEX:       Optional[str] = None
    PRINTJOBPAPERSIZE:    Optional[str] = None
    RELEASEMODEL:         Optional[str] = None
    RELEASEMODELTYPE:     Optional[str] = None
    RELEASEHOSTNAME:      Optional[str] = None
    DESTINATION:          Optional[str] = None
    PROFILE:              Optional[str] = None
    CUSTOM1:              Optional[str] = None
    CUSTOM2:              Optional[str] = None
    CUSTOM3:              Optional[str] = None
    SERIALNUMBER:         Optional[str] = None
    JOBFILESIZE:          Optional[str] = None
    DISPLAYJOBFILESIZE:   Optional[str] = None
    SUBMITDATEUTC:        Optional[str] = None
    FINALDATEUTC:         Optional[str] = None


class PayloadPrStats(BaseModel):
    filas: List[FilaPrStats]


def _parse_ts(val: Optional[str]) -> Optional[datetime]:
    if not val:
        return None
    try:
        return datetime.strptime(val, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None

def _parse_int(val: Optional[str]) -> Optional[int]:
    if val is None:
        return None
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None

def _init_pr_stats(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS pr_stats (
            id                 BIGINT PRIMARY KEY,
            site               TEXT,
            submitip           TEXT,
            userid             TEXT,
            printjobname       TEXT,
            submitdate         TIMESTAMP,
            finaldate          TIMESTAMP,
            finalaction        TEXT,
            finalsite          TEXT,
            numpages           INTEGER,
            releaseip          TEXT,
            releaseuserid      TEXT,
            releasemethod      TEXT,
            printjobcolor      TEXT,
            printjobduplex     TEXT,
            printjobpapersize  TEXT,
            releasemodel       TEXT,
            releasemodeltype   TEXT,
            releasehostname    TEXT,
            destination        TEXT,
            profile            TEXT,
            custom1            TEXT,
            custom2            TEXT,
            custom3            TEXT,
            serialnumber       TEXT,
            jobfilesize        BIGINT,
            displayjobfilesize TEXT,
            submitdateutc      TIMESTAMP,
            finaldateutc       TIMESTAMP
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS pr_stats_userid_idx ON pr_stats(userid)")
    cur.execute("CREATE INDEX IF NOT EXISTS pr_stats_submit_idx ON pr_stats(submitdate)")
    cur.execute("CREATE INDEX IF NOT EXISTS pr_stats_model_idx  ON pr_stats(releasemodel)")
    cur.execute("CREATE INDEX IF NOT EXISTS pr_stats_site_idx   ON pr_stats(site)")


@app.post("/pr_stats")
def post_pr_stats(payload: PayloadPrStats, _=Depends(auth)):
    """UPSERT de trabajos de impresion desde Firebird PR_STATS."""
    query = """
        INSERT INTO pr_stats (
            id, site, submitip, userid, printjobname,
            submitdate, finaldate, finalaction, finalsite, numpages,
            releaseip, releaseuserid, releasemethod,
            printjobcolor, printjobduplex, printjobpapersize,
            releasemodel, releasemodeltype, releasehostname,
            destination, profile, custom1, custom2, custom3,
            serialnumber, jobfilesize, displayjobfilesize,
            submitdateutc, finaldateutc
        ) VALUES (
            %s, %s, %s, %s, %s,
            %s, %s, %s, %s, %s,
            %s, %s, %s,
            %s, %s, %s,
            %s, %s, %s,
            %s, %s, %s, %s, %s,
            %s, %s, %s,
            %s, %s
        )
        ON CONFLICT (id) DO NOTHING
    """

    records = [(
        _parse_int(f.ID), f.SITE, f.SUBMITIP, f.USERID, f.PRINTJOBNAME,
        _parse_ts(f.SUBMITDATE), _parse_ts(f.FINALDATE), f.FINALACTION,
        f.FINALSITE, _parse_int(f.NUMPAGES),
        f.RELEASEIP, f.RELEASEUSERID, f.RELEASEMETHOD,
        f.PRINTJOBCOLOR, f.PRINTJOBDUPLEX, f.PRINTJOBPAPERSIZE,
        f.RELEASEMODEL, f.RELEASEMODELTYPE, f.RELEASEHOSTNAME,
        f.DESTINATION, f.PROFILE, f.CUSTOM1, f.CUSTOM2, f.CUSTOM3,
        f.SERIALNUMBER, _parse_int(f.JOBFILESIZE), f.DISPLAYJOBFILESIZE,
        _parse_ts(f.SUBMITDATEUTC), _parse_ts(f.FINALDATEUTC),
    ) for f in payload.filas if f.ID]

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                _init_pr_stats(cur)
                cur.executemany(query, records)
    finally:
        conn.close()

    return {"ok": True, "filas": len(records)}
