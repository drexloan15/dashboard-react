"use client";
import { useState, useMemo } from "react";
import Card from "@/components/ui/Card";
import StatPill from "@/components/ui/StatPill";
import { SUMINISTROS } from "@/types";
import type { Printer } from "@/types";
import { toNum } from "@/lib/utils";

type SendState = "idle" | "loading" | "ok" | "error";

export default function Alertas({ printers }: { printers: Printer[] }) {
  const [sendState, setSendState] = useState<SendState>("idle");
  const [sendMsg,   setSendMsg]   = useState("");
  const [filtroSede, setFiltroSede] = useState("Todas");
  const [filtroSum,  setFiltroSum]  = useState("Todos");
  const [listos, setListos] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("alertas_listos");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });

  function alertKey(a: { ip: string; suministro: string }) {
    return `${a.ip}::${a.suministro}`;
  }
  function toggleListo(key: string) {
    setListos(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      try { localStorage.setItem("alertas_listos", JSON.stringify([...next])); } catch {}
      return next;
    });
  }

  type Alert = { ip: string; sede: string; area: string; modelo: string; suministro: string; nivel: "CRÍTICO" | "BAJO"; color: string; valor: number };

  const todasAlertas = useMemo(() => {
    const result: Alert[] = [];
    for (const p of printers) {
      for (const [col, label] of SUMINISTROS) {
        const v = toNum(p[col]);
        if (v !== null && v <= 30) {
          result.push({
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
    return result.sort((a, b) => a.valor - b.valor);
  }, [printers]);

  const sedes   = useMemo(() => Array.from(new Set(todasAlertas.map(a => a.sede))).sort(), [todasAlertas]);
  const sumins  = useMemo(() => Array.from(new Set(todasAlertas.map(a => a.suministro))).sort(), [todasAlertas]);

  const alertas = useMemo(() =>
    todasAlertas.filter(a =>
      (filtroSede === "Todas" || a.sede === filtroSede) &&
      (filtroSum  === "Todos" || a.suministro === filtroSum)
    ), [todasAlertas, filtroSede, filtroSum]);

  const cn = alertas.filter(a => a.nivel === "CRÍTICO").length;
  const bn = alertas.filter(a => a.nivel === "BAJO").length;

  async function sendAlert() {
    setSendState("loading");
    setSendMsg("");
    try {
      const res = await fetch("/api/py/send-alert", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Error desconocido");
      if (data.sent) {
        setSendState("ok");
        setSendMsg(`Notificación enviada · ${data.alertas} alertas → ${data.destinatario}`);
      } else {
        setSendState("ok");
        setSendMsg(data.message);
      }
    } catch (e: unknown) {
      setSendState("error");
      setSendMsg(e instanceof Error ? e.message : "Error al enviar");
    }
  }

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
      <div className="flex items-start justify-between gap-4 mb-1 flex-wrap">
        <h1 className="page-title text-2xl font-bold dark:text-dark-text text-light-text">Alertas</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={filtroSede} onChange={e => setFiltroSede(e.target.value)}
            className="text-[11px] dark:bg-dark-card bg-white border dark:border-dark-border border-light-border rounded-lg px-2.5 py-1.5 dark:text-dark-text text-light-text outline-none cursor-pointer">
            <option value="Todas">Todas las sedes</option>
            {sedes.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filtroSum} onChange={e => setFiltroSum(e.target.value)}
            className="text-[11px] dark:bg-dark-card bg-white border dark:border-dark-border border-light-border rounded-lg px-2.5 py-1.5 dark:text-dark-text text-light-text outline-none cursor-pointer">
            <option value="Todos">Todos los suministros</option>
            {sumins.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <button
          onClick={sendAlert}
          disabled={sendState === "loading"}
          className="page-title flex items-center gap-2 px-4 py-2 rounded-lg text-[12px] font-semibold
            bg-brand-blue text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed
            transition-all cursor-pointer shrink-0"
          style={{ animationDelay: "60ms" }}
        >
          {sendState === "loading" ? "Enviando..." : "✉ Notificar por correo"}
          </button>
        </div>
      </div>
      <p className="page-title text-[13px] dark:text-dark-muted text-light-muted mb-2" style={{ animationDelay: "60ms" }}>
        {alertas.length} alertas activas
      </p>
      {sendMsg && (
        <p className={`text-[12px] mb-4 px-3 py-2 rounded-lg ${
          sendState === "error"
            ? "text-brand-red bg-brand-red/10"
            : "text-brand-green bg-brand-green/10"
        }`}>
          {sendState === "error" ? "✕ " : "✓ "}{sendMsg}
        </p>
      )}

      <div className="flex gap-2.5 mb-5">
        <Card className="flex-1 flex justify-center stat-enter" style={{ animationDelay: "80ms" }}>
          <StatPill value={cn} label="Críticos ≤10%" color="#f04545" />
        </Card>
        <Card className="flex-1 flex justify-center stat-enter" style={{ animationDelay: "120ms" }}>
          <StatPill value={bn} label="Bajos 11-30%"  color="#e0b030" />
        </Card>
        <Card className="flex-1 flex justify-center stat-enter" style={{ animationDelay: "160ms" }}>
          <StatPill value={listos.size} label="Listos p/ envío" color="#20c97a" />
        </Card>
      </div>

      <Card className="card-enter" style={{ animationDelay: "180ms" }}>
        <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest mb-3">
          Suministros en alerta
        </p>
        <div className="rounded-lg overflow-hidden dark:border-dark-border border border-light-border">
          {alertas.map((a, i) => {
            const key = alertKey(a);
            const listo = listos.has(key);
            return (
              <div key={i}
                className="row-enter flex items-center justify-between px-4 py-3 dark:border-dark-border border-b border-light-border last:border-0 transition-colors"
                style={{ background: listo ? "#20c97a08" : a.color + "08", animationDelay: `${200 + Math.min(i * 18, 300)}ms` }}>
                <div className="flex items-center gap-3 flex-wrap">
                  {!listo && (
                    <span className="text-[9px] font-bold px-2 py-0.5 rounded-full"
                      style={{ background: a.color + "22", color: a.color }}>
                      {a.nivel}
                    </span>
                  )}
                  {listo && (
                    <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-brand-green/20 text-brand-green">
                      LISTO
                    </span>
                  )}
                  <span className={`font-mono text-[12px] font-semibold ${listo ? "line-through dark:text-dark-muted text-light-muted" : "dark:text-dark-text text-light-text"}`}>
                    {a.ip}
                  </span>
                  <span className="text-[11px] dark:text-dark-muted text-light-muted">{a.sede}</span>
                  {a.modelo && <span className="text-[10px] font-medium dark:text-dark-muted text-light-muted bg-black/10 dark:bg-white/5 px-1.5 py-0.5 rounded">{a.modelo}</span>}
                  {a.area && <span className="text-[11px] dark:text-dark-muted text-light-muted">{a.area.slice(0, 28)}</span>}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[11px] dark:text-dark-muted text-light-muted">{a.suministro}</span>
                  <span className="text-[15px] font-bold" style={{ color: listo ? "#20c97a" : a.color }}>{a.valor.toFixed(0)}%</span>
                  <button onClick={() => toggleListo(key)}
                    title={listo ? "Desmarcar" : "Marcar como listo para envío"}
                    className="w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all cursor-pointer shrink-0"
                    style={{
                      borderColor: listo ? "#20c97a" : "#4a5568",
                      background: listo ? "#20c97a" : "transparent",
                    }}>
                    {listo && <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M1.5 5l2.5 2.5 4.5-4.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
