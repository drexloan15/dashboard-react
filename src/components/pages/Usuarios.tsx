"use client";
import { useState, useMemo } from "react";
import Card from "@/components/ui/Card";
import type { PrStatsData } from "@/types";

type Periodo = "dia" | "semana" | "mes" | "año";

function isoWeek(d: Date): string {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-S${String(week).padStart(2, "0")}`;
}

function groupKey(dateStr: string, periodo: Periodo): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  if (periodo === "dia")    return dateStr.slice(0, 10);
  if (periodo === "semana") return isoWeek(d);
  if (periodo === "mes")    return dateStr.slice(0, 7);
  return dateStr.slice(0, 4);
}

const PERIOD_LABEL: Record<Periodo, string> = { dia: "Día", semana: "Semana", mes: "Mes", año: "Año" };

export default function Usuarios({ data }: { data: PrStatsData | null }) {
  const [periodo, setPeriodo] = useState<Periodo>("dia");
  const [topN,    setTopN]    = useState(15);

  if (!data || !data.exists) {
    return (
      <div className="page-body">
        <h1 className="page-title text-[22px] font-extrabold mb-6 dark:text-dark-text text-light-text">Usuarios</h1>
        <Card>
          <p className="text-[12px] dark:text-dark-muted text-light-muted">
            Sin datos de impresión. Verifica que el agente pr_stats esté corriendo en el Servidor A.
          </p>
        </Card>
      </div>
    );
  }

  const { totales, top_usuarios = [], por_dia = [], por_sede = [], por_modelo = [] } = data;

  // Agrupar por_dia según el periodo seleccionado
  const tendencia = useMemo(() => {
    const buckets: Record<string, { pages: number; jobs: number }> = {};
    for (const d of por_dia) {
      const key = groupKey(d.fecha, periodo);
      if (!key) continue;
      if (!buckets[key]) buckets[key] = { pages: 0, jobs: 0 };
      buckets[key].pages += d.pages;
      buckets[key].jobs  += d.jobs;
    }
    return Object.entries(buckets)
      .map(([label, v]) => ({ label, ...v }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [por_dia, periodo]);

  const maxTend     = Math.max(...tendencia.map(d => d.pages), 1);
  const maxUsuario  = Math.max(...top_usuarios.map(u => u.pages), 1);
  const maxSede     = Math.max(...por_sede.map(s => s.pages), 1);
  const maxModelo   = Math.max(...por_modelo.map(m => m.pages), 1);

  const topVisible = top_usuarios.slice(0, topN);

  return (
    <div className="page-body">
      <h1 className="page-title text-[22px] font-extrabold mb-6 dark:text-dark-text text-light-text">
        Usuarios — Analíticas de Impresión
      </h1>
      <div className="flex flex-col gap-6">

        {/* KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            { label: "Total páginas",  value: (totales?.pages ?? 0).toLocaleString(),  sub: "desde 23/04/2026" },
            { label: "Trabajos enviados", value: (totales?.jobs ?? 0).toLocaleString(), sub: "print jobs" },
            { label: "Usuarios únicos", value: (totales?.users ?? 0).toLocaleString(),  sub: "identificados" },
          ].map(k => (
            <Card key={k.label} className="dark:bg-dark-card p-4">
              <p className="text-[9px] dark:text-dark-muted text-light-muted uppercase font-bold tracking-wider mb-1">{k.label}</p>
              <p className="text-[22px] font-black text-brand-blue">{k.value}</p>
              <p className="text-[10px] dark:text-dark-muted text-light-muted">{k.sub}</p>
            </Card>
          ))}
        </div>

        {/* Top usuarios */}
        <Card className="card-enter dark:bg-dark-card">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text uppercase tracking-wider">
              Top usuarios por páginas impresas
            </h2>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="dark:text-dark-muted text-light-muted">Mostrar:</span>
              {[10, 15, 20, 30].map(n => (
                <button key={n} onClick={() => setTopN(n)}
                  className={`px-2 py-1 rounded font-semibold cursor-pointer transition-colors
                    ${topN === n ? "bg-brand-blue text-white" : "dark:bg-dark-border bg-gray-100 dark:text-dark-muted text-light-muted"}`}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2 max-h-[480px] overflow-y-auto">
            {topVisible.map((u, i) => {
              const pct = (u.pages / maxUsuario) * 100;
              return (
                <div key={u.userid} className="row-enter" style={{ animationDelay: `${Math.min(i * 12, 250)}ms` }}>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="font-bold dark:text-dark-text text-light-text flex items-center gap-2">
                      <span className="text-[9px] dark:text-dark-muted text-light-muted w-5 text-right">{i + 1}.</span>
                      {u.userid}
                    </span>
                    <span className="flex gap-3 dark:text-dark-muted text-light-muted">
                      <span className="font-bold text-brand-blue">{u.pages.toLocaleString()} págs.</span>
                      <span>{u.jobs.toLocaleString()} jobs</span>
                    </span>
                  </div>
                  <div className="h-2 w-full dark:bg-dark-border bg-gray-200 rounded-full overflow-hidden">
                    <div className="h-full bg-brand-blue rounded-full transition-all duration-700 supply-bar"
                      style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Tendencia + Sedes */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* Tendencia por periodo */}
          <Card className="card-enter dark:bg-dark-card" style={{ animationDelay: "50ms" }}>
            <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
              <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text uppercase tracking-wider">
                Páginas por {PERIOD_LABEL[periodo]}
              </h2>
              <div className="flex rounded-lg overflow-hidden border dark:border-dark-border border-light-border text-[10px] font-semibold">
                {(["dia","semana","mes","año"] as Periodo[]).map(p => (
                  <button key={p} onClick={() => setPeriodo(p)}
                    className={`px-2.5 py-1.5 capitalize transition-colors cursor-pointer
                      ${periodo === p ? "bg-brand-blue text-white"
                        : "dark:bg-dark-surface bg-white dark:text-dark-muted text-light-muted hover:bg-black/5 dark:hover:bg-white/5"}`}>
                    {PERIOD_LABEL[p]}
                  </button>
                ))}
              </div>
            </div>
            {tendencia.length > 0 ? (
              <div className="overflow-y-auto max-h-[380px]">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 z-10 dark:bg-dark-card bg-white dark:text-dark-muted text-light-muted uppercase border-b dark:border-dark-border border-light-border">
                    <tr>
                      <th className="py-2 pr-3 font-bold text-left">Período</th>
                      <th className="py-2 px-2 font-bold text-right">Páginas</th>
                      <th className="py-2 pl-2 font-bold w-24">Relativo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y dark:divide-dark-border divide-light-border">
                    {tendencia.map((d, i) => {
                      const isPico = d.pages === Math.max(...tendencia.map(x => x.pages));
                      const pct = (d.pages / maxTend) * 100;
                      return (
                        <tr key={d.label} className={`row-enter ${isPico ? "dark:bg-brand-blue/10 bg-blue-50" : ""}`}
                          style={{ animationDelay: `${Math.min(i * 12, 250)}ms` }}>
                          <td className="py-1.5 pr-3 font-mono dark:text-dark-text text-light-text">
                            {d.label}
                            {isPico && <span className="ml-1.5 text-[8px] bg-brand-blue text-white px-1 py-0.5 rounded uppercase font-bold">Pico</span>}
                          </td>
                          <td className={`py-1.5 px-2 font-bold text-right ${isPico ? "text-brand-blue" : "dark:text-dark-text text-light-text"}`}>
                            {d.pages.toLocaleString()}
                          </td>
                          <td className="py-1.5 pl-2">
                            <div className="h-1.5 w-full dark:bg-dark-border bg-gray-200 rounded-full overflow-hidden">
                              <div className="h-full bg-brand-blue rounded-full" style={{ width: `${pct}%` }} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-[11px] dark:text-dark-muted text-light-muted">Sin datos.</p>
            )}
          </Card>

          {/* Por sede */}
          <Card className="card-enter dark:bg-dark-card" style={{ animationDelay: "80ms" }}>
            <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text uppercase tracking-wider mb-4">
              Páginas por sede
            </h2>
            <div className="flex flex-col gap-3">
              {por_sede.map((s, i) => {
                const pct = (s.pages / maxSede) * 100;
                return (
                  <div key={s.site} className="row-enter" style={{ animationDelay: `${Math.min(i * 20, 250)}ms` }}>
                    <div className="flex justify-between text-[11px] mb-1">
                      <span className="font-bold dark:text-dark-text text-light-text">{s.site}</span>
                      <span className="dark:text-dark-muted text-light-muted">
                        <span className="font-bold text-brand-blue">{s.pages.toLocaleString()}</span>
                        {" "}págs · {s.users} usuarios
                      </span>
                    </div>
                    <div className="h-2 w-full dark:bg-dark-border bg-gray-200 rounded-full overflow-hidden">
                      <div className="h-full bg-brand-blue rounded-full transition-all duration-700 supply-bar"
                        style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        {/* Por modelo */}
        <Card className="card-enter dark:bg-dark-card" style={{ animationDelay: "120ms" }}>
          <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text uppercase tracking-wider mb-4">
            Top modelos de impresora
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] whitespace-nowrap">
              <thead className="dark:text-dark-muted text-light-muted uppercase border-b dark:border-dark-border border-light-border">
                <tr>
                  <th className="py-2 pr-3 font-bold text-left">Modelo</th>
                  <th className="py-2 px-2 font-bold text-right">Páginas</th>
                  <th className="py-2 px-2 font-bold text-right">Jobs</th>
                  <th className="py-2 pl-2 font-bold w-32">Relativo</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-dark-border divide-light-border">
                {por_modelo.map((m, i) => {
                  const pct = (m.pages / maxModelo) * 100;
                  return (
                    <tr key={m.releasemodel} className="row-enter" style={{ animationDelay: `${Math.min(i * 15, 250)}ms` }}>
                      <td className="py-2 pr-3 font-medium dark:text-dark-text text-light-text">{m.releasemodel}</td>
                      <td className="py-2 px-2 font-bold text-right text-brand-blue">{m.pages.toLocaleString()}</td>
                      <td className="py-2 px-2 text-right dark:text-dark-muted text-light-muted">{m.jobs.toLocaleString()}</td>
                      <td className="py-2 pl-2">
                        <div className="h-2 w-full dark:bg-dark-border bg-gray-200 rounded-full overflow-hidden">
                          <div className="h-full bg-brand-blue rounded-full supply-bar" style={{ width: `${pct}%` }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

      </div>
    </div>
  );
}
