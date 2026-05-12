"use client";
import { useState } from "react";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import SupplyBar from "@/components/ui/SupplyBar";
import { SUMINISTROS } from "@/types";
import type { Printer, HistorialRow } from "@/types";
import { toNum, nivelColor } from "@/lib/utils";

function Dot({ estado }: { estado: string }) {
  const on = estado === "Online";
  return (
    <span className="inline-block w-2 h-2 rounded-full shrink-0 mr-1.5"
      style={{ background: on ? "#20c97a" : "#f04545" }} />
  );
}

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts.slice(0, 16);
  const fecha = d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
  const hora  = d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
  return `${fecha} ${hora}`;
}

function detectCambios(ip: string, historial: HistorialRow[]): { col: string; label: string; fecha: string }[] {
  const rows = historial
    .filter(r => r.IP === ip && r._ts)
    .sort((a, b) => (a._ts! > b._ts! ? 1 : -1));

  const cambios: { col: string; label: string; fecha: string }[] = [];
  for (const [col, label] of SUMINISTROS) {
    let prev: number | null = null;
    let lastCambio: string | null = null;
    for (const row of rows) {
      const v = toNum(row[col]);
      if (v === null) { prev = null; continue; }
      if (prev !== null && (v > prev + 5 || v < prev - 40)) lastCambio = row._ts!;
      prev = v;
    }
    if (lastCambio) cambios.push({ col, label, fecha: formatTs(lastCambio) });
  }
  return cambios.sort((a, b) => b.fecha.localeCompare(a.fecha));
}

