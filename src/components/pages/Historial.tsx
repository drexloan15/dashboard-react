"use client";
import { useState, useMemo } from "react";
import Card from "@/components/ui/Card";
import type { HistorialRow } from "@/types";

const ALL_COLS = [
  "TIMESTAMP", "FECHA", "IP", "SEDE", "ESTADO", "CONTADOR",
  "TONER_NEGRO", "TONER_CIAN", "TONER_MAGENTA", "TONER_AMARILLO",
  "FOTO_NEGRO", "FOTO_CIAN", "FOTO_MAGENTA", "FOTO_AMARILLO",
  "REVELADOR_NEGRO", "KIT_MANTENIMIENTO", "KIT_FUSOR", "CONTENEDOR_DESECHO",
];

const LABEL: Record<string, string> = {
  TIMESTAMP: "Timestamp", FECHA: "Fecha", IP: "IP", SEDE: "Sede",
  ESTADO: "Estado", CONTADOR: "Contador",
  TONER_NEGRO: "T.Negro", TONER_CIAN: "T.Cián", TONER_MAGENTA: "T.Magenta", TONER_AMARILLO: "T.Amarillo",
  FOTO_NEGRO: "F.Negro", FOTO_CIAN: "F.Cián", FOTO_MAGENTA: "F.Magenta", FOTO_AMARILLO: "F.Amarillo",
  REVELADOR_NEGRO: "Revelador", KIT_MANTENIMIENTO: "Kit Mant.", KIT_FUSOR: "Kit Fusor",
  CONTENEDOR_DESECHO: "Contenedor",
};

const PAGE_SIZE = 30;

function uniq(arr: string[]) {
  return Array.from(new Set(arr.filter(Boolean))).sort();
}

export default function Historial({ historial }: { historial: HistorialRow[] }) {
  const [search, setSearch]       = useState("");
  const [filterSede, setSede]     = useState("");
  const [filterEstado, setEstado] = useState("");
  const [filterIP, setIP]         = useState("");
  const [filterFecha, setFecha]   = useState("");
  const [page, setPage]           = useState(0);

  const sedes  = useMemo(() => uniq(historial.map(r => String(r.SEDE ?? ""))), [historial]);
  const ips    = useMemo(() => {
    const list = filterSede ? historial.filter(r => String(r.SEDE ?? "") === filterSede) : historial;
    return uniq(list.map(r => String(r.IP ?? "")));
  }, [historial, filterSede]);
  const fechas = useMemo(() => uniq(historial.map(r => String(r.FECHA ?? (r._fecha ?? "")))), [historial]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return historial.filter(r => {
      if (filterSede   && String(r.SEDE  ?? "") !== filterSede)                    return false;
      if (filterEstado && String(r.ESTADO ?? "").toLowerCase() !== filterEstado)   return false;
      if (filterIP     && String(r.IP    ?? "") !== filterIP)                       return false;
      if (filterFecha  && String(r.FECHA ?? (r._fecha ?? "")) !== filterFecha)     return false;
      if (q && !ALL_COLS.some(c => String(r[c] ?? "").toLowerCase().includes(q))) return false;
      return true;
    });
  }, [historial, search, filterSede, filterEstado, filterIP, filterFecha]);

  const nDias = useMemo(() => {
    const ts = historial.map(r => new Date(r._ts || r.TIMESTAMP || r.FECHA || "")).filter(d => !isNaN(d.getTime()));
    if (!ts.length) return 0;
    const min = Math.min(...ts.map(d => d.getTime()));
    const max = Math.max(...ts.map(d => d.getTime()));
    return Math.ceil((max - min) / 86400000) + 1;
  }, [historial]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const rows       = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function resetPage() { setPage(0); }

  if (!historial.length) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6 dark:text-dark-text text-light-text">Historial</h1>
        <p className="dark:text-dark-muted text-light-muted">Sin historial. Esperando datos.</p>
      </div>
    );
  }

  const selectCls = `px-2 py-1.5 rounded-lg text-[12px] dark:bg-dark-surface dark:border-dark-border
    dark:text-dark-text bg-gray-50 border border-light-border text-light-text outline-none`;

  return (
    <div>
      <h1 className="page-title text-2xl font-bold mb-1 dark:text-dark-text text-light-text">Historial</h1>
      <p className="page-title text-[13px] dark:text-dark-muted text-light-muted mb-6" style={{ animationDelay: "50ms" }}>
        {historial.length} registros · {nDias} días · ~24 lecturas/día/IP
      </p>

      <Card className="card-enter" style={{ animationDelay: "100ms" }}>
        {/* Filtros */}
        <div className="flex flex-wrap gap-2 mb-4">
          <input
            value={search} onChange={e => { setSearch(e.target.value); resetPage(); }}
            placeholder="Buscar texto..."
            className={`${selectCls} w-44`}
          />
          <select value={filterSede} onChange={e => { setSede(e.target.value); setIP(""); resetPage(); }} className={selectCls}>
            <option value="">Todas las sedes</option>
            {sedes.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filterIP} onChange={e => { setIP(e.target.value); resetPage(); }} className={selectCls}>
            <option value="">Todas las IPs</option>
            {ips.map(ip => <option key={ip} value={ip}>{ip}</option>)}
          </select>
          <select value={filterEstado} onChange={e => { setEstado(e.target.value); resetPage(); }} className={selectCls}>
            <option value="">Todos los estados</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
          </select>
          <select value={filterFecha} onChange={e => { setFecha(e.target.value); resetPage(); }} className={selectCls}>
            <option value="">Todas las fechas</option>
            {fechas.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
          {(search || filterSede || filterIP || filterEstado || filterFecha) && (
            <button
              onClick={() => { setSearch(""); setSede(""); setIP(""); setEstado(""); setFecha(""); resetPage(); }}
              className="px-3 py-1.5 rounded-lg text-[12px] text-brand-red border border-brand-red/30 hover:bg-brand-red/10 transition-colors cursor-pointer">
              Limpiar filtros
            </button>
          )}
        </div>

        {/* Tabla */}
        <div className="overflow-x-auto rounded-lg dark:border-dark-border border border-light-border">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="dark:bg-dark-surface bg-gray-50 dark:border-dark-border border-b border-light-border">
                {cols.map(c => (
                  <th key={c} className="px-3 py-2 text-left font-bold dark:text-dark-muted text-light-muted uppercase tracking-wider whitespace-nowrap">
                    {LABEL[c] ?? c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}
                  className="row-enter dark:border-dark-border border-b border-light-border last:border-0 dark:hover:bg-dark-border/30 hover:bg-gray-50 transition-colors"
                  style={{ animationDelay: `${120 + Math.min(i * 10, 200)}ms` }}>
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

        {/* Paginación */}
        <div className="flex items-center justify-between mt-4">
          <span className="text-[11px] dark:text-dark-muted text-light-muted">
            {filtered.length} resultado{filtered.length !== 1 ? "s" : ""}
            {filtered.length !== historial.length && ` (de ${historial.length})`}
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
