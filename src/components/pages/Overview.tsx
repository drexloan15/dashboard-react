"use client";
import { useState, useEffect, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  LineChart, Line, Legend
} from "recharts";
import Card from "@/components/ui/Card";

function useCountUp(target: number, duration = 900): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let start: number;
    let animFrame: number;
    const step = (timestamp: number) => {
      if (!start) start = timestamp;
      const progress = timestamp - start;
      const ratio = Math.min(progress / duration, 1);
      setCount(Math.round(ratio * target));
      if (progress < duration) {
        animFrame = requestAnimationFrame(step);
      }
    };
    animFrame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animFrame);
  }, []);
  return count;
}
import { SUMINISTROS } from "@/types";
import type { Printer, HistorialRow } from "@/types";
import { toNum, nivelColor } from "@/lib/utils";
import PredSection from "@/components/PredSection";

interface Props { printers: Printer[]; historial: HistorialRow[]; }

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (!data || data.length < 2) return null;
  const chartData = data.map((v, i) => ({ i, v }));
  const min = Math.min(...data);
  const max = Math.max(...data);
  const domain = [min === max ? min - 1 : 'dataMin', max === min ? max + 1 : 'dataMax'];

  return (
    <div className="absolute bottom-0 left-0 right-0 h-10 opacity-30 pointer-events-none rounded-b-2xl overflow-hidden">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <YAxis domain={domain as any} hide />
          <Line type="monotone" dataKey="v" stroke={color} strokeWidth={2.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ── Gauge SVG personalizado ─────────────────────────────────────────────── */
function GaugeSVG({ value, color }: { value: number; color: string }) {
  const r = 75, cx = 100, cy = 84;
  const C = Math.PI * r;
  const offset = C * (1 - value / 100);
  const path = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;

  return (
    <svg viewBox="0 0 200 120" className="w-full" role="img" aria-label={`Medidor de Salud Suministros: ${value}%`}>
      {/* Pista de fondo con zonas de color */}
      <path d={path} fill="none" stroke="#f04545" strokeWidth="12" opacity="0.25"
        strokeDasharray={`${C * 0.3} ${C}`} strokeDashoffset={0} />
      <path d={path} fill="none" stroke="#e0b030" strokeWidth="12" opacity="0.25"
        strokeDasharray={`${C * 0.3} ${C}`} strokeDashoffset={-C * 0.3} />
      <path d={path} fill="none" stroke="#20c97a" strokeWidth="12" opacity="0.25"
        strokeDasharray={`${C * 0.4} ${C}`} strokeDashoffset={-C * 0.6} />

      {/* Arco principal */}
      <path className="gauge-arc" d={path} fill="none" stroke={color} strokeWidth="12"
        strokeLinecap="round" strokeDasharray={C}
        style={{ strokeDashoffset: offset, filter: `drop-shadow(0 0 6px ${color}88)` }} />

      {/* Etiquetas 0% / 100% */}
      <text x={cx - r + 4} y={cy + 16} fontSize="9" fill="#6d8fa8" textAnchor="middle">0%</text>
      <text x={cx + r - 4} y={cy + 16} fontSize="9" fill="#6d8fa8" textAnchor="middle">100%</text>

      {/* Textos centrales */}
      <text x={cx} y={cy + 12} fontSize="34" fontWeight="bold" fill={color} textAnchor="middle">
        {value}%
      </text>
    </svg>
  );
}

/* ── Componente principal ────────────────────────────────────────────────── */
export default function Overview({ printers, historial }: Props) {
  const [sedeScale, setSedeScale] = useState<"auto" | "log">("auto");
  const total = printers.length;

  // Métricas de suministros
  let totalCrit = 0, totalBajo = 0, totalReadings = 0, okReadings = 0;
  const tiposAfectados = new Set<string>();
  for (const [col, label] of SUMINISTROS) {
    const vals = printers.map(p => toNum(p[col])).filter(v => v !== null) as number[];
    totalReadings += vals.length;
    okReadings += vals.filter(v => v > 30).length;
    const c = vals.filter(v => v <= 10).length;
    const b = vals.filter(v => v > 10 && v <= 30).length;
    if (c + b > 0) tiposAfectados.add(label);
    totalCrit += c;
    totalBajo += b;
  }
  const saludGlobal = totalReadings ? Math.round(okReadings / totalReadings * 100) : 0;
  const gaugeColor = saludGlobal >= 80 ? "#20c97a" : saludGlobal >= 50 ? "#e0b030" : "#f04545";

  // Equipos por sede
  const sedeMap: Record<string, { on: number; off: number }> = {};
  for (const p of printers) {
    const s = p.SEDE || "?";
    if (!sedeMap[s]) sedeMap[s] = { on: 0, off: 0 };
    p.ESTADO === "Online" ? sedeMap[s].on++ : sedeMap[s].off++;
  }
  const sedeData = Object.entries(sedeMap).map(([sede, v]) => ({ sede, ...v }));

  // Top 15 tóner negro más críticos
  const tonerData = printers
    .map(p => ({
      ip: p.IP,
      v: toNum(p.TONER_NEGRO),
      sede: p.SEDE || "Desconocida",
      area: p.AREA || p.ZONA || "Sin área",
    }))
    .filter(x => x.v !== null)
    .sort((a, b) => (a.v as number) - (b.v as number))
    .slice(0, 15);

  // Suministros promedio (mini cards)
  const supplyCards = SUMINISTROS.map(([col, label]) => {
    const vals = printers.map(p => toNum(p[col])).filter(v => v !== null) as number[];
    if (!vals.length) return null;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const crit = vals.filter(v => v <= 10).length;
    const bajo = vals.filter(v => v > 10 && v <= 30).length;
    return { label, avg, crit, bajo, color: nivelColor(avg, "dark") };
  }).filter(Boolean);

  // Calcular tendencias de los últimos 7 días
  const trends = useMemo(() => {
    if (!historial.length) return { alert: [], crit: [], low: [], types: [], health: [] };

    const dh = historial.map(r => ({ ...r, _tsD: new Date(r._ts || r.TIMESTAMP || r.FECHA || "") }))
      .filter(r => !isNaN(r._tsD.getTime()))
      .sort((a, b) => a._tsD.getTime() - b._tsD.getTime());

    if (!dh.length) return { alert: [], crit: [], low: [], types: [], health: [] };

    const dayStrs = Array.from(new Set(dh.map(r => r._tsD.toDateString()))).slice(-7);

    const alert: number[] = [], crit: number[] = [], low: number[] = [], types: number[] = [], health: number[] = [];

    for (const dStr of dayStrs) {
      const limitTime = new Date(dStr).setHours(23, 59, 59, 999);

      const latestPerIp = new Map<string, any>();
      for (const r of dh) {
        if (r._tsD.getTime() <= limitTime) latestPerIp.set(r.IP, r);
      }

      let dCrit = 0, dBajo = 0, dReadings = 0, dOk = 0;
      const dTypes = new Set<string>();

      for (const p of latestPerIp.values()) {
        for (const [col, label] of SUMINISTROS) {
          const val = toNum(p[col]);
          if (val !== null) {
            dReadings++;
            if (val > 30) dOk++;
            if (val <= 10) { dCrit++; dTypes.add(label); }
            else if (val <= 30) { dBajo++; dTypes.add(label); }
          }
        }
      }

      alert.push(dCrit + dBajo);
      crit.push(dCrit);
      low.push(dBajo);
      types.push(dTypes.size);
      health.push(dReadings ? Math.round((dOk / dReadings) * 100) : 0);
    }

    return { alert, crit, low, types, health };
  }, [historial]);

  const animatedKpi0 = useCountUp(totalCrit + totalBajo);
  const animatedKpi1 = useCountUp(totalCrit);
  const animatedKpi2 = useCountUp(totalBajo);
  const animatedKpi3 = useCountUp(tiposAfectados.size);

  const kpis = [
    { value: animatedKpi0, label: "Total Alertas", sub: `${totalCrit} crít. · ${totalBajo} bajos`, color: "#3d8ef5", trend: trends.alert },
    { value: animatedKpi1, label: "Críticos ≤10%", sub: "atención urgente", color: "#f04545", trend: trends.crit },
    { value: animatedKpi2, label: "Bajos 11–30%", sub: "por agotarse", color: "#e0b030", trend: trends.low },
    { value: animatedKpi3, label: "Sumin. afectados", sub: "tipos con alerta", color: "#f97316", trend: trends.types },
  ];

  const ttStyle = {
    background: "#0f1824", border: "1px solid #2a3a50",
    borderRadius: 8, fontSize: 11, fontFamily: "Inter", color: "#c8daea",
  };
  const ttLabel = { color: "#e2eaf4", fontWeight: 600 };
  const ttItem = { color: "#c8daea" };

  return (
    <div>
      <h1 className="page-title text-2xl font-bold mb-1 dark:text-dark-text text-light-text">
        Panel de Control
      </h1>
      <p className="page-title text-[13px] dark:text-dark-muted text-light-muted mb-5"
        style={{ animationDelay: "50ms" }}>
        {total} equipos monitoreados
      </p>

      {/* ── KPI grid (2 cols móvil → 5 cols escritorio) ── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5 auto-rows-fr">

        {/* Gauge Card unificada */}
        <div className="kpi-card col-span-2 lg:col-span-1 relative rounded-2xl p-4 sm:p-5 overflow-hidden
          flex flex-col justify-between dark:bg-dark-card bg-white"
          style={{ border: `1px solid ${gaugeColor}28`, animationDelay: "260ms" }}>
          <div className="absolute top-0 inset-x-0 h-[2.5px] rounded-t-2xl"
            style={{ background: `linear-gradient(90deg, ${gaugeColor}dd, transparent 70%)` }} />
          <div className="absolute -top-10 -left-10 w-32 h-32 rounded-full pointer-events-none"
            style={{ background: gaugeColor, opacity: 0.09, filter: "blur(28px)" }} />

          <div className="relative w-full max-w-[120px] mx-auto mb-3 flex-1 flex items-center justify-center pt-2">
            <GaugeSVG value={saludGlobal} color={gaugeColor} />
          </div>

          <div className="relative mt-auto z-10">
            <div className="text-[10px] sm:text-[11px] font-bold uppercase tracking-widest dark:text-white/75 text-gray-600">
              Salud Global
            </div>
            <div className="text-[9px] sm:text-[10px] dark:text-white/35 text-gray-400 mt-0.5">
              estado suministros
            </div>
          </div>
          <Sparkline data={trends.health} color={gaugeColor} />
        </div>

        {kpis.map((c, i) => (
          <div key={i}
            className="kpi-card relative rounded-2xl p-4 sm:p-5 overflow-hidden cursor-default select-none dark:bg-dark-card bg-white flex flex-col justify-between"
            style={{ border: `1px solid ${c.color}28`, animationDelay: `${i * 65}ms` }}>
            <div className="absolute top-0 inset-x-0 h-[2.5px] rounded-t-2xl"
              style={{ background: `linear-gradient(90deg, ${c.color}dd, transparent 70%)` }} />
            <div className="absolute -top-10 -left-10 w-32 h-32 rounded-full pointer-events-none"
              style={{ background: c.color, opacity: 0.09, filter: "blur(28px)" }} />

            <div className="relative text-[38px] sm:text-[46px] font-black leading-none mb-4 tabular-nums pt-1"
              style={{ color: c.color, textShadow: `0 0 28px ${c.color}50` }}>
              {c.value}
            </div>

            <div className="relative mt-auto z-10">
              <div className="text-[10px] sm:text-[11px] font-bold uppercase tracking-widest dark:text-white/80 text-gray-700">
                {c.label}
              </div>
              <div className="text-[9px] sm:text-[10px] dark:text-white/50 text-gray-500 mt-0.5">
                {c.sub}
              </div>
            </div>
            <Sparkline data={c.trend} color={c.color} />
          </div>
        ))}

      </div>

      {/* ── Gráficos (1 col móvil → 3 cols md) ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 mb-4">
        <Card className="card-enter md:col-span-1" style={{ animationDelay: "120ms" }}>
          <div className="flex justify-between items-center mb-3">
            <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest">
              Equipos por sede
            </p>
            <button
              onClick={() => setSedeScale(s => s === "auto" ? "log" : "auto")}
              className="text-[9px] font-bold px-2 py-0.5 rounded border dark:border-dark-border border-light-border dark:text-dark-muted text-light-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors uppercase cursor-pointer"
            >
              Escala: {sedeScale}
            </button>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={sedeData} margin={{ top: 4, bottom: 50, left: 0, right: 4 }}>
              <XAxis dataKey="sede" tick={{ fontSize: 9, fill: "#8aa4be" }} angle={-35} textAnchor="end" interval={0} />
              <YAxis scale={sedeScale} domain={sedeScale === "log" ? [0.1, 'auto'] : [0, 'auto']} tickFormatter={(v) => v < 1 ? '' : v} tick={{ fontSize: 9, fill: "#8aa4be" }} allowDataOverflow={true} />
              <Tooltip contentStyle={ttStyle} labelStyle={ttLabel} itemStyle={ttItem} />
              <Legend wrapperStyle={{ fontSize: 10, paddingTop: 25 }} />
              <Bar dataKey="on" name="Online" fill="#20c97a" opacity={0.9} stackId={sedeScale === "auto" ? "a" : undefined} />
              <Bar dataKey="off" name="Offline" fill="#f04545" opacity={0.9} stackId={sedeScale === "auto" ? "a" : undefined} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card className="card-enter md:col-span-2" style={{ animationDelay: "180ms" }}>
          <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest mb-3">
            Top 15 · Tóner Negro (más críticos)
          </p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={tonerData} margin={{ top: 4, bottom: 50, left: 0, right: 4 }}>
              <XAxis dataKey="ip" tick={{ fontSize: 9, fill: "#8aa4be" }} angle={-35} textAnchor="end" interval={0} />
              <YAxis domain={[0, 115]} tick={{ fontSize: 9, fill: "#8aa4be" }} />
              <Tooltip
                cursor={{ fill: 'rgba(255, 255, 255, 0.05)' }}
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const data = payload[0].payload;
                    return (
                      <div style={ttStyle} className="p-2 shadow-lg z-50 relative">
                        <div style={ttLabel} className="mb-1.5">{data.ip}</div>
                        <div className="text-[11px] font-bold mb-1" style={{ color: nivelColor(data.v, "dark") }}>
                          {data.v.toFixed(0)}% Tóner Negro
                        </div>
                        <div className="text-[9px] text-gray-300 mt-1.5">Sede: <span className="text-gray-200 font-medium">{data.sede}</span></div>
                        <div className="text-[9px] text-gray-300">Área: <span className="text-gray-200 font-medium">{data.area}</span></div>
                      </div>
                    );
                  }
                  return null;
                }}
              />
              <Bar dataKey="v" radius={[3, 3, 0, 0]}>
                {tonerData.map((d, i) => (
                  <Cell key={i} fill={nivelColor(d.v, "dark")} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* ── Suministros promedio ── */}
      <Card className="mb-4 card-enter" style={{ animationDelay: "240ms" }}>
        <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest mb-4">
          Suministros promedio
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
          {supplyCards.map((sc, i) => sc && (
            <div key={sc.label}
              className="card-enter dark:bg-dark-card bg-gray-50 dark:border-dark-border border-light-border border rounded-xl p-3"
              style={{ animationDelay: `${i * 45}ms` }}>
              <div className="text-[9px] dark:text-dark-muted text-light-muted font-semibold uppercase mb-2 truncate" title={sc.label}>
                {sc.label}
              </div>
              <div className="text-xl font-bold mb-1.5 leading-none" style={{ color: sc.color }}>
                {sc.avg.toFixed(0)}%
              </div>
              <div className="h-[3px] dark:bg-dark-border2 bg-light-border2 rounded-full mb-1.5 overflow-hidden">
                <div className="h-full rounded-full supply-bar"
                  style={{ width: `${Math.min(sc.avg, 100).toFixed(0)}%`, background: sc.color }} />
              </div>
              <div className="flex gap-2 flex-wrap min-h-[16px] items-center">
                {sc.crit > 0 && <span className="text-[10px] text-brand-red font-bold">▲ {sc.crit}</span>}
                {sc.bajo > 0 && <span className="text-[10px] text-brand-yellow font-bold">↓ {sc.bajo}</span>}
                {sc.crit === 0 && sc.bajo === 0 && (
                  <span className="text-[9px] text-brand-green font-bold bg-brand-green/10 px-1.5 py-0.5 rounded uppercase">
                    OK
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <PredSection printers={printers} historial={historial} />
    </div>
  );
}