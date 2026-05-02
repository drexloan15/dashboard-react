"use client";
import { useState, useMemo } from "react";
import Card from "@/components/ui/Card";
import { SUMINISTROS } from "@/types";
import type { Printer, HistorialRow } from "@/types";
import { toNum, nivelColor } from "@/lib/utils";

interface Pred {
  ip: string; sede: string; area: string; modelo: string;
  suministro: string; nivel: number;
  dias: number; tasa: number;
  color: string;
}

function calcPreds(printers: Printer[], historial: HistorialRow[]): { preds: Pred[]; diasUnicos: number } {
  if (!historial.length) return { preds: [], diasUnicos: 0 };

  // Parsear y validar timestamps
  const dh = historial.map(r => ({
    ...r,
    _tsD: new Date(r._ts || r.TIMESTAMP || r.FECHA || ""),
  })).filter(r => !isNaN(r._tsD.getTime()));

  const fechasUnicas = new Set(dh.map(r => r._tsD.toDateString()));
  const diasUnicos = fechasUnicas.size;

  const preds: Pred[] = [];
  const TASA_STD = 0.8; // tasa de caída diaria por defecto (%/día) cuando no hay historial

  for (const [col, label] of SUMINISTROS) {
    for (const p of printers) {
      const curr = toNum(p[col]);
      // Mostrar predicciones para suministros ≤ 50% para adelantarse a los críticos
      if (curr === null || curr > 50) continue;

      const ipRows = dh.filter(r => r.IP === p.IP);
      let tasa = TASA_STD;

      if (ipRows.length >= 2) {
        const sorted = [...ipRows].sort((a, b) => a._tsD.getTime() - b._tsD.getTime());

        // Construir pares (timestamp, nivel) filtrando juntos para evitar desfase de índices.
        // Bug anterior: vals filtraba nulos pero ts no, emparejando niveles con timestamps incorrectos.
        const pairs = sorted
          .map(r => ({ t: r._tsD.getTime(), v: toNum((r as Record<string, unknown>)[col]) }))
          .filter((x): x is { t: number; v: number } => x.v !== null && x.v > 0);

        // Días únicos con datos para ESTA IP (no global)
        const ipDiasUnicos = new Set(sorted.map(r => r._tsD.toDateString())).size;

        if (ipDiasUnicos >= 7 && pairs.length >= 3) {
          // Regresión lineal sobre los datos desde la última reposición detectada
          let start = 0;
          for (let i = pairs.length - 1; i > 0; i--) {
            if (pairs[i].v - pairs[i - 1].v > 20) { start = i; break; }
          }
          const slice = pairs.slice(start);

          if (slice.length >= 2) {
            const n  = slice.length;
            const t0 = slice[0].t;
            const days = slice.map(x => (x.t - t0) / 86400000);
            const vals = slice.map(x => x.v);
            const mx = days.reduce((a, b) => a + b, 0) / n;
            const my = vals.reduce((a, b) => a + b, 0) / n;
            const num = days.reduce((s, x, i) => s + (x - mx) * (vals[i] - my), 0);
            const den = days.reduce((s, x) => s + (x - mx) ** 2, 0);
            if (den > 0) {
              const slope = num / den;
              if (slope < -0.001) tasa = Math.abs(slope);
            }
          }
        } else if (pairs.length >= 2) {
          // Modo simple: diferencia entre primera y última lectura válida
          const first = pairs[0];
          const last  = pairs[pairs.length - 1];
          const dt = (last.t - first.t) / 86400000;
          if (dt > 0 && first.v > last.v) {
            tasa = (first.v - last.v) / dt;
          }
        }
      }

      const dias = tasa > 0 ? curr / tasa : 999;
      if (dias > 120) continue;

      preds.push({
        ip: p.IP, sede: p.SEDE, area: p.AREA || "",
        modelo: String(p.MODELO_INV || ""),
        suministro: label, nivel: Math.round(curr * 10) / 10,
        dias: Math.round(dias * 10) / 10, tasa: Math.round(tasa * 100) / 100,
        color: dias <= 2 ? "#f44336" : dias <= 7 ? "#ff9800" : dias <= 14 ? "#e0b030" : "#20c97a",
      });
    }
  }

  preds.sort((a, b) => a.dias - b.dias);
  return { preds, diasUnicos };
}

