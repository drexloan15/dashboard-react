"use client";
import { useState, useMemo } from "react";
import Card from "@/components/ui/Card";
import type { Printer, HistorialRow } from "@/types";
import { toNum } from "@/lib/utils";
import { SUMINISTROS } from "@/types";

type Periodo = "dia" | "semana" | "mes" | "año";

// Fechas de inicio personalizadas por área (nombre en minúsculas).
// Útil cuando se reemplaza una impresora y el contador arranca desde un valor alto.
const CUSTOM_START_DATES: Record<string, string> = {
  "supervisores molino (planta)": "2026-04-29",
};

function areaStartDate(area: string): string | null {
  return CUSTOM_START_DATES[area.toLowerCase()] ?? null;
}

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
  if (periodo === "dia") return dateStr.slice(0, 10);
  if (periodo === "semana") return isoWeek(d);
  if (periodo === "mes") return dateStr.slice(0, 7);
  return dateStr.slice(0, 4);
}

interface GroupRow {
  area: string;
  modelo: string;
  sede: string;
  impresoras: number;
  paginasPeriodo: number;
  paginasTotal: number;
}

export default function Analiticas({
  printers,
  historial,
}: {
  printers: Printer[];
  historial: HistorialRow[];
}) {
  const [periodo, setPeriodo] = useState<Periodo>("dia");
  const [sortBy, setSortBy] = useState<"paginasPeriodo" | "paginasTotal" | "impresoras">("paginasPeriodo");

  // Metadata de cada IP (área, modelo, sede) desde estado_actual
  const printerMeta = useMemo(() => {
    const meta: Record<string, { area: string; modelo: string; sede: string }> = {};
    for (const p of printers) {
      meta[p.IP] = {
        area: p.AREA || "Sin Área",
        modelo: p.MODELO_INV || "Sin Modelo",
        sede: p.SEDE || "Sin Sede",
      };
    }
    return meta;
  }, [printers]);

  // Fecha de inicio del monitoreo = primera fecha en historial
  const fechaInicio = useMemo(() => {
    let min = "";
    for (const h of historial) {
      const ts = h.TIMESTAMP || h._ts || h.FECHA || h._fecha || "";
      if (!ts) continue;
      if (!min || ts < min) min = ts;
    }
    return min ? min.slice(0, 10) : "—";
  }, [historial]);

  // Delta total por IP desde inicio del monitoreo.
  // Salta contadores <= 0 (lecturas de impresoras offline que devuelven 0).
  const ipDeltaTotal = useMemo(() => {
    const stats: Record<string, { min: number; max: number }> = {};
    for (const h of historial) {
      const c = toNum(h.CONTADOR);
      if (!c || c <= 0 || !h.IP) continue;
      if (!(h.IP in stats)) stats[h.IP] = { min: c, max: c };
      else {
        if (c < stats[h.IP].min) stats[h.IP].min = c;
        if (c > stats[h.IP].max) stats[h.IP].max = c;
      }
    }
    return Object.fromEntries(
      Object.entries(stats).map(([ip, s]) => [ip, Math.max(0, s.max - s.min)])
    );
  }, [historial]);

  // Agrupación por (IP, bucket-de-periodo) para la tendencia.
  // Salta contadores <= 0 para no contaminar los deltas con lecturas de offline.
  const byIPPeriod = useMemo(() => {
    const map: Record<string, Record<string, number[]>> = {};
    for (const h of historial) {
      const ts = h.TIMESTAMP || h._ts || h.FECHA || "";
      const key = groupKey(ts, periodo);
      if (!key || !h.IP) continue;
      const c = toNum(h.CONTADOR);
      if (!c || c <= 0) continue;
      if (!map[h.IP]) map[h.IP] = {};
      if (!map[h.IP][key]) map[h.IP][key] = [];
      map[h.IP][key].push(c);
    }
    return map;
  }, [historial, periodo]);

  // Bucket más reciente en el historial para el periodo seleccionado
  const latestBucket = useMemo(() => {
    let maxTs = "";
    for (const h of historial) {
      const ts = h.TIMESTAMP || h._ts || h.FECHA || "";
      if (ts > maxTs) maxTs = ts;
    }
    return maxTs ? groupKey(maxTs, periodo) : "";
  }, [historial, periodo]);

  // Filas del reporte agrupadas por AREA + MODELO + SEDE.
  // Para grupos con fecha de inicio personalizada se hace un scan directo del
  // historial con el cutoff aplicado, evitando cualquier fallo de lookup de IP.
  const reportRows = useMemo((): GroupRow[] => {
    // 1. Construir grupos y sus IPs desde el estado actual
    const groupMap: Record<
      string,
      { area: string; modelo: string; sede: string; ips: Set<string>; paginasPeriodo: number; paginasTotal: number }
    > = {};

    const allIPs = new Set([
      ...Object.keys(ipDeltaTotal),
      ...printers.map(p => p.IP),
    ]);

    for (const ip of allIPs) {
      const meta = printerMeta[ip];
      if (!meta) continue;
      const key = `${meta.area}||${meta.modelo}||${meta.sede}`;
      if (!groupMap[key]) {
        groupMap[key] = { area: meta.area, modelo: meta.modelo, sede: meta.sede, ips: new Set(), paginasPeriodo: 0, paginasTotal: 0 };
      }
      groupMap[key].ips.add(ip);
    }

    // 2. Calcular estadísticas por grupo
    for (const group of Object.values(groupMap)) {
      const cutoff = areaStartDate(group.area);

      if (cutoff) {
        // Scan directo del historial para este conjunto de IPs con el corte aplicado.
        // Garantiza que el cutoff se respete independientemente del estado de printerMeta.
        const ipSet = group.ips;
        const totalStats: Record<string, { min: number; max: number }> = {};
        const periodStats: Record<string, { min: number; max: number }> = {};

        for (const h of historial) {
          if (!h.IP || !ipSet.has(h.IP)) continue;
          const c = toNum(h.CONTADOR);
          if (!c || c <= 0) continue;
          const ts = h.TIMESTAMP || h._ts || h.FECHA || h._fecha || "";
          if (!ts || ts.slice(0, 10) < cutoff) continue;

          // Total desde cutoff
          if (!(h.IP in totalStats)) totalStats[h.IP] = { min: c, max: c };
          else {
            if (c < totalStats[h.IP].min) totalStats[h.IP].min = c;
            if (c > totalStats[h.IP].max) totalStats[h.IP].max = c;
          }

          // Período actual
          const bucket = groupKey(ts, periodo);
          if (bucket === latestBucket) {
            if (!(h.IP in periodStats)) periodStats[h.IP] = { min: c, max: c };
            else {
              if (c < periodStats[h.IP].min) periodStats[h.IP].min = c;
              if (c > periodStats[h.IP].max) periodStats[h.IP].max = c;
            }
          }
        }

        for (const s of Object.values(totalStats)) group.paginasTotal += Math.max(0, s.max - s.min);
        for (const s of Object.values(periodStats)) group.paginasPeriodo += Math.max(0, s.max - s.min);
      } else {
        // Sin cutoff: usar valores precalculados
        for (const ip of group.ips) {
          group.paginasTotal += ipDeltaTotal[ip] || 0;
          const readings = byIPPeriod[ip]?.[latestBucket] ?? [];
          if (readings.length >= 1) {
            group.paginasPeriodo += Math.max(...readings) - Math.min(...readings);
          }
        }
      }
    }

    return Object.values(groupMap).map(g => ({
      area: g.area,
      modelo: g.modelo,
      sede: g.sede,
      impresoras: g.ips.size,
      paginasPeriodo: g.paginasPeriodo,
      paginasTotal: g.paginasTotal,
    }));
  }, [byIPPeriod, historial, ipDeltaTotal, latestBucket, periodo, printerMeta, printers]);

  const sortedRows = useMemo(
    () => [...reportRows].sort((a, b) => b[sortBy] - a[sortBy]),
    [reportRows, sortBy]
  );

  // Tendencia histórica: páginas por bucket en todo el historial
  const tendencia = useMemo(() => {
    const buckets: Record<string, { impresas: number; activas: Set<string> }> = {};
    for (const [ip, periods] of Object.entries(byIPPeriod)) {
      for (const [bucket, readings] of Object.entries(periods)) {
        if (!buckets[bucket]) buckets[bucket] = { impresas: 0, activas: new Set() };
        const delta = Math.max(...readings) - Math.min(...readings);
        buckets[bucket].impresas += delta;
        if (delta > 0) buckets[bucket].activas.add(ip);
      }
    }
    return Object.entries(buckets)
      .map(([label, d]) => ({ label, impresas: d.impresas, activas: d.activas.size }))
      .filter(d => d.label !== "")
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [byIPPeriod]);

  // KPIs resumen
  const totalDesdeInicio = reportRows.reduce((s, r) => s + r.paginasTotal, 0);
  const totalEnPeriodo = reportRows.reduce((s, r) => s + r.paginasPeriodo, 0);
  const maxPaginasPeriodo = Math.max(...reportRows.map(r => r.paginasPeriodo), 1);

  const maxTendencia = Math.max(...tendencia.map(d => d.impresas), 1);
  const totalTend = tendencia.reduce((s, d) => s + d.impresas, 0);
  const picoPeriodo = tendencia.reduce(
    (p, d) => (d.impresas > p.impresas ? d : p),
    { label: "—", impresas: 0, activas: 0 }
  );

  const PERIOD_LABEL: Record<Periodo, string> = {
    dia: "Día", semana: "Semana", mes: "Mes", año: "Año",
  };

  // Estado de suministros
  const suppStats = SUMINISTROS.map(([key, label]) => {
    let totalNivel = 0, count = 0, critico = 0, bajo = 0, ok = 0;
    printers.forEach(p => {
      const v = toNum(p[key as keyof Printer]);
      if (v !== null) {
        count++;
        totalNivel += v;
        if (v <= 10) critico++;
        else if (v <= 25) bajo++;
        else ok++;
      }
    });
    return { label, count, promedio: count ? Math.round(totalNivel / count) : 0, critico, bajo, ok };
  }).filter(s => s.count > 0);

  return (
    <div className="page-body">
      <h1 className="page-title text-[22px] font-extrabold mb-6 dark:text-dark-text text-light-text">
        Analíticas
      </h1>
      <div className="flex flex-col gap-6">

        {/* Barra de control: periodo + fecha inicio */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3 flex-wrap text-[11px]">
            <span className="dark:text-dark-muted text-light-muted">
              Monitoreo desde:{" "}
              <span className="font-bold dark:text-dark-text text-light-text">{fechaInicio}</span>
            </span>
            <span className="px-2 py-0.5 rounded bg-brand-blue/10 text-brand-blue font-bold">
              {totalDesdeInicio.toLocaleString()} págs. totales desde inicio
            </span>
          </div>
          <div className="flex rounded-lg overflow-hidden border dark:border-dark-border border-light-border text-[11px] font-semibold">
            {(["dia", "semana", "mes", "año"] as Periodo[]).map(p => (
              <button
                key={p}
                onClick={() => setPeriodo(p)}
                className={`px-3 py-1.5 capitalize transition-colors cursor-pointer
                  ${periodo === p
                    ? "bg-brand-blue text-white"
                    : "dark:bg-dark-surface bg-white dark:text-dark-muted text-light-muted hover:bg-black/5 dark:hover:bg-white/5"
                  }`}
              >
                {PERIOD_LABEL[p]}
              </button>
            ))}
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            {
              label: `Páginas — ${PERIOD_LABEL[periodo]} actual`,
              value: totalEnPeriodo.toLocaleString(),
              sub: latestBucket || "sin datos",
            },
            {
              label: "Páginas desde inicio",
              value: totalDesdeInicio.toLocaleString(),
              sub: `desde ${fechaInicio}`,
            },
            {
              label: "Grupos con actividad",
              value: reportRows.filter(r => r.paginasPeriodo > 0).length.toString(),
              sub: "área · modelo · sede",
            },
            {
              label: "Equipos monitoreados",
              value: printers.length.toString(),
              sub: "impresoras totales",
            },
          ].map(k => (
            <Card key={k.label} className="dark:bg-dark-card p-4">
              <p className="text-[9px] dark:text-dark-muted text-light-muted uppercase font-bold tracking-wider mb-1">
                {k.label}
              </p>
              <p className="text-[20px] font-black text-brand-blue">{k.value}</p>
              <p className="text-[10px] dark:text-dark-muted text-light-muted">{k.sub}</p>
            </Card>
          ))}
        </div>

        {/* Reporte principal: por Área · Modelo · Sede */}
        <Card className="card-enter dark:bg-dark-card" style={{ animationDelay: "0ms" }}>
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div>
              <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text uppercase tracking-wider">
                Reporte por Área · Modelo · Sede
              </h2>
              <p className="text-[10px] dark:text-dark-muted text-light-muted mt-0.5">
                Columna &quot;{PERIOD_LABEL[periodo]} actual&quot; muestra el período más reciente disponible ({latestBucket || "—"})
              </p>
            </div>
            <div className="flex items-center gap-2 text-[11px] flex-wrap">
              <span className="dark:text-dark-muted text-light-muted">Ordenar:</span>
              {([
                { key: "paginasPeriodo", label: `${PERIOD_LABEL[periodo]} actual` },
                { key: "paginasTotal", label: "Desde inicio" },
                { key: "impresoras", label: "Equipos" },
              ] as const).map(opt => (
                <button
                  key={opt.key}
                  onClick={() => setSortBy(opt.key)}
                  className={`px-2 py-1 rounded font-semibold transition-colors cursor-pointer
                    ${sortBy === opt.key
                      ? "bg-brand-blue text-white"
                      : "dark:bg-dark-border bg-gray-100 dark:text-dark-muted text-light-muted"
                    }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {sortedRows.length > 0 ? (
            <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
              <table className="w-full text-left text-[11px] whitespace-nowrap">
                <thead className="sticky top-0 z-10 dark:bg-dark-card bg-white dark:text-dark-muted text-light-muted uppercase border-b dark:border-dark-border border-light-border">
                  <tr>
                    <th className="py-2 pr-3 font-bold">Área</th>
                    <th className="py-2 px-2 font-bold">Modelo</th>
                    <th className="py-2 px-2 font-bold">Sede</th>
                    <th className="py-2 px-2 font-bold text-right">Imps.</th>
                    <th className="py-2 px-2 font-bold text-right text-brand-blue">
                      {PERIOD_LABEL[periodo]} actual
                    </th>
                    <th className="py-2 px-2 font-bold text-right">Desde inicio</th>
                    <th className="py-2 pl-2 font-bold w-28">Relativo</th>
                  </tr>
                </thead>
                <tbody className="divide-y dark:divide-dark-border divide-light-border">
                  {sortedRows.map((r, i) => {
                    const pct = (r.paginasPeriodo / maxPaginasPeriodo) * 100;
                    return (
                      <tr
                        key={`${r.area}-${r.modelo}-${r.sede}`}
                        className="row-enter hover:dark:bg-dark-border/20 hover:bg-gray-50 transition-colors"
                        style={{ animationDelay: `${Math.min(i * 15, 300)}ms` }}
                      >
                        <td className="py-2 pr-3 font-medium dark:text-dark-text text-light-text">
                          {r.area}
                          {areaStartDate(r.area) && (
                            <span
                              title={`Inicio desde ${areaStartDate(r.area)} (equipo reemplazado)`}
                              className="ml-1.5 text-[9px] bg-orange-500/15 text-orange-500 px-1.5 py-0.5 rounded font-bold uppercase"
                            >
                              desde {areaStartDate(r.area)}
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-2 dark:text-dark-muted text-light-muted truncate max-w-[160px]">
                          {r.modelo}
                        </td>
                        <td className="py-2 px-2 dark:text-dark-muted text-light-muted">
                          {r.sede}
                        </td>
                        <td className="py-2 px-2 text-right dark:text-dark-muted text-light-muted">
                          {r.impresoras}
                        </td>
                        <td
                          className={`py-2 px-2 font-bold text-right ${r.paginasPeriodo > 0
                              ? "text-brand-blue"
                              : "dark:text-dark-muted text-light-muted"
                            }`}
                        >
                          {r.paginasPeriodo.toLocaleString()}
                        </td>
                        <td className="py-2 px-2 text-right dark:text-dark-text text-light-text">
                          {r.paginasTotal.toLocaleString()}
                        </td>
                        <td className="py-2 pl-2">
                          <div className="h-2 w-full dark:bg-dark-border bg-gray-200 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-brand-blue rounded-full transition-all duration-700 supply-bar"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-[11px] dark:text-dark-muted text-light-muted">
              No hay datos históricos suficientes.
            </p>
          )}
        </Card>

        {/* Tendencia histórica */}
        <Card className="card-enter dark:bg-dark-card" style={{ animationDelay: "100ms" }}>
          <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text mb-4 uppercase tracking-wider">
            Tendencia histórica — Páginas por {PERIOD_LABEL[periodo]}
          </h2>

          {tendencia.length > 0 ? (
            <>
              <div className="grid grid-cols-3 gap-3 mb-4">
                {[
                  { label: "Total acumulado", value: totalTend.toLocaleString(), sub: "páginas impresas" },
                  { label: "Período pico", value: picoPeriodo.label, sub: `${picoPeriodo.impresas.toLocaleString()} páginas` },
                  { label: "Períodos registrados", value: tendencia.length.toString(), sub: `resolución: ${PERIOD_LABEL[periodo].toLowerCase()}` },
                ].map(k => (
                  <div
                    key={k.label}
                    className="dark:bg-dark-border/30 bg-gray-50 rounded-lg p-3 border dark:border-dark-border border-light-border"
                  >
                    <p className="text-[9px] dark:text-dark-muted text-light-muted uppercase font-bold tracking-wider mb-1">
                      {k.label}
                    </p>
                    <p className="text-[16px] font-black text-brand-blue leading-tight">{k.value}</p>
                    <p className="text-[10px] dark:text-dark-muted text-light-muted">{k.sub}</p>
                  </div>
                ))}
              </div>

              <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
                <table className="w-full text-left text-[11px]">
                  <thead className="sticky top-0 z-10 dark:bg-dark-card bg-white dark:text-dark-muted text-light-muted uppercase border-b dark:border-dark-border border-light-border">
                    <tr>
                      <th className="py-2 pr-3 font-bold whitespace-nowrap">Período</th>
                      <th className="py-2 px-2 font-bold text-right whitespace-nowrap">Páginas</th>
                      <th className="py-2 px-2 font-bold text-right whitespace-nowrap">Equipos activos</th>
                      <th className="py-2 pl-2 font-bold w-40">Relativo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y dark:divide-dark-border divide-light-border">
                    {tendencia.map((d, i) => {
                      const isPico = d.label === picoPeriodo.label && d.impresas > 0;
                      const pct = (d.impresas / maxTendencia) * 100;
                      return (
                        <tr
                          key={d.label}
                          className={`row-enter ${isPico ? "dark:bg-brand-blue/10 bg-blue-50" : ""}`}
                          style={{ animationDelay: `${Math.min(i * 15, 300)}ms` }}
                        >
                          <td className="py-2 pr-3 font-mono dark:text-dark-text text-light-text whitespace-nowrap">
                            {d.label}
                            {isPico && (
                              <span className="ml-2 text-[9px] bg-brand-blue text-white px-1.5 py-0.5 rounded uppercase font-bold">
                                Pico
                              </span>
                            )}
                          </td>
                          <td
                            className={`py-2 px-2 font-bold text-right ${isPico ? "text-brand-blue" : "dark:text-dark-text text-light-text"
                              }`}
                          >
                            {d.impresas.toLocaleString()}
                          </td>
                          <td className="py-2 px-2 text-right dark:text-dark-muted text-light-muted">
                            {d.activas}
                          </td>
                          <td className="py-2 pl-2">
                            <div className="h-2 w-full dark:bg-dark-border bg-gray-200 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-brand-blue rounded-full"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-[11px] dark:text-dark-muted text-light-muted">
              No hay datos históricos suficientes.
            </p>
          )}
        </Card>

        {/* Estado global de suministros */}
        <Card className="card-enter dark:bg-dark-card" style={{ animationDelay: "200ms" }}>
          <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text mb-4 uppercase tracking-wider">
            Estado Global de Suministros
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[11px] whitespace-nowrap">
              <thead className="dark:text-dark-muted text-light-muted uppercase border-b dark:border-dark-border border-light-border">
                <tr>
                  <th className="py-2 pr-2 font-bold">Suministro</th>
                  <th className="py-2 px-2 font-bold text-right">Equipos</th>
                  <th className="py-2 px-2 font-bold text-right">Promedio</th>
                  <th className="py-2 px-2 font-bold text-center text-brand-red">Críticos (≤10%)</th>
                  <th className="py-2 px-2 font-bold text-center text-orange-500">Bajos (11–25%)</th>
                  <th className="py-2 pl-2 font-bold text-center text-brand-green">OK ({">"}25%)</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-dark-border divide-light-border">
                {suppStats.map((s, i) => (
                  <tr key={s.label} className="row-enter" style={{ animationDelay: `${i * 30}ms` }}>
                    <td className="py-2 pr-2 font-medium dark:text-dark-text text-light-text">
                      {s.label}
                    </td>
                    <td className="py-2 px-2 text-right dark:text-dark-muted text-light-muted">
                      {s.count}
                    </td>
                    <td className="py-2 px-2 font-bold text-right dark:text-dark-text text-light-text">
                      {s.promedio}%
                    </td>
                    <td className="py-2 px-2 text-center">
                      {s.critico > 0 ? (
                        <span className="bg-red-500/10 text-brand-red px-2 py-0.5 rounded font-bold">
                          {s.critico}
                        </span>
                      ) : (
                        <span className="dark:text-dark-border text-gray-300">-</span>
                      )}
                    </td>
                    <td className="py-2 px-2 text-center">
                      {s.bajo > 0 ? (
                        <span className="bg-orange-500/10 text-orange-500 px-2 py-0.5 rounded font-bold">
                          {s.bajo}
                        </span>
                      ) : (
                        <span className="dark:text-dark-border text-gray-300">-</span>
                      )}
                    </td>
                    <td className="py-2 pl-2 text-center">
                      {s.ok > 0 ? (
                        <span className="bg-green-500/10 text-brand-green px-2 py-0.5 rounded font-bold">
                          {s.ok}
                        </span>
                      ) : (
                        <span className="dark:text-dark-border text-gray-300">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

      </div>
    </div>
  );
}
