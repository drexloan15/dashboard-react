"use client";
import { useState, useMemo, useRef, useEffect } from "react";
import axios from "axios";
import Card from "@/components/ui/Card";
import StatPill from "@/components/ui/StatPill";
import { SUMINISTROS } from "@/types";
import type { Printer } from "@/types";
import { toNum } from "@/lib/utils";
import { useAlertasStatus, useAlertasMutation, useVerifyPin } from "@/hooks/useData";

type SendState = "idle" | "loading" | "ok" | "error";

function CheckBtn({ active, color, title, onClick, disabled }: {
  active: boolean; color: string; title: string;
  onClick: () => void; disabled?: boolean;
}) {
  return (
    <button onClick={onClick} title={title} disabled={disabled}
      className="w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all shrink-0"
      style={{
        borderColor: active ? color : disabled ? "#2a3a4a" : "#4a5568",
        background: active ? color : "transparent",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
      }}>
      {active && <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d="M1.5 5l2.5 2.5 4.5-4.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>}
    </button>
  );
}

function PinModal({ lockout, maxLockout, onRateLimited, onSuccess, onClose }: {
  lockout:       number;
  maxLockout:    number;
  onRateLimited: (secs: number) => void;
  onSuccess:     () => void;
  onClose:       () => void;
}) {
  const [pin, setPin]     = useState("");
  const [error, setError] = useState(false);
  const inputRef          = useRef<HTMLInputElement>(null);
  const verifyPin         = useVerifyPin();
  const isPending         = verifyPin.isPending;
  const isLocked          = lockout > 0;

  // Foco automático al montar y cuando se libera el bloqueo
  useEffect(() => {
    if (!isLocked) inputRef.current?.focus();
  }, [isLocked]);

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (isLocked || isPending) return;
    try {
      const ok = await verifyPin.mutateAsync(pin);
      if (ok) {
        onSuccess();
      } else {
        setError(true);
        setPin("");
        setTimeout(() => setError(false), 1500);
      }
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        const detail = err.response.data?.detail;
        const secs = typeof detail === "object" && detail?.retry_after
          ? Number(detail.retry_after)
          : 30;
        onRateLimited(secs);   // lockout se gestiona en el padre
        setPin("");
      } else {
        setError(true);
        setPin("");
        setTimeout(() => setError(false), 1500);
      }
    }
  }

  const pct = maxLockout > 0 ? (lockout / maxLockout) * 100 : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}>
      <div className="dark:bg-dark-card bg-white rounded-2xl p-6 w-72 shadow-2xl border dark:border-dark-border border-light-border"
        onClick={e => e.stopPropagation()}>

        <p className="text-[13px] font-bold dark:text-dark-text text-light-text mb-1">Acceso Admin</p>
        <p className="text-[11px] dark:text-dark-muted text-light-muted mb-4">
          Ingresa el PIN para editar alertas
        </p>

        {isLocked ? (
          /* ── Estado bloqueado ── */
          <div className="text-center py-2 mb-1">
            <div className="text-[52px] font-black tabular-nums leading-none text-brand-red mb-2">
              {lockout}s
            </div>
            <p className="text-[11px] dark:text-dark-muted text-light-muted leading-relaxed">
              Demasiados intentos fallidos.<br />Espera antes de volver a intentarlo.
            </p>
            <div className="mt-4 h-1.5 dark:bg-dark-border bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-brand-red rounded-full transition-[width] duration-1000 ease-linear"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        ) : (
          /* ── Formulario normal ── */
          <form onSubmit={handleSubmit as (e: React.FormEvent) => void}>
            <input
              ref={inputRef}
              type="password"
              value={pin}
              onChange={e => setPin(e.target.value)}
              placeholder="PIN"
              maxLength={8}
              disabled={isPending}
              className={`w-full text-center text-[18px] font-bold tracking-[0.4em] px-3 py-2.5 rounded-lg border outline-none mb-3
                dark:bg-dark-surface bg-gray-50 dark:text-dark-text text-light-text transition-colors
                ${error
                  ? "border-brand-red dark:border-brand-red"
                  : "dark:border-dark-border border-light-border focus:border-brand-blue"
                }`}
            />
            {error && (
              <p className="text-[11px] text-brand-red text-center mb-3">PIN incorrecto</p>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={onClose}
                className="flex-1 py-2 rounded-lg text-[12px] font-semibold dark:bg-dark-border bg-gray-100 dark:text-dark-muted text-light-muted cursor-pointer hover:opacity-80 transition-opacity">
                Cancelar
              </button>
              <button type="submit" disabled={isPending}
                className="flex-1 py-2 rounded-lg text-[12px] font-semibold bg-brand-blue text-white cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-60">
                {isPending ? "..." : "Entrar"}
              </button>
            </div>
          </form>
        )}

        {isLocked && (
          <button onClick={onClose}
            className="w-full mt-3 py-2 rounded-lg text-[12px] font-semibold dark:bg-dark-border bg-gray-100 dark:text-dark-muted text-light-muted cursor-pointer hover:opacity-80 transition-opacity">
            Cerrar
          </button>
        )}
      </div>
    </div>
  );
}