export default function PredSection({ printers, historial }: { printers: Printer[]; historial: HistorialRow[] }) {
  const { preds, diasUnicos } = useMemo(() => calcPreds(printers, historial), [printers, historial]);
  
  const [filtroSede, setFiltroSede] = useState<string>("Todas");
  const [filtroSum, setFiltroSum] = useState<string>("Todos");

  const sedes = useMemo(() => Array.from(new Set(preds.map(p => p.sede))).sort(), [preds]);
  const sumins = useMemo(() => Array.from(new Set(preds.map(p => p.suministro))).sort(), [preds]);

  const predsFiltrados = useMemo(() => {
    return preds.filter(p => 
      (filtroSede === "Todas" || p.sede === filtroSede) &&
      (filtroSum === "Todos" || p.suministro === filtroSum)
    );
  }, [preds, filtroSede, filtroSum]);

  const urgentes = predsFiltrados.filter(p => p.dias <= 2).length;
  const proximos = predsFiltrados.filter(p => p.dias > 2 && p.dias <= 7).length;

  if (!historial.length || diasUnicos < 2) {
    return (
      <Card>
        <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest mb-2">
          Predicción agotamiento
        </p>
        <p className="text-[12px] dark:text-dark-muted text-light-muted">
          {diasUnicos < 2 ? "Necesita al menos 2 días de historial." : "Sin historial suficiente."}
        </p>
      </Card>
    );
  }

  if (!preds.length) {
    return (
      <Card>
        <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest mb-2">
          Predicción agotamiento
        </p>
        <p className="text-[12px] text-brand-green font-semibold">Sin consumibles críticos (todos &gt; 30%).</p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex justify-between items-center mb-3 flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest flex items-center gap-1.5">
            Predicción agotamiento {diasUnicos < 7 ? "(aproximada)" : ""}
            <span title="Regresión lineal por impresora (≥7 días de datos propios) o diferencia simple. Detecta reposiciones automáticamente. Muestra suministros ≤ 50%."
              className="cursor-help text-brand-blue text-[12px] bg-brand-blue/10 w-4 h-4 flex items-center justify-center rounded-full leading-none"
              aria-label="Información metodológica">
              ⓘ
            </span>
          </p>
          <div className="flex items-center gap-2">
            <select value={filtroSede} onChange={e => setFiltroSede(e.target.value)} 
              className="text-[10px] dark:bg-dark-card bg-white border dark:border-dark-border border-light-border rounded px-1.5 py-0.5 dark:text-dark-text outline-none cursor-pointer">
              <option value="Todas">Todas las sedes</option>
              {sedes.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={filtroSum} onChange={e => setFiltroSum(e.target.value)} 
              className="text-[10px] dark:bg-dark-card bg-white border dark:border-dark-border border-light-border rounded px-1.5 py-0.5 dark:text-dark-text outline-none cursor-pointer">
              <option value="Todos">Todos los suministros</option>
              {sumins.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div className="flex gap-3">
          {urgentes > 0 && <span className="text-[10px] font-semibold text-[#f44336]">⚠ {urgentes} críticos (0-2d)</span>}
          {proximos > 0 && <span className="text-[10px] font-semibold text-[#ff9800]">↓ {proximos} urgentes (3-7d)</span>}
        </div>
      </div>

      <div className="rounded-lg overflow-x-auto overflow-y-auto max-h-[500px] dark:border-dark-border border border-light-border">
        <table className="w-full text-left text-[11px] whitespace-nowrap">
          <thead className="sticky top-0 z-10 dark:bg-dark-card bg-white dark:text-dark-muted text-light-muted uppercase border-b dark:border-dark-border border-light-border shadow-sm">
            <tr>
              <th className="py-2.5 px-3 font-bold text-center w-16">Días</th>
              <th className="py-2.5 px-3 font-bold">IP</th>
              <th className="py-2.5 px-3 font-bold">Sede</th>
              <th className="py-2.5 px-3 font-bold">Área</th>
              <th className="py-2.5 px-3 font-bold">Modelo</th>
              <th className="py-2.5 px-3 font-bold">Suministro</th>
              <th className="py-2.5 px-3 font-bold text-right">% Actual</th>
              <th className="py-2.5 px-3 font-bold text-right">Consumo/día</th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-dark-border divide-light-border">
            {predsFiltrados.slice(0, 50).map((p, i) => (
              <tr key={i} className="row-enter hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                style={{ background: p.color + "08", animationDelay: `${Math.min(i * 15, 300)}ms` }}>
                <td className="py-2 px-3">
                  <div className="text-[12px] font-extrabold text-center rounded px-2 py-1 mx-auto w-12"
                    style={{ color: p.color, background: p.color + "18", border: `1px solid ${p.color}44` }}>
                    {p.dias.toFixed(0)}d
                  </div>
                </td>
                <td className="py-2 px-3 font-mono font-semibold dark:text-dark-text text-light-text">{p.ip}</td>
                <td className="py-2 px-3 dark:text-dark-muted text-light-muted">{p.sede}</td>
                <td className="py-2 px-3 dark:text-dark-muted text-light-muted text-[10px]">
                  {p.area ? p.area.slice(0, 25) : "—"}
                </td>
                <td className="py-2 px-3">
                  <span className="text-[10px] font-medium dark:text-dark-muted text-light-muted bg-black/10 dark:bg-white/5 px-1.5 py-0.5 rounded">
                    {p.modelo}
                  </span>
                </td>
                <td className="py-2 px-3 text-[10px] font-medium text-brand-cyan">{p.suministro}</td>
                <td className="py-2 px-3 text-[13px] font-extrabold text-right" style={{ color: nivelColor(p.nivel, "dark") }}>
                  {p.nivel.toFixed(0)}%
                </td>
                <td className="py-2 px-3 text-right dark:text-dark-muted text-light-muted">
                  ↓{p.tasa}%
                </td>
              </tr>
            ))}
            {predsFiltrados.length === 0 && (
              <tr>
                <td colSpan={8} className="py-8 text-center dark:text-dark-muted text-light-muted">
                  No hay equipos que coincidan con los filtros actuales.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
