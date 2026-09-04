"use client";
import { useState, useMemo } from "react";
import Card from "@/components/ui/Card";
import type { PrStatsData } from "@/types";
import { useUsuarioPrStats } from "@/hooks/useData";

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

function tipoLabel(t: string) {
  const v = t?.toLowerCase();
  if (v === "p") return "Impresión";
  if (v === "c") return "Copia";
  if (v === "d") return "Cancelado";
  return t || "Otro";
}
function tipoColor(t: string) {
  const v = t?.toLowerCase();
  if (v === "p") return "#3d8ef5";
  if (v === "c") return "#20c97a";
  if (v === "d") return "#f04545";
  return "#8a9ab5";
}

// ── Vista detalle de usuario ──────────────────────────────────────────────────
function UsuarioDetail({ userid, onBack }: { userid: string; onBack: () => void }) {
  const { data: detail, isLoading: loading } = useUsuarioPrStats(userid);
  const [fechaDesde, setFechaDesde] = useState("");
  const [fechaHasta, setFechaHasta] = useState("");
  const [filtroTipo, setFiltroTipo] = useState("todos");
  const [ordenar,    setOrdenar]    = useState<"fecha_desc" | "fecha_asc" | "paginas_desc" | "paginas_asc">("fecha_desc");

  const jobsFiltrados = useMemo(() => {
    if (!detail?.jobs) return [];
    const filtered = detail.jobs.filter(j => {
      const fecha = j.submitdate.slice(0, 10);
      if (fechaDesde && fecha < fechaDesde) return false;
      if (fechaHasta && fecha > fechaHasta) return false;
      if (filtroTipo !== "todos" && j.finalaction.toLowerCase() !== filtroTipo) return false;
      return true;
    });
    if (ordenar === "fecha_desc")   return filtered;
    if (ordenar === "fecha_asc")    return [...filtered].reverse();
    if (ordenar === "paginas_desc") return [...filtered].sort((a, b) => b.numpages - a.numpages);
    if (ordenar === "paginas_asc")  return [...filtered].sort((a, b) => a.numpages - b.numpages);
    return filtered;
  }, [detail, fechaDesde, fechaHasta, filtroTipo, ordenar]);

  const maxPorDia = Math.max(...(detail?.por_dia?.map(d => d.pages) ?? [1]), 1);
  const totalPages = jobsFiltrados.reduce((s, j) => s + j.numpages, 0);
  const totalJobs  = jobsFiltrados.length;

  return (
    <div className="page-body">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1 mb-5 text-[12px]">
        <button onClick={onBack} className="text-brand-blue cursor-pointer hover:underline bg-transparent border-none">
          ← Usuarios
        </button>
        <span className="dark:text-dark-muted text-light-muted mx-1">/</span>
        <span className="dark:text-dark-muted text-light-muted">{userid}</span>
      </div>

      <h1 className="text-[20px] font-extrabold mb-1 dark:text-dark-text text-light-text">{userid}</h1>
      <p className="text-[12px] dark:text-dark-muted text-light-muted mb-6">Historial de trabajos de impresión</p>

      {loading && (
        <Card><p role="status" aria-live="polite" className="text-[12px] dark:text-dark-muted text-light-muted">Cargando...</p></Card>
      )}

      {!loading && detail && (
        <div className="flex flex-col gap-6">

          {/* KPIs tipo */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {(detail.por_tipo ?? []).map(t => (
              <Card key={t.tipo} className="p-4">
                <p className="text-[9px] uppercase font-bold tracking-wider mb-1" style={{ color: tipoColor(t.tipo) }}>
                  {tipoLabel(t.tipo)}
                </p>
                <p className="text-[22px] font-black" style={{ color: tipoColor(t.tipo) }}>{t.pages.toLocaleString()}</p>
                <p className="text-[10px] dark:text-dark-muted text-light-muted">{t.jobs.toLocaleString()} jobs</p>
              </Card>
            ))}
            {(fechaDesde || fechaHasta) && (
              <Card className="p-4">
                <p className="text-[9px] uppercase font-bold tracking-wider dark:text-dark-muted text-light-muted mb-1">Páginas en rango</p>
                <p className="text-[22px] font-black text-brand-blue">{totalPages.toLocaleString()}</p>
                <p className="text-[10px] dark:text-dark-muted text-light-muted">{totalJobs.toLocaleString()} jobs</p>
              </Card>
            )}
          </div>

          {/* Historial de trabajos */}
          <Card className="card-enter">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
              <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text uppercase tracking-wider">
                Trabajos enviados
              </h2>
              <div className="flex items-center gap-2 text-[11px] flex-wrap">
                {/* Filtro tipo */}
                <select aria-label="Filtrar trabajos por tipo" value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}
                  className="text-[11px] dark:bg-dark-surface bg-white border dark:border-dark-border border-light-border rounded px-2 py-1 dark:text-dark-text text-light-text outline-none cursor-pointer focus:ring-2 focus:ring-brand-blue/40 focus:border-brand-blue">
                  <option value="todos">Todos los tipos</option>
                  <option value="p">Impresión</option>
                  <option value="c">Copia</option>
                  <option value="d">Cancelado</option>
                </select>
                {/* Ordenar */}
                <select aria-label="Ordenar trabajos" value={ordenar} onChange={e => setOrdenar(e.target.value as typeof ordenar)}
                  className="text-[11px] dark:bg-dark-surface bg-white border dark:border-dark-border border-light-border rounded px-2 py-1 dark:text-dark-text text-light-text outline-none cursor-pointer focus:ring-2 focus:ring-brand-blue/40 focus:border-brand-blue">
                  <option value="fecha_desc">Más reciente</option>
                  <option value="fecha_asc">Más antiguo</option>
                  <option value="paginas_desc">Mayor páginas</option>
                  <option value="paginas_asc">Menor páginas</option>
                </select>
                {/* Filtro fecha */}
                <span className="dark:text-dark-muted text-light-muted">Desde</span>
                <input type="date" aria-label="Fecha inicial" value={fechaDesde} onChange={e => setFechaDesde(e.target.value)}
                  className="text-[11px] dark:bg-dark-surface bg-white border dark:border-dark-border border-light-border rounded px-2 py-1 dark:text-dark-text text-light-text outline-none cursor-pointer focus:ring-2 focus:ring-brand-blue/40 focus:border-brand-blue" />
                <span className="dark:text-dark-muted text-light-muted">Hasta</span>
                <input type="date" aria-label="Fecha final" value={fechaHasta} onChange={e => setFechaHasta(e.target.value)}
                  className="text-[11px] dark:bg-dark-surface bg-white border dark:border-dark-border border-light-border rounded px-2 py-1 dark:text-dark-text text-light-text outline-none cursor-pointer focus:ring-2 focus:ring-brand-blue/40 focus:border-brand-blue" />
                {(fechaDesde || fechaHasta || filtroTipo !== "todos") && (
                  <button onClick={() => { setFechaDesde(""); setFechaHasta(""); setFiltroTipo("todos"); setOrdenar("fecha_desc"); }}
                    className="text-[10px] text-brand-red cursor-pointer hover:underline bg-transparent border-none">
                    Limpiar
                  </button>
                )}
              </div>
            </div>
            <p className="text-[10px] dark:text-dark-muted text-light-muted mb-3">{jobsFiltrados.length.toLocaleString()} trabajos</p>
            <div className="overflow-y-auto max-h-[420px]">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 z-10 dark:bg-dark-card bg-white dark:text-dark-muted text-light-muted uppercase border-b dark:border-dark-border border-light-border">
                  <tr>
                    <th className="py-2 pr-3 font-bold text-left">Documento</th>
                    <th className="py-2 px-2 font-bold text-center">Tipo</th>
                    <th className="py-2 px-2 font-bold text-right">Págs.</th>
                    <th className="py-2 px-2 font-bold text-left">Sede</th>
                    <th className="py-2 pl-2 font-bold text-left">Fecha</th>
                  </tr>
                </thead>
                <tbody className="divide-y dark:divide-dark-border divide-light-border">
                  {jobsFiltrados.map((j, i) => (
                    <tr key={i} className="row-enter" style={{ animationDelay: `${Math.min(i * 8, 200)}ms` }}>
                      <td className="py-2 pr-3 dark:text-dark-text text-light-text max-w-[220px] truncate" title={j.printjobname}>
                        {j.printjobname || <span className="dark:text-dark-muted text-light-muted italic">Sin nombre</span>}
                      </td>
                      <td className="py-2 px-2 text-center">
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                          style={{ background: tipoColor(j.finalaction) + "22", color: tipoColor(j.finalaction) }}>
                          {tipoLabel(j.finalaction)}
                        </span>
                      </td>
                      <td className="py-2 px-2 font-bold text-right text-brand-blue">{j.numpages}</td>
                      <td className="py-2 px-2 dark:text-dark-muted text-light-muted">{j.site || "—"}</td>
                      <td className="py-2 pl-2 font-mono dark:text-dark-muted text-light-muted whitespace-nowrap">
                        {j.submitdate.slice(0, 16).replace("T", " ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Actividad por día */}
          <Card className="card-enter">
            <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text uppercase tracking-wider mb-4">
              Actividad por día
            </h2>
            <div className="overflow-y-auto max-h-[260px]">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 z-10 dark:bg-dark-card bg-white dark:text-dark-muted text-light-muted uppercase border-b dark:border-dark-border border-light-border">
                  <tr>
                    <th className="py-2 pr-3 font-bold text-left">Fecha</th>
                    <th className="py-2 px-2 font-bold text-right">Páginas</th>
                    <th className="py-2 px-2 font-bold text-right">Jobs</th>
                    <th className="py-2 pl-2 font-bold w-32">Relativo</th>
                  </tr>
                </thead>
                <tbody className="divide-y dark:divide-dark-border divide-light-border">
                  {[...(detail.por_dia ?? [])].reverse().map((d, i) => {
                    const isPico = d.pages === maxPorDia;
                    const pct = (d.pages / maxPorDia) * 100;
                    return (
                      <tr key={d.fecha} className={`row-enter ${isPico ? "dark:bg-brand-blue/10 bg-blue-50" : ""}`}
                        style={{ animationDelay: `${Math.min(i * 10, 200)}ms` }}>
                        <td className="py-1.5 pr-3 font-mono dark:text-dark-text text-light-text">
                          {d.fecha}
                          {isPico && <span className="ml-1.5 text-[8px] bg-brand-blue text-white px-1 py-0.5 rounded uppercase font-bold">Pico</span>}
                        </td>
                        <td className={`py-1.5 px-2 font-bold text-right ${isPico ? "text-brand-blue" : "dark:text-dark-text text-light-text"}`}>
                          {d.pages.toLocaleString()}
                        </td>
                        <td className="py-1.5 px-2 text-right dark:text-dark-muted text-light-muted">{d.jobs}</td>
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
          </Card>

        </div>
      )}
    </div>
  );
}

// ── Vista principal ───────────────────────────────────────────────────────────
export default function Usuarios({ data }: { data: PrStatsData | null }) {
  const [periodo, setPeriodo] = useState<Periodo>("dia");
  const [topN,    setTopN]    = useState(15);
  const [usuarioSel, setUsuarioSel] = useState<string | null>(null);

  const { totales, top_usuarios = [], por_dia = [], por_modelo = [] } = data?.exists ? data : {};

  const por_sede = data?.por_sede ?? [];

  const tendencia = useMemo(() => {
    if (!por_dia.length) return [];
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

  const maxTend    = Math.max(...tendencia.map(d => d.pages), 1);
  const maxUsuario = Math.max(...top_usuarios.map(u => u.pages), 1);
  const maxSede    = Math.max(...por_sede.map(s => s.pages), 1);
  const maxModelo  = Math.max(...por_modelo.map(m => m.pages), 1);

  const topUsuariosNorm = top_usuarios.map(u => ({ ...u, userid: u.userid?.trim() || "Sin usuario" }));
  const topVisible = topUsuariosNorm.slice(0, topN);

  if (usuarioSel) {
    return <UsuarioDetail userid={usuarioSel} onBack={() => setUsuarioSel(null)} />;
  }

  if (!data || !data.exists) {
    return (
      <div className="page-body">
        <h1 className="page-title text-[22px] font-extrabold mb-6 dark:text-dark-text text-light-text">Usuarios</h1>
        <Card>
          <p role="status" aria-live="polite" className="text-[12px] dark:text-dark-muted text-light-muted">
            {data === null ? "Cargando datos de impresión..." : "Sin datos. Verifica que el agente pr_stats esté corriendo en el Servidor A."}
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="page-body">
      <h1 className="page-title text-[22px] font-extrabold mb-6 dark:text-dark-text text-light-text">
        Usuarios — Analíticas de Impresión
      </h1>
      <div className="flex flex-col gap-6">

        {/* KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            { label: "Total páginas",     value: (totales?.pages ?? 0).toLocaleString(), sub: "desde 23/04/2026" },
            { label: "Trabajos enviados", value: (totales?.jobs  ?? 0).toLocaleString(), sub: "print jobs" },
            { label: "Usuarios únicos",   value: (totales?.users ?? 0).toLocaleString(), sub: "identificados" },
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
                <button key={u.userid} onClick={() => setUsuarioSel(u.userid)}
                  className="row-enter w-full text-left cursor-pointer hover:opacity-80 transition-opacity"
                  style={{ animationDelay: `${Math.min(i * 12, 250)}ms` }}>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="font-bold dark:text-dark-text text-light-text flex items-center gap-2">
                      <span className="text-[9px] dark:text-dark-muted text-light-muted w-5 text-right">{i + 1}.</span>
                      <span className="text-brand-blue hover:underline">{u.userid}</span>
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
                </button>
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
                      const isPico = d.pages === maxTend && d.pages > 0;
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
            <div className="flex flex-col gap-3 overflow-y-auto max-h-[380px]">
              {por_sede.map((s, i) => {
                const pct = (s.pages / maxSede) * 100;
                return (
                  <div key={s.site} className="row-enter" style={{ animationDelay: `${Math.min(i * 20, 250)}ms` }}>
                    <div className="flex justify-between text-[11px] mb-1">
                      <span className="font-bold dark:text-dark-text text-light-text">{s.site}</span>
                      <span className="dark:text-dark-muted text-light-muted">
                        <span className="font-bold text-brand-blue">{s.pages.toLocaleString()}</span>
                        {" "}págs
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
