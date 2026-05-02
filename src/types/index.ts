export interface Printer {
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
  TIMESTAMP?: string;
  FECHA?: string;
  IP: string;
  SEDE?: string;
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

export type Page = "overview" | "mapa" | "sedes" | "alertas" | "historial" | "analiticas";

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
