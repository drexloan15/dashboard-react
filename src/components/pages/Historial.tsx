"use client";
import { useState } from "react";
import Card from "@/components/ui/Card";
import type { HistorialRow } from "@/types";

const COLS = ["TIMESTAMP", "FECHA", "IP", "SEDE", "ESTADO", "TONER_NEGRO", "KIT_MANTENIMIENTO", "FOTO_NEGRO", "CONTADOR"];

export default function Historial({ historial }: { historial: HistorialRow[] }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 25;

  if (!historial.length) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6 dark:text-dark-text text-light-text">Historial</h1>
        <p className="dark:text-dark-muted text-light-muted">Sin historial. Esperando datos.</p>
      </div>
    );
  }

  const cols = COLS.filter(c => historial[0] && c in historial[0]);

  const filtered = historial.filter(r =>
    !search || cols.some(c => String(r[c] ?? "").toLowerCase().includes(search.toLowerCase()))
  );

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const rows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const nDias = (() => {
    const ts = historial.map(r => new Date(r._ts || r.TIMESTAMP || r.FECHA || "")).filter(d => !isNaN(d.getTime()));
    if (!ts.length) return 0;
    const min = Math.min(...ts.map(d => d.getTime()));
    const max = Math.max(...ts.map(d => d.getTime()));
    return Math.ceil((max - min) / 86400000) + 1;
  })();

  return (
    <div>
      <h1 className="page-title text-2xl font-bold mb-1 dark:text-dark-text text-light-text">Historial</h1>
      <p className="page-title text-[13px] dark:text-dark-muted text-light-muted mb-6" style={{ animationDelay: "50ms" }}>
        {historial.length} registros · {nDias} días · 1 lectura/día/IP
      </p>

      <Card className="card-enter" style={{ animationDelay: "100ms" }}>
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <p className="text-[10px] font-bold dark:text-dark-muted text-light-muted uppercase tracking-widest">
            Últimas lecturas
          </p>
          <input
            value={search} onChange={e => { setSearch(e.target.value); setPage(0); }}
            placeholder="Buscar IP, sede, estado..."
            className="px-3 py-1.5 rounded-lg text-[12px] dark:bg-dark-surface dark:border-dark-border dark:text-dark-text
              bg-gray-50 border border-light-border text-light-text outline-none w-56"
          />
        </div>

        <div className="overflow-x-auto rounded-lg dark:border-dark-border border border-light-border">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="dark:bg-dark-surface bg-gray-50 dark:border-dark-border border-b border-light-border">
                {cols.map(c => (
                  <th key={c} className="px-3 py-2 text-left font-bold dark:text-dark-muted text-light-muted uppercase tracking-wider whitespace-nowrap">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}
                  className="row-enter dark:border-dark-border border-b border-light-border last:border-0 dark:hover:bg-dark-border/30 hover:bg-gray-50 transition-colors"
                  style={{ animationDelay: `${120 + Math.min(i * 15, 250)}ms` }}>
                  {cols.map(c => {
                    const val = String(r[c] ?? "");
                    const isEstado = c === "ESTADO";
                    const color = isEstado
                      ? val.toLowerCase() === "online" ? "text-brand-green" : "text-brand-red"
                      : "dark:text-dark-text text-light-text";
                    return (
                      <td key={c} className={`px-3 py-2 font-mono whitespace-nowrap ${color} ${isEstado ? "font-bold" : ""}`}>
                        {val || "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between mt-4">
          <span className="text-[11px] dark:text-dark-muted text-light-muted">
            {filtered.length} resultado{filtered.length !== 1 ? "s" : ""}
          </span>
          <div className="flex items-center gap-2">
            <button disabled={page === 0} onClick={() => setPage(p => p - 1)}
              className="px-3 py-1 rounded text-[11px] dark:bg-dark-border bg-gray-100 disabled:opacity-40 cursor-pointer hover:opacity-80">
              ← Prev
            </button>
            <span className="text-[11px] dark:text-dark-muted text-light-muted">
              {page + 1} / {Math.max(totalPages, 1)}
            </span>
            <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}
              className="px-3 py-1 rounded text-[11px] dark:bg-dark-border bg-gray-100 disabled:opacity-40 cursor-pointer hover:opacity-80">
              Sig →
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
