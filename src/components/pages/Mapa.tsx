"use client";
import dynamic from "next/dynamic";
import Card from "@/components/ui/Card";
import { COORDS_SEDES } from "@/types";
import type { Printer } from "@/types";
import type { SedeInfo } from "./MapaLeaflet";

const MapaLeaflet = dynamic(() => import("./MapaLeaflet"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full min-h-[520px] dark:text-dark-muted text-light-muted text-sm">
      Cargando mapa…
    </div>
  ),
});

export default function Mapa({ printers }: { printers: Printer[] }) {
  const sedeMap: Record<string, { total: number; online: number }> = {};
  for (const p of printers) {
    if (!sedeMap[p.SEDE]) sedeMap[p.SEDE] = { total: 0, online: 0 };
    sedeMap[p.SEDE].total++;
    if (p.ESTADO === "Online") sedeMap[p.SEDE].online++;
  }

  const rawSedes: SedeInfo[] = Object.entries(sedeMap).flatMap(([sede, v]) => {
    const key = Object.keys(COORDS_SEDES).find(k => k === sede || k === sede.toUpperCase());
    if (!key) return [];
    const [lat, lon] = COORDS_SEDES[key];
    const pct = v.total ? Math.round(v.online / v.total * 100) : 0;
    const offlinePrinters = printers
      .filter(p => p.SEDE === sede && p.ESTADO === "Offline")
      .map(p => ({ ip: p.IP, modelo: String(p.MODELO_INV || "") }));
    return [{ sede, lat, lon, total: v.total, online: v.online,
      offline: v.total - v.online, pct,
      color: pct >= 80 ? "#20c97a" : pct >= 50 ? "#e0b030" : "#f04545",
      offlinePrinters }];
  });

  const totalImp  = rawSedes.reduce((s, x) => s + x.total, 0);
  const totalOn   = rawSedes.reduce((s, x) => s + x.online, 0);
  const pctGlobal = totalImp ? Math.round(totalOn / totalImp * 100) : 0;

  const stats = [
    { label: "Sedes",      value: rawSedes.length,     color: "#3d8ef5" },
    { label: "Impresoras", value: totalImp,             color: "#2ec4d0" },
    { label: "Online",     value: totalOn,              color: "#20c97a" },
    { label: "Offline",    value: totalImp - totalOn,   color: "#f04545" },
    { label: "Uptime",     value: `${pctGlobal}%`,      color: pctGlobal >= 80 ? "#20c97a" : "#e0b030" },
  ];

  return (
    <div>
      <h1 className="page-title text-2xl font-bold mb-1 dark:text-dark-text text-light-text">Mapa de Impresoras</h1>
      <p className="text-[13px] dark:text-dark-muted text-light-muted mb-6">Distribución geográfica en tiempo real</p>

      {/* Stats */}
      <div className="flex gap-2.5 mb-5 flex-wrap">
        {stats.map(s => (
          <Card key={s.label} className="flex-1 min-w-[100px] text-center py-4">
            <div className="text-[32px] font-extrabold leading-none" style={{ color: s.color }}>{s.value}</div>
            <div className="text-[10px] uppercase tracking-widest dark:text-dark-muted text-light-muted mt-1.5 font-semibold">{s.label}</div>
          </Card>
        ))}
      </div>

      <div className="flex gap-3.5 flex-wrap">
        {/* Mapa Leaflet */}
        <Card className="flex-[3] min-w-[500px]">
          <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest mb-3">
            Perú · Distribución nacional
          </p>
          <div className="rounded-xl overflow-hidden" style={{ height: 580 }}>
            <MapaLeaflet sedes={rawSedes} />
          </div>
        </Card>

        {/* Lista sedes */}
        <Card className="flex-1 min-w-[260px]">
          <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest mb-3">
            Sedes ({rawSedes.length})
          </p>
          <div className="overflow-y-auto" style={{ maxHeight: 620 }}>
            {[...rawSedes].sort((a, b) => a.pct - b.pct).map(s => (
              <div key={s.sede}
                className="flex items-center px-3 py-3 dark:border-dark-border border-b border-light-border last:border-0"
                style={{ background: s.color + "08" }}>
                <div className="w-2 h-2 rounded-full shrink-0 mr-2.5" style={{ background: s.color }} />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-[13px] dark:text-dark-text text-light-text truncate">{s.sede}</div>
                  <div className="text-[10px] dark:text-dark-muted text-light-muted">{s.total} equipo{s.total !== 1 ? "s" : ""}</div>
                </div>
                <div className="flex gap-3 items-center shrink-0 ml-2">
                  <div className="text-center">
                    <div className="text-sm font-bold text-brand-green">{s.online}</div>
                    <div className="text-[8px] uppercase dark:text-dark-muted text-light-muted">on</div>
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-bold text-brand-red">{s.offline}</div>
                    <div className="text-[8px] uppercase dark:text-dark-muted text-light-muted">off</div>
                  </div>
                  <div className="text-[15px] font-bold w-12 text-right" style={{ color: s.color }}>{s.pct}%</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
