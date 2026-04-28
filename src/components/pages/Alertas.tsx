"use client";
import Card from "@/components/ui/Card";
import StatPill from "@/components/ui/StatPill";
import { SUMINISTROS } from "@/types";
import type { Printer } from "@/types";
import { toNum } from "@/lib/utils";

export default function Alertas({ printers }: { printers: Printer[] }) {
  type Alert = { ip: string; sede: string; area: string; modelo: string; suministro: string; nivel: "CRÍTICO" | "BAJO"; color: string; valor: number };
  const alertas: Alert[] = [];

  for (const p of printers) {
    for (const [col, label] of SUMINISTROS) {
      const v = toNum(p[col]);
      if (v !== null && v <= 30) {
        alertas.push({
          ip: p.IP, sede: p.SEDE, area: p.AREA || "",
          modelo: String(p.MODELO_INV || ""),
          suministro: label,
          nivel: v <= 10 ? "CRÍTICO" : "BAJO",
          color: v <= 10 ? "#f04545" : "#e0b030",
          valor: v,
        });
      }
    }
  }
  alertas.sort((a, b) => a.valor - b.valor);

  const cn = alertas.filter(a => a.nivel === "CRÍTICO").length;
  const bn = alertas.filter(a => a.nivel === "BAJO").length;

  if (!alertas.length) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6 dark:text-dark-text text-light-text">Alertas</h1>
        <Card className="text-center py-12">
          <div className="text-4xl text-brand-green mb-3">✓</div>
          <p className="text-brand-green font-bold text-lg">Sin alertas</p>
          <p className="text-[12px] dark:text-dark-muted text-light-muted mt-1">Todos los suministros &gt; 30%</p>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <h1 className="page-title text-2xl font-bold mb-1 dark:text-dark-text text-light-text">Alertas</h1>
      <p className="page-title text-[13px] dark:text-dark-muted text-light-muted mb-6" style={{ animationDelay: "60ms" }}>
        {alertas.length} alertas activas
      </p>

      <div className="flex gap-2.5 mb-5">
        <Card className="flex-1 flex justify-center stat-enter" style={{ animationDelay: "80ms" }}>
          <StatPill value={cn} label="Críticos ≤10%" color="#f04545" />
        </Card>
        <Card className="flex-1 flex justify-center stat-enter" style={{ animationDelay: "140ms" }}>
          <StatPill value={bn} label="Bajos 11-30%"  color="#e0b030" />
        </Card>
      </div>

      <Card className="card-enter" style={{ animationDelay: "180ms" }}>
        <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest mb-3">
          Suministros en alerta
        </p>
        <div className="rounded-lg overflow-hidden dark:border-dark-border border border-light-border">
          {alertas.map((a, i) => (
            <div key={i}
              className="row-enter flex items-center justify-between px-4 py-3 dark:border-dark-border border-b border-light-border last:border-0"
              style={{ background: a.color + "08", animationDelay: `${200 + Math.min(i * 18, 300)}ms` }}>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-[9px] font-bold px-2 py-0.5 rounded-full"
                  style={{ background: a.color + "22", color: a.color }}>
                  {a.nivel}
                </span>
                <span className="font-mono text-[12px] font-semibold dark:text-dark-text text-light-text">{a.ip}</span>
                <span className="text-[11px] dark:text-dark-muted text-light-muted">{a.sede}</span>
                {a.modelo && <span className="text-[10px] font-medium dark:text-dark-muted text-light-muted bg-black/10 dark:bg-white/5 px-1.5 py-0.5 rounded">{a.modelo}</span>}
                {a.area && <span className="text-[11px] dark:text-dark-muted text-light-muted">{a.area.slice(0, 28)}</span>}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-[11px] dark:text-dark-muted text-light-muted">{a.suministro}</span>
                <span className="text-[15px] font-bold" style={{ color: a.color }}>{a.valor.toFixed(0)}%</span>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
