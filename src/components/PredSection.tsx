"use client";
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

  // Parsear timestamps
  const dh = historial.map(r => ({
    ...r,
    _tsD: new Date(r._ts || r.TIMESTAMP || r.FECHA || ""),
  })).filter(r => !isNaN(r._tsD.getTime()));

  const fechasUnicas = new Set(dh.map(r => r._tsD.toDateString()));
  const diasUnicos = fechasUnicas.size;

  const preds: Pred[] = [];
  const TASA_STD = 0.8;

  for (const [col, label] of SUMINISTROS) {
    for (const p of printers) {
      const curr = toNum(p[col]);
      if (curr === null || curr > 30) continue;

      const ipRows = dh.filter(r => r.IP === p.IP);
      let tasa = TASA_STD;

      if (ipRows.length >= 2) {
        const sorted = ipRows.sort((a, b) => a._tsD.getTime() - b._tsD.getTime());

        // Regresión lineal si ≥7 días
        if (diasUnicos >= 7) {
          const vals = sorted.map(r => toNum((r as Record<string, unknown>)[col])).filter(v => v !== null) as number[];
          const ts   = sorted.map(r => r._tsD.getTime());
          if (vals.length >= 2) {
            // Detectar reposición
            let start = 0;
            for (let i = vals.length - 1; i > 0; i--) {
              if (vals[i] - vals[i - 1] > 20) { start = i; break; }
            }
            const v2 = vals.slice(start);
            const t2 = ts.slice(start);
            if (v2.length >= 2) {
              const n = v2.length;
              const t0 = t2[0];
              const days = t2.map(t => (t - t0) / 86400000);
              const mx = days.reduce((a, b) => a + b, 0) / n;
              const my = v2.reduce((a, b) => a + b, 0) / n;
              const num = days.reduce((s, x, i) => s + (x - mx) * (v2[i] - my), 0);
              const den = days.reduce((s, x) => s + (x - mx) ** 2, 0);
              if (den > 0) {
                const slope = num / den;
                if (slope < -0.001) tasa = Math.abs(slope);
              }
            }
          }
        } else {
          // Modo simple
          const v0 = toNum((sorted[0] as Record<string, unknown>)[col]);
          const vn = toNum((sorted[sorted.length - 1] as Record<string, unknown>)[col]);
          const dt = (sorted[sorted.length - 1]._tsD.getTime() - sorted[0]._tsD.getTime()) / 86400000;
          if (v0 !== null && vn !== null && dt > 0 && v0 > vn) {
            tasa = (v0 - vn) / dt;
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
        color: dias <= 7 ? "#f04545" : dias <= 20 ? "#e0b030" : "#20c97a",
      });
    }
  }

  preds.sort((a, b) => a.dias - b.dias);
  return { preds, diasUnicos };
}

export default function PredSection({ printers, historial }: { printers: Printer[]; historial: HistorialRow[] }) {
  const { preds, diasUnicos } = calcPreds(printers, historial);
  const urgentes = preds.filter(p => p.dias <= 7).length;
  const proximos = preds.filter(p => p.dias > 7 && p.dias <= 20).length;

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
      <div className="flex justify-between items-center mb-3">
        <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest">
          Predicción agotamiento {diasUnicos < 7 ? "(aproximada)" : ""}
        </p>
        <div className="flex gap-3">
          {urgentes > 0 && <span className="text-[10px] font-semibold text-brand-red">⚠ {urgentes} urgentes</span>}
          {proximos > 0 && <span className="text-[10px] font-semibold text-brand-yellow">↓ {proximos} en 8-20d</span>}
        </div>
      </div>
      <div className="rounded-lg overflow-hidden dark:border-dark-border border border-light-border">
        {preds.slice(0, 25).map((p, i) => (
          <div key={i}
            className="row-enter flex items-center px-4 py-2.5 dark:border-dark-border border-b border-light-border last:border-0"
            style={{ background: p.color + "08", animationDelay: `${Math.min(i * 20, 350)}ms` }}>
            <div className="text-[13px] font-extrabold text-center rounded-lg px-3 py-2 mr-3 min-w-[52px]"
              style={{ color: p.color, background: p.color + "18", border: `1px solid ${p.color}44` }}>
              {p.dias.toFixed(0)}d
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-[12px] font-semibold dark:text-dark-text text-light-text">{p.ip}</span>
                <span className="text-[11px] dark:text-dark-muted text-light-muted">{p.sede}</span>
                {p.modelo && <span className="text-[10px] font-medium dark:text-dark-muted text-light-muted bg-black/10 dark:bg-white/5 px-1.5 py-0.5 rounded">{p.modelo}</span>}
                {p.area && <span className="text-[10px] dark:text-dark-muted text-light-muted">· {p.area.slice(0, 25)}</span>}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-brand-cyan">{p.suministro}</span>
                <span className="text-[9px] dark:text-dark-muted text-light-muted">↓{p.tasa}%/día</span>
              </div>
            </div>
            <div className="text-[14px] font-extrabold ml-2 shrink-0" style={{ color: nivelColor(p.nivel, "dark") }}>
              {p.nivel.toFixed(0)}%
            </div>
          </div>
        ))}
      </div>
      <p className="text-[9px] dark:text-dark-muted text-light-muted text-right mt-2">
        {diasUnicos >= 7 ? "Regresión lineal · últimos 30 días · detección reposición" : `Predicción simple · ${diasUnicos} días de datos`}
      </p>
    </Card>
  );
}
