"use client";
import { useState, useEffect } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
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

/* ── Gauge SVG personalizado ─────────────────────────────────────────────── */
function GaugeSVG({ value, color }: { value: number; color: string }) {
  const r = 75, cx = 100, cy = 84;
  const C = Math.PI * r;
  const offset = C * (1 - value / 100);
  const path = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;

  return (
    <svg viewBox="0 0 200 120" className="w-full" aria-hidden>
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
      <text x={cx} y={cy + 6} fontSize="28" fontWeight="bold" fill={color} textAnchor="middle">
        {value}%
      </text>
      <text x={cx} y={cy + 22} fontSize="8" fill="#6d8fa8" textAnchor="middle" style={{ textTransform: "uppercase" }}>
        SALUD SUMINISTROS
      </text>
    </svg>
  );
}

/* ── Componente principal ────────────────────────────────────────────────── */
export default function Overview({ printers, historial }: Props) {
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
    .map(p => ({ ip: p.IP, v: toNum(p.TONER_NEGRO) }))
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

  const animatedKpi0 = useCountUp(totalCrit + totalBajo);
  const animatedKpi1 = useCountUp(totalCrit);
  const animatedKpi2 = useCountUp(totalBajo);
  const animatedKpi3 = useCountUp(tiposAfectados.size);

  const kpis = [
    { value: animatedKpi0, label: "Total Alertas", sub: `${totalCrit} crít. · ${totalBajo} bajos`, color: "#3d8ef5" },
    { value: animatedKpi1, label: "Críticos ≤10%", sub: "atención urgente", color: "#f04545" },
    { value: animatedKpi2, label: "Bajos 11–30%", sub: "por agotarse", color: "#e0b030" },
    { value: animatedKpi3, label: "Tipos de suministros afectados", sub: "suministros con alerta", color: "#f97316" },
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
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">

        {kpis.map((c, i) => (
          <div key={i}
            className="kpi-card relative rounded-2xl p-4 sm:p-5 overflow-hidden cursor-default select-none dark:bg-dark-card bg-white"
            style={{ border: `1px solid ${c.color}28`, animationDelay: `${i * 65}ms` }}>
            <div className="absolute top-0 inset-x-0 h-[2.5px] rounded-t-2xl"
              style={{ background: `linear-gradient(90deg, ${c.color}dd, transparent 70%)` }} />
            <div className="absolute -top-10 -left-10 w-32 h-32 rounded-full pointer-events-none"
              style={{ background: c.color, opacity: 0.09, filter: "blur(28px)" }} />
            <div className="relative text-[38px] sm:text-[46px] font-black leading-none mb-2 tabular-nums"
              style={{ color: c.color, textShadow: `0 0 28px ${c.color}50` }}>
              {c.value}
            </div>
            <div className="text-[10px] sm:text-[11px] font-bold uppercase tracking-widest dark:text-white/75 text-gray-600 relative">
              {c.label}
            </div>
            <div className="text-[9px] sm:text-[10px] dark:text-white/35 text-gray-400 mt-0.5 relative">{c.sub}</div>
          </div>
        ))}

        {/* Gauge: ancho completo en móvil, 1 col en lg */}
        <div className="kpi-card col-span-2 lg:col-span-1 relative rounded-2xl overflow-hidden
          flex flex-col items-center justify-center py-3 px-4 dark:bg-dark-card bg-white"
          style={{ border: `1px solid ${gaugeColor}28`, animationDelay: "260ms" }}>
          <div className="absolute top-0 inset-x-0 h-[2.5px] rounded-t-2xl"
            style={{ background: `linear-gradient(90deg, ${gaugeColor}dd, transparent 70%)` }} />
          <div className="absolute -top-10 -left-10 w-32 h-32 rounded-full pointer-events-none"
            style={{ background: gaugeColor, opacity: 0.09, filter: "blur(28px)" }} />

          {/* SVG gauge — max-w para no verse gigante en móvil (full-width) */}
          <div className="w-full max-w-[260px] mx-auto">
            <GaugeSVG value={saludGlobal} color={gaugeColor} />
          </div>
        </div>
      </div>

      {/* ── Gráficos (1 col móvil → 3 cols md) ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 mb-4">
        <Card className="card-enter md:col-span-1" style={{ animationDelay: "120ms" }}>
          <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest mb-3">
            Equipos por sede
          </p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={sedeData} margin={{ top: 4, bottom: 50, left: 0, right: 4 }}>
              <XAxis dataKey="sede" tick={{ fontSize: 9, fill: "#8aa4be" }} angle={-35} textAnchor="end" interval={0} />
              <YAxis tick={{ fontSize: 9, fill: "#8aa4be" }} />
              <Tooltip contentStyle={ttStyle} labelStyle={ttLabel} itemStyle={ttItem} />
              <Bar dataKey="on" name="Online" fill="#20c97a" opacity={0.9} stackId="a" />
              <Bar dataKey="off" name="Offline" fill="#f04545" opacity={0.9} stackId="a" radius={[3, 3, 0, 0]} />
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
              <Tooltip contentStyle={ttStyle} labelStyle={ttLabel} itemStyle={ttItem}
                formatter={(v: number) => [`${v.toFixed(0)}%`, "Tóner Negro"]} />
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
              <div className="text-[9px] dark:text-dark-muted text-light-muted font-semibold uppercase mb-2 truncate">
                {sc.label}
              </div>
              <div className="text-xl font-bold mb-1.5 leading-none" style={{ color: sc.color }}>
                {sc.avg.toFixed(0)}%
              </div>
              <div className="h-[3px] dark:bg-dark-border2 bg-light-border2 rounded-full mb-1.5 overflow-hidden">
                <div className="h-full rounded-full supply-bar"
                  style={{ width: `${Math.min(sc.avg, 100).toFixed(0)}%`, background: sc.color }} />
              </div>
              <div className="flex gap-1 flex-wrap">
                {sc.crit > 0 && <span className="text-[9px] text-brand-red">▲{sc.crit}</span>}
                {sc.bajo > 0 && <span className="text-[9px] text-brand-yellow">↓{sc.bajo}</span>}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <PredSection printers={printers} historial={historial} />
    </div>
  );
}