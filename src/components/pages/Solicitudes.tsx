"use client";
import { useState, useEffect, useMemo, useRef } from "react";
import type { Printer } from "@/types";
import { SUMINISTROS } from "@/types";
import { useEmailConfig, useSolicitudesHistory, useSendSolicitud } from "@/hooks/useData";

function PrinterSearch({
  printers,
  value,
  onChange,
}: {
  printers: Printer[];
  value: string;
  onChange: (ip: string) => void;
}) {
  const [query, setQuery]   = useState("");
  const [open, setOpen]     = useState(false);
  const containerRef        = useRef<HTMLDivElement>(null);
  const inputRef            = useRef<HTMLInputElement>(null);

  const selected = printers.find(p => p.IP === value) ?? null;

  // Cerrar al hacer clic fuera
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return printers;
    return printers.filter(p =>
      p.IP.toLowerCase().includes(q) ||
      (p.SEDE ?? "").toLowerCase().includes(q) ||
      ((p.AREA as string) ?? "").toLowerCase().includes(q)
    );
  }, [printers, query]);

  function select(ip: string) {
    onChange(ip);
    setOpen(false);
    setQuery("");
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setQuery(e.target.value);
    if (!open) setOpen(true);
    if (e.target.value === "") onChange("");
  }

  const displayValue = open ? query : (selected ? `${selected.IP} — ${selected.SEDE ?? "—"}${selected.AREA ? ` (${selected.AREA})` : ""}` : "");

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={displayValue}
          onChange={handleInputChange}
          onFocus={() => { setOpen(true); setQuery(""); }}
          placeholder="Buscar por IP, sede o área…"
          className="w-full px-3 py-2.5 pr-8 rounded-lg text-[13px]
            dark:bg-dark-surface dark:border-dark-border dark:text-dark-text
            bg-gray-50 border border-light-border text-light-text
            focus:outline-none focus:ring-2 focus:ring-brand-blue/40"
        />
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 dark:text-dark-muted text-light-muted text-[10px] pointer-events-none">
          {open ? "▲" : "▼"}
        </span>
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto rounded-lg border dark:border-dark-border border-light-border dark:bg-dark-card bg-white shadow-lg">
          {filtered.length === 0 ? (
            <div className="px-4 py-3 text-[12px] dark:text-dark-muted text-light-muted italic">
              Sin resultados.
            </div>
          ) : (
            filtered.map(p => (
              <button
                key={p.IP}
                type="button"
                onMouseDown={() => select(p.IP)}
                className={`w-full text-left px-4 py-2.5 text-[12px] hover:dark:bg-dark-surface hover:bg-gray-50 transition-colors
                  ${p.IP === value ? "dark:bg-brand-blue/10 bg-brand-blue/5 text-brand-blue font-semibold" : "dark:text-dark-text text-light-text"}`}
              >
                <span className="font-mono">{p.IP}</span>
                <span className="dark:text-dark-muted text-light-muted ml-2">
                  {p.SEDE ?? "—"}{p.AREA ? ` · ${p.AREA}` : ""}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  printers: Printer[];
}

function supplyLevel(printer: Printer | null, key: string): number | null {
  if (!printer) return null;
  const raw = printer[key];
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === "N/A" || s === "nan" || s === "None") return null;
  const n = parseFloat(s.replace("%", ""));
  return isNaN(n) ? null : n;
}

function levelColor(v: number) {
  if (v <= 10) return "bg-red-500";
  if (v <= 25) return "bg-yellow-500";
  return "bg-green-500";
}

function levelTextColor(v: number) {
  if (v <= 10) return "text-red-500";
  if (v <= 25) return "text-yellow-500";
  return "dark:text-dark-muted text-light-muted";
}

export default function Solicitudes({ printers }: Props) {
  const [selIp, setSelIp]       = useState("");
  const [supplies, setSupplies]  = useState<Set<string>>(new Set());
  const [toEmail, setToEmail]    = useState("");
  const [notas, setNotas]        = useState("");
  const [reporter, setReporter]  = useState("");
  const [histPage, setHistPage]  = useState(1);
  const [feedback, setFeedback]  = useState<{ ok: boolean; msg: string } | null>(null);
  const emailSet = useRef(false);

  const { data: emailCfg }                   = useEmailConfig();
  const { data: hist, isLoading: histLoad }  = useSolicitudesHistory(histPage);
  const send = useSendSolicitud();

  useEffect(() => {
    if (emailCfg?.email_to && !emailSet.current) {
      setToEmail(emailCfg.email_to);
      emailSet.current = true;
    }
  }, [emailCfg]);

  const printer = useMemo(
    () => printers.find(p => p.IP === selIp) ?? null,
    [printers, selIp]
  );

  // Auto-marcar suministros críticos al seleccionar impresora
  useEffect(() => {
    if (!printer) { setSupplies(new Set()); return; }
    const auto = new Set<string>();
    for (const [key] of SUMINISTROS) {
      const v = supplyLevel(printer, key);
      if (v !== null && v <= 25) auto.add(key);
    }
    setSupplies(auto);
  }, [printer]);

  function toggleSupply(key: string) {
    setSupplies(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const sortedPrinters = useMemo(
    () => [...printers].sort((a, b) =>
      (a.SEDE ?? "").localeCompare(b.SEDE ?? "") || a.IP.localeCompare(b.IP)
    ),
    [printers]
  );

  const canSubmit =
    !!selIp && supplies.size > 0 && toEmail.trim() && reporter.trim() && !send.isPending;

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    setFeedback(null);
    try {
      const r = await send.mutateAsync({
        printer_ip:    selIp,
        suministros:   [...supplies],
        to_email:      toEmail,
        notas,
        reportado_por: reporter,
      });
      setFeedback({ ok: true, msg: `Solicitud #${r.id} enviada correctamente.` });
      setSelIp(""); setSupplies(new Set()); setNotas(""); setReporter("");
      setHistPage(1);
    } catch (err: unknown) {
      const d = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
      const mensajesValidacion = new Set([
        "Selecciona al menos un suministro.",
        "El correo destinatario es requerido.",
        "El nombre del reportante es requerido.",
      ]);
      const msg = typeof d === "string" && mensajesValidacion.has(d)
        ? d
        : d === "Credenciales de correo no configuradas."
          ? "El servicio de correo no está configurado. Contacta al administrador."
          : "No se pudo enviar la solicitud. Intenta de nuevo o contacta al administrador.";
      setFeedback({ ok: false, msg });
    }
  }

  return (
    <div className="space-y-6">
      {/* Encabezado */}
      <div>
        <h1 className="text-xl font-bold dark:text-dark-text text-light-text">
          Solicitudes de Suministros
        </h1>
        <p className="text-[12px] dark:text-dark-muted text-light-muted mt-0.5">
          Genera y envía solicitudes de reposición de suministros por correo electrónico.
        </p>
      </div>

      {/* Feedback */}
      {feedback && (
        <div role={feedback.ok ? "status" : "alert"} aria-live={feedback.ok ? "polite" : "assertive"} className={`px-4 py-3 rounded-lg text-sm font-medium border ${
          feedback.ok
            ? "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20"
            : "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20"
        }`}>
          {feedback.msg}
        </div>
      )}

      {/* Formulario */}
      <div className="dark:bg-dark-card bg-white rounded-xl border dark:border-dark-border border-light-border p-6">
        <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text mb-6">
          Nueva Solicitud
        </h2>

        <form onSubmit={handleSubmit} className="space-y-7">

          {/* 1. Impresora */}
          <div>
            <label className="block text-[11px] font-semibold dark:text-dark-muted text-light-muted uppercase tracking-wider mb-2">
              1. Impresora
            </label>
            <PrinterSearch
              printers={sortedPrinters}
              value={selIp}
              onChange={ip => { setSelIp(ip); setFeedback(null); }}
            />

            {printer && (
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {([
                  ["Sede",   printer.SEDE   ?? "—"],
                  ["Área",   (printer.AREA  as string) || "—"],
                  ["Modelo", (printer.MODELO_INV as string) || "—"],
                  ["Estado", printer.ESTADO],
                ] as [string, string][]).map(([lbl, val]) => (
                  <div key={lbl} className="dark:bg-dark-surface bg-gray-50 rounded-lg px-3 py-2">
                    <div className="text-[10px] dark:text-dark-muted text-light-muted">{lbl}</div>
                    <div className={`text-[12px] font-semibold mt-0.5 truncate ${
                      val === "Online"  ? "text-green-500" :
                      val === "Offline" ? "text-red-500" :
                      "dark:text-dark-text text-light-text"
                    }`}>{val}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 2. Suministros */}
          <div>
            <label className="block text-[11px] font-semibold dark:text-dark-muted text-light-muted uppercase tracking-wider mb-2">
              2. Suministros requeridos
              {supplies.size > 0 && (
                <span className="ml-2 normal-case font-normal text-brand-blue">
                  ({supplies.size} seleccionado{supplies.size !== 1 ? "s" : ""})
                </span>
              )}
            </label>

            {!selIp ? (
              <p className="text-[12px] dark:text-dark-muted text-light-muted italic">
                Selecciona una impresora para ver sus suministros.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {SUMINISTROS.map(([key, label]) => {
                  const v       = supplyLevel(printer, key);
                  const checked = supplies.has(key);
                  return (
                    <label
                      key={key}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer border transition-colors
                        ${checked
                          ? "dark:border-brand-blue border-brand-blue dark:bg-brand-blue/10 bg-brand-blue/5"
                          : "dark:border-dark-border border-light-border dark:bg-dark-surface bg-gray-50 hover:opacity-80"
                        }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSupply(key)}
                        className="accent-blue-500 w-3.5 h-3.5 flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] dark:text-dark-text text-light-text font-medium">
                          {label}
                        </div>
                        {v !== null && (
                          <div className="mt-1 flex items-center gap-2">
                            <div className="flex-1 h-1.5 dark:bg-dark-border bg-gray-200 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${levelColor(v)}`}
                                style={{ width: `${Math.min(100, Math.max(0, v))}%` }}
                              />
                            </div>
                            <span className={`text-[10px] font-mono font-semibold ${levelTextColor(v)}`}>
                              {v.toFixed(0)}%
                            </span>
                          </div>
                        )}
                      </div>
                      {v !== null && v <= 10 && (
                        <span className="text-[10px] font-bold text-red-500 bg-red-500/10 px-1.5 py-0.5 rounded flex-shrink-0">
                          CRÍTICO
                        </span>
                      )}
                      {v !== null && v > 10 && v <= 25 && (
                        <span className="text-[10px] font-bold text-yellow-600 dark:text-yellow-400 bg-yellow-500/10 px-1.5 py-0.5 rounded flex-shrink-0">
                          BAJO
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* 3. Enviar a */}
          <div>
            <label className="block text-[11px] font-semibold dark:text-dark-muted text-light-muted uppercase tracking-wider mb-2">
              3. Enviar a
            </label>
            <input
              type="text"
              value={toEmail}
              onChange={e => setToEmail(e.target.value)}
              placeholder="correo@ejemplo.com, otro@ejemplo.com"
              className="w-full px-3 py-2.5 rounded-lg text-[13px]
                dark:bg-dark-surface dark:border-dark-border dark:text-dark-text
                bg-gray-50 border border-light-border text-light-text
                focus:outline-none focus:ring-2 focus:ring-brand-blue/40"
            />
            <p className="text-[10px] dark:text-dark-muted text-light-muted mt-1">
              Separa múltiples correos con comas.
            </p>
          </div>

          {/* 4. Anotaciones */}
          <div>
            <label className="block text-[11px] font-semibold dark:text-dark-muted text-light-muted uppercase tracking-wider mb-2">
              4. Anotaciones{" "}
              <span className="normal-case font-normal">(opcional)</span>
            </label>
            <textarea
              value={notas}
              onChange={e => setNotas(e.target.value)}
              rows={3}
              placeholder="Urgencia, contexto adicional, observaciones..."
              className="w-full px-3 py-2.5 rounded-lg text-[13px] resize-none
                dark:bg-dark-surface dark:border-dark-border dark:text-dark-text
                bg-gray-50 border border-light-border text-light-text
                focus:outline-none focus:ring-2 focus:ring-brand-blue/40"
            />
          </div>

          {/* 5. Reportado por */}
          <div>
            <label className="block text-[11px] font-semibold dark:text-dark-muted text-light-muted uppercase tracking-wider mb-2">
              5. Reportado por
            </label>
            <input
              type="text"
              value={reporter}
              onChange={e => setReporter(e.target.value)}
              placeholder="Nombre completo"
              className="w-full px-3 py-2.5 rounded-lg text-[13px]
                dark:bg-dark-surface dark:border-dark-border dark:text-dark-text
                bg-gray-50 border border-light-border text-light-text
                focus:outline-none focus:ring-2 focus:ring-brand-blue/40"
            />
          </div>

          {/* Enviar */}
          <div className="flex items-center justify-between pt-2 border-t dark:border-dark-border border-light-border">
            <p className="text-[11px] dark:text-dark-muted text-light-muted">
              Se enviará un correo con los detalles al destinatario indicado.
            </p>
            <button
              type="submit"
              disabled={!canSubmit}
              aria-live="polite"
              className={`px-5 py-2.5 rounded-lg text-[13px] font-semibold transition-all
                ${canSubmit
                  ? "bg-brand-blue text-white hover:opacity-90 cursor-pointer"
                  : "dark:bg-dark-surface bg-gray-100 dark:text-dark-muted text-light-muted opacity-50 cursor-not-allowed"
                }`}
            >
              {send.isPending ? "Enviando…" : "Enviar Solicitud"}
            </button>
          </div>
        </form>
      </div>

      {/* Historial */}
      <div className="dark:bg-dark-card bg-white rounded-xl border dark:border-dark-border border-light-border overflow-hidden">
        <div className="px-6 py-4 border-b dark:border-dark-border border-light-border">
          <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text">
            Historial de Solicitudes
          </h2>
        </div>

        {histLoad ? (
          <div role="status" aria-label="Cargando historial de solicitudes" className="p-6 space-y-2 animate-pulse">
            <span className="sr-only">Cargando historial de solicitudes…</span>
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-10 dark:bg-dark-surface bg-gray-100 rounded" />
            ))}
          </div>
        ) : !hist?.items?.length ? (
          <div className="p-8 text-center dark:text-dark-muted text-light-muted text-[13px]">
            No hay solicitudes enviadas aún.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="dark:bg-dark-surface bg-gray-50 border-b dark:border-dark-border border-light-border">
                    {["Fecha", "IP", "Sede", "Área", "Suministros solicitados", "Reportado por", "Enviado a", "Notas"].map(h => (
                      <th key={h} className="px-4 py-3 text-left font-semibold dark:text-dark-muted text-light-muted whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {hist.items.map(s => (
                    <tr
                      key={s.id}
                      className="border-b dark:border-dark-border border-light-border hover:dark:bg-dark-surface hover:bg-gray-50 transition-colors"
                    >
                      <td className="px-4 py-3 dark:text-dark-muted text-light-muted whitespace-nowrap">
                        {new Date(s.created_at).toLocaleString("es-PE", {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}
                      </td>
                      <td className="px-4 py-3 font-mono dark:text-dark-text text-light-text whitespace-nowrap">
                        {s.printer_ip}
                      </td>
                      <td className="px-4 py-3 dark:text-dark-text text-light-text whitespace-nowrap">
                        {s.sede ?? "—"}
                      </td>
                      <td className="px-4 py-3 dark:text-dark-muted text-light-muted whitespace-nowrap">
                        {s.area || "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {s.suministros.map(k => {
                            const lbl = SUMINISTROS.find(([sk]) => sk === k)?.[1] ?? k;
                            return (
                              <span
                                key={k}
                                className="px-1.5 py-0.5 rounded text-[10px] bg-brand-blue/10 text-brand-blue font-medium whitespace-nowrap"
                              >
                                {lbl}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-4 py-3 dark:text-dark-text text-light-text font-medium whitespace-nowrap">
                        {s.reportado_por}
                      </td>
                      <td className="px-4 py-3 dark:text-dark-muted text-light-muted text-[11px] max-w-[160px] truncate">
                        {s.to_email}
                      </td>
                      <td className="px-4 py-3 dark:text-dark-muted text-light-muted max-w-[180px] truncate">
                        {s.notas || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {(hist.total_pages ?? 1) > 1 && (
              <div className="px-6 py-3 border-t dark:border-dark-border border-light-border flex items-center justify-between">
                <span className="text-[11px] dark:text-dark-muted text-light-muted">
                  {hist.total} solicitudes · Página {hist.page} de {hist.total_pages}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setHistPage(p => Math.max(1, p - 1))}
                    disabled={histPage <= 1}
                    className="px-3 py-1 rounded text-[11px] dark:bg-dark-surface bg-gray-100 dark:text-dark-text text-light-text disabled:opacity-40 cursor-pointer hover:opacity-80 disabled:cursor-not-allowed"
                  >
                    ← Anterior
                  </button>
                  <button
                    onClick={() => setHistPage(p => Math.min(hist.total_pages, p + 1))}
                    disabled={histPage >= hist.total_pages}
                    className="px-3 py-1 rounded text-[11px] dark:bg-dark-surface bg-gray-100 dark:text-dark-text text-light-text disabled:opacity-40 cursor-pointer hover:opacity-80 disabled:cursor-not-allowed"
                  >
                    Siguiente →
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