function IPDetail({ p, onBack, onBackSede, sede, historial }: { p: Printer; onBack: () => void; onBackSede: () => void; sede: string; historial: HistorialRow[] }) {
  const ec = p.ESTADO === "Online" ? "#20c97a" : "#f04545";
  const cambios = detectCambios(p.IP, historial);
  return (
    <div>
      <div className="flex items-center gap-1 mb-5 text-[12px]">
        <button onClick={onBackSede} className="text-brand-blue cursor-pointer hover:underline bg-transparent border-none">← Sedes</button>
        <span className="dark:text-dark-muted text-light-muted mx-1">/</span>
        <button onClick={onBack} className="text-brand-blue cursor-pointer hover:underline bg-transparent border-none">{sede}</button>
        <span className="dark:text-dark-muted text-light-muted mx-1">/</span>
        <span className="dark:text-dark-muted text-light-muted">{p.IP}</span>
      </div>
      <h2 className="text-2xl font-bold mb-1 dark:text-dark-text text-light-text">{p.IP}</h2>
      <p className="dark:text-dark-muted text-light-muted mb-6">{p.SEDE} · {p.AREA}</p>

      <div className="flex gap-2.5 mb-5 flex-wrap">
        <Card className="flex-1">
          <div className="text-[9px] dark:text-dark-muted text-light-muted font-bold uppercase mb-2">Estado</div>
          <div className="flex items-center">
            <Dot estado={p.ESTADO} />
            <span className="font-bold text-[15px]" style={{ color: ec }}>{p.ESTADO}</span>
          </div>
        </Card>
        <Card className="flex-[2]">
          <div className="text-[9px] dark:text-dark-muted text-light-muted font-bold uppercase mb-2">Modelo</div>
          <div className="font-semibold text-[13px] text-brand-cyan">{String(p.MODELO_INV || "—").slice(0, 36)}</div>
        </Card>
        <Card className="flex-1">
          <div className="text-[9px] dark:text-dark-muted text-light-muted font-bold uppercase mb-2">Páginas</div>
          <div className="font-bold text-xl text-brand-blue">{p.CONTADOR || "—"}</div>
        </Card>
      </div>

      <Card>
        <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest mb-5">Suministros</p>
        <div className="grid grid-cols-2 gap-x-10">
          {SUMINISTROS.map(([col, label]) => <SupplyBar key={col} label={label} val={toNum(p[col])} />)}
        </div>
      </Card>

      {cambios.length > 0 && (
        <Card className="mt-4">
          <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest mb-4">
            Cambios de suministros detectados
          </p>
          <div className="rounded-lg overflow-hidden dark:border-dark-border border border-light-border">
            {cambios.map((c, i) => (
              <div key={c.col}
                className="flex items-center justify-between px-4 py-2.5 dark:border-dark-border border-b border-light-border last:border-0"
                style={{ animationDelay: `${i * 30}ms` }}>
                <span className="text-[12px] dark:text-dark-text text-light-text">{c.label}</span>
                <span className="text-[11px] font-mono dark:text-dark-muted text-light-muted">{c.fecha}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function SedeList({ printers, sede, onSelectIP, onBack, historial }: { printers: Printer[]; sede: string; onSelectIP: (ip: string) => void; onBack: () => void; historial: HistorialRow[] }) {
  const zona = printers[0]?.ZONA || "";
  return (
    <div>
      <button onClick={onBack} className="text-brand-blue text-[12px] cursor-pointer hover:underline bg-transparent border-none mb-5">
        ← Sedes
      </button>
      <div className="flex items-center gap-3 mb-1">
        <h2 className="text-2xl font-bold dark:text-dark-text text-light-text">{sede}</h2>
        <Badge bg={zona === "Lima" ? "#1f6feb" : "#4a2e90"}>{zona}</Badge>
      </div>
      <p className="dark:text-dark-muted text-light-muted mb-6">{printers.length} impresoras</p>
      <div>
        {printers.sort((a, b) => a.IP.localeCompare(b.IP)).map((p, j) => {
          const mini = SUMINISTROS.map(([col, label]) => {
            const v = toNum(p[col]);
            return v !== null ? { col, label: label.slice(0, 13), v } : null;
          }).filter(Boolean) as { col: string; label: string; v: number }[];
          const cambiosRecientes = detectCambios(p.IP, historial).filter(c => {
            const dias = (Date.now() - new Date(c.fecha).getTime()) / 86400000;
            return dias <= 30;
          }).length;

          return (
            <button key={p.IP} onClick={() => onSelectIP(p.IP)}
              className="row-enter w-full flex items-center dark:bg-dark-card bg-white dark:border-dark-border border-light-border
                border rounded-xl px-4 py-3.5 mb-2 cursor-pointer hover:border-brand-blue/50 transition-colors text-left"
              style={{ animationDelay: `${j * 18}ms` }}>
              <div className="w-52 shrink-0">
                <div className="flex items-center mb-0.5">
                  <Dot estado={p.ESTADO} />
                  <span className="font-mono text-[12px] font-semibold dark:text-dark-text text-light-text">{p.IP}</span>
                </div>
                <div className="text-[11px] dark:text-dark-muted text-light-muted pl-3.5">{String(p.AREA || "").slice(0, 45)}</div>
                {cambiosRecientes > 0 && (
                  <span className="ml-3.5 mt-0.5 inline-block text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-brand-cyan/15 text-brand-cyan">
                    {cambiosRecientes} cambio{cambiosRecientes > 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <div className="flex-1 px-4">
                {mini.length > 0 ? mini.slice(0, 6).map(m => (
                  <div key={m.col} className="flex items-center gap-1 mb-1">
                    <span className="text-[9px] dark:text-dark-muted text-light-muted w-24 shrink-0">{m.label}</span>
                    <div className="w-16 h-[3px] dark:bg-dark-border2 bg-light-border2 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${Math.min(m.v, 100)}%`, background: nivelColor(m.v, "dark") }} />
                    </div>
                    <span className="text-[9px] font-semibold" style={{ color: nivelColor(m.v, "dark") }}>{m.v.toFixed(0)}%</span>
                  </div>
                )) : <span className="text-[10px] dark:text-dark-muted text-light-muted">Sin datos</span>}
              </div>
              <span className="text-brand-blue text-base">›</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function Sedes({ printers, historial = [] }: { printers: Printer[]; historial?: HistorialRow[] }) {
  const [sedeSel, setSedeSel] = useState<string | null>(null);
  const [ipSel, setIpSel] = useState<string | null>(null);

  if (!printers.length) return <p className="dark:text-dark-muted text-light-muted">Sin datos.</p>;

  // Detalle IP
  if (ipSel) {
    const p = printers.find(x => x.IP === ipSel);
    if (!p) return null;
    return <IPDetail p={p} sede={sedeSel || ""} onBack={() => setIpSel(null)} onBackSede={() => { setIpSel(null); setSedeSel(null); }} historial={historial} />;
  }

  // Lista IPs de sede
  if (sedeSel) {
    const df_s = printers.filter(p => p.SEDE === sedeSel);
    return <SedeList printers={df_s} sede={sedeSel} onSelectIP={setIpSel} onBack={() => setSedeSel(null)} historial={historial} />;
  }

  // Grid sedes
  const sedeMap: Record<string, Printer[]> = {};
  for (const p of printers) {
    if (!sedeMap[p.SEDE]) sedeMap[p.SEDE] = [];
    sedeMap[p.SEDE].push(p);
  }

  return (
    <div>
      <h1 className="page-title text-2xl font-bold mb-1 dark:text-dark-text text-light-text">Por Sede</h1>
      <p className="page-title dark:text-dark-muted text-light-muted mb-6" style={{ animationDelay: "50ms" }}>Selecciona una sede para ver detalle</p>
      <div className="flex flex-wrap gap-3">
        {Object.entries(sedeMap).map(([sede, ps], i) => {
          const on  = ps.filter(p => p.ESTADO === "Online").length;
          const ts  = ps.length;
          const pct = ts ? Math.round(on / ts * 100) : 0;
          const zona = ps[0]?.ZONA || "";
          const barColor = pct >= 80 ? "#20c97a" : pct >= 50 ? "#e0b030" : "#f04545";

          // Peor suministro
          let worstVal = Infinity; let worstLabel = "";
          for (const p of ps) {
            for (const [col, label] of SUMINISTROS) {
              const v = toNum(p[col]);
              if (v !== null && v < worstVal) { worstVal = v; worstLabel = label; }
            }
          }

          return (
            <button key={sede} onClick={() => setSedeSel(sede)}
              className="card-enter w-52 dark:bg-dark-card bg-white dark:border-dark-border border-light-border
                border rounded-xl p-4 text-left cursor-pointer hover:border-brand-blue/50 transition-colors"
              style={{ animationDelay: `${i * 60}ms` }}>
              <Badge bg={zona === "Lima" ? "#1f6feb" : "#4a2e90"}>{zona || "?"}</Badge>
              <h3 className="text-[17px] font-bold my-2 dark:text-dark-text text-light-text">{sede}</h3>
              <p className="text-[11px] dark:text-dark-muted text-light-muted">{ts} equipos</p>
              <hr className="dark:border-dark-border border-light-border my-3" />
              <div className="flex justify-around mb-2">
                {[{ v: on, l: "online", c: "#20c97a" }, { v: ts - on, l: "offline", c: "#f04545" }, { v: `${pct}%`, l: "uptime", c: "#3d8ef5" }].map(x => (
                  <div key={x.l} className="text-center">
                    <div className="text-[22px] font-bold leading-none" style={{ color: x.c }}>{x.v}</div>
                    <div className="text-[9px] uppercase dark:text-dark-muted text-light-muted mt-0.5">{x.l}</div>
                  </div>
                ))}
              </div>
              <div className="h-[3px] dark:bg-dark-border2 bg-light-border2 rounded-full mb-2 overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: barColor }} />
              </div>
              {worstVal < Infinity && (
                <p className="text-[9px]">
                  <span className="dark:text-dark-muted text-light-muted">Peor: </span>
                  <span className="font-bold" style={{ color: nivelColor(worstVal, "dark") }}>
                    {worstLabel} {worstVal.toFixed(0)}%
                  </span>
                </p>
              )}
              <p className="text-[9px] text-brand-blue font-bold mt-2.5 text-right">VER ›</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
