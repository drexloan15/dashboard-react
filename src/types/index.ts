export interface Printer {
  /** Identidad estable de la impresora: la IP cambia, la serie no.
   *  Es la clave con la que el backend la reconoce entre ciclos. */
  SERIE: string;
  IP: string;
  SEDE: string;
  AREA?: string;
  ZONA?: string;
  ESTADO: "Online" | "Offline";
  MODELO_INV?: string;
  CONTADOR?: string | number;
  TONER_NEGRO?: string | number;
  TONER_CIAN?: string | number;
  TONER_MAGENTA?: string | number;
  TONER_AMARILLO?: string | number;
  FOTO_NEGRO?: string | number;
  FOTO_CIAN?: string | number;
  FOTO_MAGENTA?: string | number;
  FOTO_AMARILLO?: string | number;
  REVELADOR_NEGRO?: string | number;
  KIT_MANTENIMIENTO?: string | number;
  KIT_FUSOR?: string | number;
  CONTENEDOR_DESECHO?: string | number;
  [key: string]: unknown;
}

export interface HistorialRow {
  SERIE?: string;
  TIMESTAMP?: string;
  FECHA?: string;
  IP: string;
  SEDE?: string;
  AREA?: string;
  ESTADO?: string;
  CONTADOR?: string | number;
  TONER_NEGRO?: string | number;
  TONER_CIAN?: string | number;
  TONER_MAGENTA?: string | number;
  TONER_AMARILLO?: string | number;
  FOTO_NEGRO?: string | number;
  FOTO_CIAN?: string | number;
  FOTO_MAGENTA?: string | number;
  FOTO_AMARILLO?: string | number;
  REVELADOR_NEGRO?: string | number;
  KIT_MANTENIMIENTO?: string | number;
  KIT_FUSOR?: string | number;
  CONTENEDOR_DESECHO?: string | number;
  _ts?: string;
  _fecha?: string;
  [key: string]: unknown;
}

export interface DashData {
  estado: Printer[];
  historial: HistorialRow[];
  ts: string;
}

export type Page = "overview" | "mapa" | "sedes" | "alertas" | "historial" | "analiticas" | "usuarios" | "solicitudes" | "inventario";

/** Fila del inventario: define QUE impresoras se monitorean.
 *  El agente descarga esta lista en cada ciclo y reescribe su CSV local. */
export interface InventarioItem {
  serie:      string;   // identidad; no se puede cambiar sin borrar y recrear
  ip:         string;
  sede:       string;
  area:       string;
  zona:       string;
  modelo:     string;
  tipo:       string;
  conexion:   string;
  activo:     boolean;  // false = sigue en la ficha pero sale del ciclo
  updated_at: string;
  updated_by: string;
}

export interface SolicitudSuministro {
  id:            number;
  printer_ip:    string;
  sede?:         string;
  area?:         string;
  modelo?:       string;
  suministros:   string[];
  to_email:      string;
  notas?:        string;
  reportado_por: string;
  created_at:    string;
}

export interface PrStatsTotales { jobs: number; pages: number; users: number; }
export interface PrStatsUsuario { userid: string; jobs: number; pages: number; }
export interface PrStatsDia     { fecha: string; pages: number; jobs: number; }
export interface PrStatsSede    { site: string; pages: number; jobs: number; users: number; }
export interface PrStatsModelo  { releasemodel: string; pages: number; jobs: number; }
export interface PrStatsJob {
  printjobname: string;
  numpages: number;
  submitdate: string;
  finalaction: string;
  site: string;
  releasemodel: string;
}
export interface PrStatsUsuarioDetail {
  userid: string;
  jobs: PrStatsJob[];
  por_dia: PrStatsDia[];
  por_tipo: { tipo: string; jobs: number; pages: number }[];
}

export interface PrStatsData {
  exists: boolean;
  totales?: PrStatsTotales;
  top_usuarios?: PrStatsUsuario[];
  por_dia?: PrStatsDia[];
  por_sede?: PrStatsSede[];
  por_modelo?: PrStatsModelo[];
  ts?: string;
}

export type AlertaEstado = "listo" | "enviado";
export type AlertasStatusMap = Record<string, AlertaEstado>;

export const SUMINISTROS: [string, string][] = [
  ["TONER_NEGRO",       "Tóner Negro"],
  ["TONER_CIAN",        "Tóner Cián"],
  ["TONER_MAGENTA",     "Tóner Magenta"],
  ["TONER_AMARILLO",    "Tóner Amarillo"],
  ["FOTO_NEGRO",        "Fotoconductor Negro"],
  ["FOTO_CIAN",         "Fotoconductor Cián"],
  ["FOTO_MAGENTA",      "Fotoconductor Magenta"],
  ["FOTO_AMARILLO",     "Fotoconductor Amarillo"],
  ["REVELADOR_NEGRO",   "Revelador Negro"],
  ["KIT_MANTENIMIENTO", "Kit Mantenimiento"],
  ["KIT_FUSOR",         "Kit Fusor"],
  ["CONTENEDOR_DESECHO","Contenedor Desecho"],
];

