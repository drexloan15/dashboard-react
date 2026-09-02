"use client";
import { useMemo, useState } from "react";
import Card from "@/components/ui/Card";
import { useAnalitica } from "@/hooks/useData";
import { useTheme } from "@/context/ThemeContext";
import { nivelColor } from "@/lib/utils";
import type { AnaSuministro } from "@/types";

// Predicción de agotamiento de suministros.
//
// El cálculo vive en el backend (/analitica). Antes se hacía acá, con una
// regresión sobre el historial SNMP que necesita ≥7 días por impresora —
// historial arrancó el 2026-08-31, así que en la práctica casi todas las filas
// caían al fallback: una tasa fija de 0.8 %/día, igual para todas, mostrada sin
// distinguirse de una predicción real.
//
// Ahora la tasa sale de las páginas que cada impresora imprime de verdad
// (pr_stats, 5 meses) cruzadas con el rendimiento del suministro, y cada fila
// viaja marcada con el método que se usó. Lo que no se puede estimar se dice.

const COLOR_DIAS = (d: number | null) =>
  d === null ? "#6b7280"
  : d <= 2    ? "#f44336"
  : d <= 7    ? "#ff9800"
  : d <= 14   ? "#e0b030"
  :             "#20c97a";

function Etiqueta({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <span
      title={title}
      className="cursor-help text-brand-blue text-[12px] bg-brand-blue/10 w-4 h-4
                 flex items-center justify-center rounded-full leading-none"
      aria-label="Información metodológica"
    >
      {children}
    </span>
  );
}

export default function PredSection() {
  const { data, isLoading, isError } = useAnalitica();
  const { theme } = useTheme();

  const [filtroSede, setFiltroSede] = useState("Todas");
  const [filtroSum,  setFiltroSum]  = useState("Todos");

  const sum = data?.predictiva?.suministros;
  const items: AnaSuministro[] = useMemo(() => sum?.items ?? [], [sum]);

  const sedes  = useMemo(
    () => Array.from(new Set(items.map(i => i.sede).filter(Boolean))).sort(), [items]);
  const tipos  = useMemo(
    () => Array.from(new Set(items.map(i => i.etiqueta))).sort(), [items]);

  const filtrados = useMemo(() => items.filter(i =>
    (filtroSede === "Todas" || i.sede === filtroSede) &&
    (filtroSum  === "Todos" || i.etiqueta === filtroSum)
  ), [items, filtroSede, filtroSum]);

  const criticos  = filtrados.filter(i => i.dias !== null && i.dias <= 2).length;
  const urgentes  = filtrados.filter(i => i.dias !== null && i.dias > 2 && i.dias <= 7).length;
  const sinDatos  = filtrados.filter(i => i.metodo === "sin_datos").length;

  if (isLoading || isError || !sum) {
    return (
      <Card>
        <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest mb-2">
          Predicción agotamiento
        </p>
        <p className="text-[12px] dark:text-dark-muted text-light-muted">
          {isLoading ? "Calculando…" : "Analítica no disponible."}
        </p>
      </Card>
    );
  }

  if (!items.length) {
    return (
      <Card>
        <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest mb-2">
          Predicción agotamiento
        </p>
        <p className="text-[12px] text-brand-green font-semibold">
          Sin consumibles por debajo del 60 %.
        </p>
      </Card>
    );
  }

  const METODO = `Días = nivel actual ÷ consumo diario estimado.
El consumo sale de las páginas reales que imprimió esa impresora en los últimos ${sum.ventana_dias} días (pr_stats), divididas entre el rendimiento asumido del suministro.
El ORDEN dentro de un mismo suministro es fiable. Los días absolutos son una estimación: dependen del rendimiento asumido, que aún no está medido.
Las filas marcadas "sin volumen" no aparecen en pr_stats — no se les inventa una tasa.`;

  return (
    <Card>
      <div className="flex justify-between items-center mb-3 flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest flex items-center gap-1.5">
            Predicción agotamiento
            <Etiqueta title={METODO}>ⓘ</Etiqueta>
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
              {tipos.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div className="flex gap-3 items-center">
          {criticos > 0 && <span className="text-[10px] font-semibold text-[#f44336]">⚠ {criticos} críticos (0-2d)</span>}
          {urgentes > 0 && <span className="text-[10px] font-semibold text-[#ff9800]">↓ {urgentes} urgentes (3-7d)</span>}
          {sinDatos > 0 && <span className="text-[10px] font-semibold dark:text-dark-muted text-light-muted">◌ {sinDatos} sin volumen</span>}
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
              <th className="py-2.5 px-3 font-bold">Suministro</th>
              <th className="py-2.5 px-3 font-bold text-right">% Actual</th>
              <th className="py-2.5 px-3 font-bold text-right">Págs./día</th>
              <th className="py-2.5 px-3 font-bold">Se agota</th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-dark-border divide-light-border">
            {filtrados.slice(0, 60).map((p, i) => {
              const color = COLOR_DIAS(p.dias);
              const sin = p.metodo === "sin_datos";
              return (
                <tr key={`${p.serie}-${p.suministro}`}
                    className="row-enter hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    style={{ background: color + "08", animationDelay: `${Math.min(i * 15, 300)}ms` }}>
                  <td className="py-2 px-3">
                    <div className="text-[12px] font-extrabold text-center rounded px-2 py-1 mx-auto w-12"
                      style={{ color, background: color + "18", border: `1px solid ${color}44` }}>
                      {p.dias === null ? "—" : `${p.dias.toFixed(0)}d`}
                    </div>
                  </td>
                  <td className="py-2 px-3 font-mono font-semibold dark:text-dark-text text-light-text">{p.ip}</td>
                  <td className="py-2 px-3 dark:text-dark-muted text-light-muted">{p.sede}</td>
                  <td className="py-2 px-3 dark:text-dark-muted text-light-muted text-[10px]">
                    {p.area ? p.area.slice(0, 25) : "—"}
                  </td>
                  <td className="py-2 px-3 text-[10px] font-medium text-brand-cyan">{p.etiqueta}</td>
                  <td className="py-2 px-3 text-[13px] font-extrabold text-right"
                      style={{ color: nivelColor(p.nivel, theme) }}>
                    {p.nivel.toFixed(0)}%
                  </td>
                  <td className="py-2 px-3 text-right dark:text-dark-muted text-light-muted">
                    {sin ? (
                      <span title="Esta impresora no registra trabajos en pr_stats en la ventana. Sin volumen no hay tasa de consumo que estimar."
                            className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10 cursor-help">
                        sin volumen
                      </span>
                    ) : p.pag_dia.toFixed(0)}
                  </td>
                  <td className="py-2 px-3 dark:text-dark-muted text-light-muted text-[10px] font-mono">
                    {p.agotamiento ?? "—"}
                  </td>
                </tr>
              );
            })}
            {filtrados.length === 0 && (
              <tr>
                <td colSpan={8} className="py-8 text-center dark:text-dark-muted text-light-muted">
                  No hay equipos que coincidan con los filtros actuales.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[9px] dark:text-dark-muted text-light-muted leading-relaxed">
        {sum.total} suministros por debajo del 60 % · consumo medido sobre los últimos{" "}
        {sum.ventana_dias} días · {sum.equipos_sin_volumen} equipos sin trabajos en pr_stats.
        Los días son una estimación; el orden dentro de cada suministro no depende del
        rendimiento asumido.
      </p>
    </Card>
  );
}