export default function Alertas({ printers }: { printers: Printer[] }) {
  const [sendState, setSendState]     = useState<SendState>("idle");
  const [sendMsg,   setSendMsg]       = useState("");
  const [filtroSede, setFiltroSede]   = useState("Todas");
  const [filtroSum,  setFiltroSum]    = useState("Todos");
  const [showPin, setShowPin]         = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  // lockout vive en el padre para que persista aunque el modal se cierre y reabra
  const [lockout, setLockout]   = useState(0);
  const maxLockoutRef           = useRef(0);

  // Countdown corre siempre, incluso con el modal cerrado
  useEffect(() => {
    if (lockout <= 0) return;
    const id = setTimeout(() => setLockout(s => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(id);
  }, [lockout]);

  function handleRateLimited(secs: number) {
    maxLockoutRef.current = secs;
    setLockout(secs);
  }

  // Sesión admin en sessionStorage: persiste durante la sesión del navegador,
  // se pierde al cerrar la pestaña. No reemplaza autenticación real.
  const [isAdmin, setIsAdmin] = useState(() => {
    try { return sessionStorage.getItem("admin_session") === "true"; } catch { return false; }
  });

  const { data: statusData = {}, isLoading: statusLoading } = useAlertasStatus();
  const mutation = useAlertasMutation();

  function alertKey(a: { ip: string; suministro: string }) {
    return `${a.ip}::${a.suministro}`;
  }

  function requireAdmin(action: () => void) {
    if (isAdmin) { action(); return; }
    setPendingAction(() => action);
    setShowPin(true);
  }

  function handlePinSuccess() {
    setIsAdmin(true);
    try { sessionStorage.setItem("admin_session", "true"); } catch {}
    setShowPin(false);
    if (pendingAction) { pendingAction(); setPendingAction(null); }
  }

  function logoutAdmin() {
    setIsAdmin(false);
    try { sessionStorage.removeItem("admin_session"); } catch {}
  }

  function toggleListo(key: string) {
    requireAdmin(() => {
      const current = statusData[key];
      if (current === "listo" || current === "enviado") {
        // desmarcar: elimina el estado
        mutation.mutate({ key, estado: null });
      } else {
        mutation.mutate({ key, estado: "listo" });
      }
    });
  }

  function toggleEnviado(key: string) {
    requireAdmin(() => {
      const current = statusData[key];
      if (current === "enviado") {
        // volver a "listo"
        mutation.mutate({ key, estado: "listo" });
      } else if (current === "listo") {
        mutation.mutate({ key, estado: "enviado" });
      }
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

  const sedes  = useMemo(() => Array.from(new Set(todasAlertas.map(a => a.sede))).sort(), [todasAlertas]);
  const sumins = useMemo(() => Array.from(new Set(todasAlertas.map(a => a.suministro))).sort(), [todasAlertas]);

  const alertas = useMemo(() =>
    todasAlertas.filter(a =>
      (filtroSede === "Todas" || a.sede === filtroSede) &&
      (filtroSum  === "Todos" || a.suministro === filtroSum)
    ), [todasAlertas, filtroSede, filtroSum]);

  const cn = alertas.filter(a => a.nivel === "CRÍTICO").length;
  const bn = alertas.filter(a => a.nivel === "BAJO").length;

  // Conteos globales desde el estado compartido
  const listosCount   = Object.values(statusData).filter(v => v === "listo").length;
  const enviadosCount = Object.values(statusData).filter(v => v === "enviado").length;

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
      {showPin && (
        <PinModal
          lockout={lockout}
          maxLockout={maxLockoutRef.current}
          onRateLimited={handleRateLimited}
          onSuccess={handlePinSuccess}
          onClose={() => { setShowPin(false); setPendingAction(null); }}
        />
      )}

      <div className="flex items-start justify-between gap-4 mb-1 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="page-title text-2xl font-bold dark:text-dark-text text-light-text">Alertas</h1>
          {isAdmin ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-brand-blue/20 text-brand-blue uppercase tracking-wide">Admin</span>
              <button onClick={logoutAdmin}
                className="text-[9px] font-bold px-1.5 py-0.5 rounded-full dark:text-dark-muted text-light-muted cursor-pointer hover:opacity-70 transition-opacity border-none bg-transparent">
                ✕
              </button>
            </div>
          ) : (
            <button onClick={() => setShowPin(true)}
              className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-black/10 dark:bg-white/5 dark:text-dark-muted text-light-muted cursor-pointer hover:opacity-70 transition-opacity border-none">
              🔒 Admin
            </button>
          )}
        </div>
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
          <button onClick={sendAlert} disabled={sendState === "loading"}
            className="page-title flex items-center gap-2 px-4 py-2 rounded-lg text-[12px] font-semibold
              bg-brand-blue text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed
              transition-all cursor-pointer shrink-0"
            style={{ animationDelay: "60ms" }}>
            {sendState === "loading" ? "Enviando..." : "✉ Notificar por correo"}
          </button>
        </div>
      </div>

      <p className="page-title text-[13px] dark:text-dark-muted text-light-muted mb-2" style={{ animationDelay: "60ms" }}>
        {alertas.length} alertas activas
      </p>
      {sendMsg && (
        <p className={`text-[12px] mb-4 px-3 py-2 rounded-lg ${
          sendState === "error" ? "text-brand-red bg-brand-red/10" : "text-brand-green bg-brand-green/10"
        }`}>
          {sendState === "error" ? "✕ " : "✓ "}{sendMsg}
        </p>
      )}

      <div className="flex gap-2.5 mb-5">
        <Card className="flex-1 flex justify-center stat-enter" style={{ animationDelay: "80ms" }}>
          <StatPill value={cn} label="Críticos ≤10%" color="#f04545" />
        </Card>
        <Card className="flex-1 flex justify-center stat-enter" style={{ animationDelay: "120ms" }}>
          <StatPill value={bn} label="Bajos 11-30%" color="#e0b030" />
        </Card>
        <Card className="flex-1 flex justify-center stat-enter" style={{ animationDelay: "160ms" }}>
          <StatPill value={statusLoading ? "—" : listosCount} label="Listos p/ envío" color="#20c97a" />
        </Card>
        <Card className="flex-1 flex justify-center stat-enter" style={{ animationDelay: "200ms" }}>
          <StatPill value={statusLoading ? "—" : enviadosCount} label="Enviados" color="#3d8ef5" />
        </Card>
      </div>

      <Card className="card-enter" style={{ animationDelay: "180ms" }}>
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest">
            Suministros en alerta
          </p>
          <div className="flex items-center gap-4 text-[9px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-wider pr-1">
            <span>P/E</span>
            <span>Enviado</span>
          </div>
        </div>
        <div className="rounded-lg overflow-hidden dark:border-dark-border border border-light-border">
          {alertas.map((a, i) => {
            const key     = alertKey(a);
            const estado  = statusData[key] ?? null;
            const listo   = estado === "listo" || estado === "enviado";
            const enviado = estado === "enviado";
            const rowBg   = enviado ? "#3d8ef508" : listo ? "#20c97a08" : a.color + "08";
            return (
              <div key={i}
                className="row-enter flex items-center justify-between px-4 py-3 dark:border-dark-border border-b border-light-border last:border-0 transition-colors"
                style={{ background: rowBg, animationDelay: `${200 + Math.min(i * 18, 300)}ms` }}>
                <div className="flex items-center gap-3 flex-wrap">
                  {enviado
                    ? <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-brand-blue/20 text-brand-blue">ENVIADO</span>
                    : listo
                      ? <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-brand-green/20 text-brand-green">LISTO</span>
                      : <span className="text-[9px] font-bold px-2 py-0.5 rounded-full" style={{ background: a.color + "22", color: a.color }}>{a.nivel}</span>
                  }
                  <span className={`font-mono text-[12px] font-semibold ${enviado || listo ? "line-through dark:text-dark-muted text-light-muted" : "dark:text-dark-text text-light-text"}`}>
                    {a.ip}
                  </span>
                  <span className="text-[11px] dark:text-dark-muted text-light-muted">{a.sede}</span>
                  {a.modelo && <span className="text-[10px] font-medium dark:text-dark-muted text-light-muted bg-black/10 dark:bg-white/5 px-1.5 py-0.5 rounded">{a.modelo}</span>}
                  {a.area && <span className="text-[11px] dark:text-dark-muted text-light-muted">{a.area.slice(0, 28)}</span>}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[11px] dark:text-dark-muted text-light-muted">{a.suministro}</span>
                  <span className="text-[15px] font-bold" style={{ color: enviado ? "#3d8ef5" : listo ? "#20c97a" : a.color }}>
                    {a.valor.toFixed(0)}%
                  </span>
                  {statusLoading ? (
                    <>
                      <div className="w-6 h-6 rounded-full dark:bg-dark-border bg-gray-200 animate-pulse shrink-0" />
                      <div className="w-6 h-6 rounded-full dark:bg-dark-border bg-gray-200 animate-pulse shrink-0" />
                    </>
                  ) : (
                    <>
                      <CheckBtn
                        active={listo} color="#20c97a"
                        title={listo ? "Desmarcar listo" : "Marcar como listo para envío"}
                        onClick={() => toggleListo(key)}
                        disabled={!isAdmin}
                      />
                      <CheckBtn
                        active={enviado} color="#3d8ef5"
                        title={enviado ? "Desmarcar enviado" : "Marcar como enviado"}
                        onClick={() => toggleEnviado(key)}
                        disabled={!isAdmin || !listo}
                      />
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