export const COORDS_SEDES: Record<string, [number, number]> = {
  VENEZUELA:     [-12.058203058918116, -77.0727353215558],
  ECUADOR:       [-12.039383529660206, -77.04624551718892],
  AVENAS:        [-12.04196380353077,  -77.0662945494849],
  CAJAMARQUILLA: [-11.970205778652993, -76.88831705276655],
  TODINNO:       [-12.013863708908742, -76.92024606748218],
  LURIN:         [-12.243716492402129, -76.81101496788602],
  "LOS OLIVOS":  [-11.957107022065903, -77.06787484876142],
  AREQUIPA:      [-16.258902401876686, -71.31837137108724],
  CHICLAYO:      [-6.795172064881105,  -79.85933466722301],
  CUZCO:         [-13.53321037524382,  -71.94218925713335],
  CUSCO:         [-13.53321037524382,  -71.94218925713335],
  HUANCAYO:      [-12.04421649832481,  -75.22764475345953],
  HUANUCO:       [-9.906352927931826,  -76.22423724369617],
  ICA:           [-14.103310504674079, -75.71792986876754],
  PIURA:         [-5.157782828201317,  -80.69162321218813],
  TARMA:         [-11.423235125703798, -75.69220405346923],
  TRUJILLO:      [-8.142236564373668,  -79.01440715906142],
};

// ── ANALÍTICA (endpoint /analitica) ───────────────────────────────────────────
// Todo esto se calcula en el backend sobre pr_stats. No se agrega en el
// navegador a propósito: son ~495 mil trabajos, no pueden viajar hasta acá.

// Un trabajo o llegó al papel o no llegó. Lo que no llegó NO es "desperdicio":
// si no se imprimió, no se gastó papel ni tóner. Es un indicador operativo
// —cuánta fricción hay entre pedir una impresión y obtenerla— no uno de costo.

export interface AnaTotales {
  trabajos: number; paginas: number;
  /** Llegó al papel. */
  impresas: number;
  /** No llegó al papel. Suma de las tres causas de abajo. */
  no_impresas: number;
  /** Causa DESCONOCIDA. Es la mayoría. Solo consta que no se imprimió: su
   *  finaldate viene copiado del submitdate, y se comporta distinto en cada
   *  entorno de LPM. No inventarle una causa. */
  sin_liberar: number;
  /** Retención de 48 h agotada y nadie lo tocó nunca — sin usuario, IP ni
   *  equipo de liberación registrados. Esto sí está comprobado. */
  expiradas: number;
  /** Alguien identificado actuó sobre el trabajo (mediana 23 min). */
  eliminadas: number;
  color: number; duplex: number;
  pct_no_impresas: number;
  usuarios: number; dias: number;
  desde: string | null; hasta: string | null;
}

/** Fila de cualquier desglose (sede, zona o entorno LPM). La clave que la
 *  identifica cambia de nombre según la dimensión. */
export interface AnaGrupo {
  sede?: string; zona?: string; entorno?: string;
  trabajos: number; paginas: number; impresas: number; no_impresas: number;
  sin_liberar: number; expiradas: number; eliminadas: number;
  color: number; duplex: number;
  pct_no_impresas: number;
}

export interface AnaDow {
  dow: number; nombre: string; impresas: number; dias: number; promedio: number;
}

export interface AnaMes {
  mes: string; impresas: number; no_impresas: number; pct_no_impresas: number;
}

export interface AnaUsuarioNoImpresas {
  userid: string; no_impresas: number; impresas: number;
  trabajos_no_impresos: number; pct: number;
}

export interface AnaPronosticoDia {
  fecha: string; dow: number; nombre: string; paginas: number; muestra_n: number;
}

export interface AnaBacktest {
  suficiente: boolean;
  dias?: number; mae?: number; mape?: number | null; mape_n?: number;
  requiere_dias?: number; tiene_dias?: number;
}

export interface AnaSerie {
  pronostico: AnaPronosticoDia[];
  backtest: AnaBacktest;
}

export interface AnaSuministro {
  serie: string; ip: string; sede: string; area: string;
  modelo: string; estado: string;
  suministro: string; etiqueta: string;
  nivel: number; pag_dia: number;
  /** "volumen" = estimado con las páginas reales de esa impresora.
   *  "sin_datos" = no aparece en pr_stats; no se le inventa una tasa. */
  metodo: "volumen" | "sin_datos";
  dias: number | null;
  agotamiento: string | null;
}

export interface AnaliticaData {
  exists: boolean;
  generado?: string;
  regimen?: { desde: string; nota: string };
  descriptiva?: {
    totales: AnaTotales;
    /** Sede REAL, del inventario (cruce por serie). No confundir con el `site`
     *  de LPM: ese no es una ubicación — ver por_lpm. */
    por_sede: AnaGrupo[];
    por_zona: AnaGrupo[];
    /** Los dos entornos de LPM. NO son ubicaciones: cada uno contiene impresoras
     *  de las 16 sedes, y las mismas impresoras aparecen en ambos. Se expone
     *  solo para ver de dónde salen las expiradas y eliminadas. */
    por_lpm: AnaGrupo[];
    por_mes: AnaMes[];
    por_dow: AnaDow[];
    top_no_impresas: AnaUsuarioNoImpresas[];
    modo: {
      color: number; mono: number; duplex: number; simplex: number;
      pct_color: number; pct_duplex: number;
    };
  };
  predictiva?: {
    volumen: {
      horizonte_dias: number;
      global: AnaSerie;
      sedes: Record<string, AnaSerie>;
    };
    suministros: {
      items: AnaSuministro[];
      total: number;
      equipos_sin_volumen: number;
      ventana_dias: number;
      rendimientos: Record<string, number>;
      nota: string;
    };
  };
}
