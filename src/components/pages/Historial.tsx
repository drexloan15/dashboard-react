"use client";
import { useState, useMemo, useDeferredValue } from "react";
import Card from "@/components/ui/Card";
import { useHistorialPage } from "@/hooks/useData";
import type { Printer } from "@/types";

const ALL_COLS = [
  "TIMESTAMP", "FECHA", "IP", "SEDE", "AREA", "ESTADO", "CONTADOR",
  "TONER_NEGRO", "TONER_CIAN", "TONER_MAGENTA", "TONER_AMARILLO",
  "FOTO_NEGRO", "FOTO_CIAN", "FOTO_MAGENTA", "FOTO_AMARILLO",
  "REVELADOR_NEGRO", "KIT_MANTENIMIENTO", "KIT_FUSOR", "CONTENEDOR_DESECHO",
];

const LABEL: Record<string, string> = {
  TIMESTAMP: "Timestamp", FECHA: "Fecha", IP: "IP", SEDE: "Sede", AREA: "Área",
  ESTADO: "Estado", CONTADOR: "Contador",
  TONER_NEGRO: "T.Negro", TONER_CIAN: "T.Cián", TONER_MAGENTA: "T.Magenta", TONER_AMARILLO: "T.Amarillo",
  FOTO_NEGRO: "F.Negro", FOTO_CIAN: "F.Cián", FOTO_MAGENTA: "F.Magenta", FOTO_AMARILLO: "F.Amarillo",
  REVELADOR_NEGRO: "Revelador", KIT_MANTENIMIENTO: "Kit Mant.", KIT_FUSOR: "Kit Fusor",
  CONTENEDOR_DESECHO: "Contenedor",
};

export default function Historial({ printers }: { printers: Printer[] }) {
  const [search, setSearch]       = useState("");
  const [filterSede, setSede]     = useState("");
  const [filterArea, setArea]     = useState("");
  const [filterEstado, setEstado] = useState("");
  const [filterIP, setIP]         = useState("");
  const [filterFecha, setFecha]   = useState("");
  const [page, setPage]           = useState(0);

  const deferredSearch = useDeferredValue(search);

  const sedes = useMemo(
    () => Array.from(new Set(printers.map(p => p.SEDE).filter(Boolean))).sort(),
    [printers]
  );
  // Áreas e IPs se acotan a la sede elegida: un área de otra sede no daría
  // resultados y solo ensucia el desplegable.
  const areas = useMemo(() => {
    const list = filterSede ? printers.filter(p => p.SEDE === filterSede) : printers;
    return Array.from(new Set(list.map(p => p.AREA).filter(Boolean))).sort();
  }, [printers, filterSede]);

  const ips = useMemo(() => {
    const list = printers.filter(p =>
      (!filterSede || p.SEDE === filterSede) && (!filterArea || p.AREA === filterArea));
    return Array.from(new Set(list.map(p => p.IP))).sort();
  }, [printers, filterSede, filterArea]);

  const params = useMemo(() => {
    const p = new URLSearchParams({ page: String(page + 1), page_size: "50" });
    if (deferredSearch) p.set("search", deferredSearch);
    if (filterSede)     p.set("sede",   filterSede);
    if (filterArea)     p.set("area",   filterArea);
    if (filterEstado)   p.set("estado", filterEstado);
    if (filterIP)       p.set("ip",     filterIP);
    if (filterFecha)    p.set("fecha",  filterFecha);
    return p;
  }, [page, deferredSearch, filterSede, filterArea, filterEstado, filterIP, filterFecha]);

  const { data, isLoading } = useHistorialPage(params);

  const rows       = data?.items       ?? [];
  const total      = data?.total       ?? 0;
  const totalPages = data?.total_pages ?? 1;

  function resetPage() { setPage(0); }

  const selectCls = `px-2 py-1.5 rounded-lg text-[12px] dark:bg-dark-surface dark:border-dark-border
    dark:text-dark-text bg-gray-50 border border-light-border text-light-text outline-none`;

  return (
    <div>
      <h1 className="page-title text-2xl font-bold mb-1 dark:text-dark-text text-light-text">Historial</h1>
      <p className="page-title text-[13px] dark:text-dark-muted text-light-muted mb-6" style={{ animationDelay: "50ms" }}>
        {total > 0 ? `${total.toLocaleString()} registros en base de datos` : "Cargando…"}
      </p>

      <Card className="card-enter" style={{ animationDelay: "100ms" }}>
        {/* Filtros */}
        <div className="flex flex-wrap gap-2 mb-4">
          <input
            value={search} onChange={e => { setSearch(e.target.value); resetPage(); }}
            placeholder="Buscar texto..."
            className={`${selectCls} w-44`}
          />
          <select value={filterSede} onChange={e => { setSede(e.target.value); setArea(""); setIP(""); resetPage(); }} className={selectCls}>
            <option value="">Todas las sedes</option>
            {sedes.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filterArea} onChange={e => { setArea(e.target.value); setIP(""); resetPage(); }} className={selectCls}>
            <option value="">Todas las áreas</option>
            {areas.map(a => <option key={a} value={a}>{a}</option>)}
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
          <input
            type="date" value={filterFecha}
            onChange={e => { setFecha(e.target.value); resetPage(); }}
            className={selectCls}
          />
          {(search || filterSede || filterArea || filterIP || filterEstado || filterFecha) && (
            <button
              onClick={() => { setSearch(""); setSede(""); setArea(""); setIP(""); setEstado(""); setFecha(""); resetPage(); }}
              className="px-3 py-1.5 rounded-lg text-[12px] text-brand-red border border-brand-red/30 hover:bg-brand-red/10 transition-colors cursor-pointer">
              Limpiar filtros
            </button>
          )}
        </div>

        {/* Tabla */}
        <div className={`overflow-x-auto rounded-lg dark:border-dark-border border border-light-border transition-opacity ${isLoading ? "opacity-50" : ""}`}>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="dark:bg-dark-surface bg-gray-50 dark:border-dark-border border-b border-light-border">
                {ALL_COLS.map(c => (
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
                  {ALL_COLS.map(c => {
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
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={ALL_COLS.length} className="px-3 py-8 text-center dark:text-dark-muted text-light-muted text-[12px]">
                    Sin registros para los filtros actuales.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Paginación */}
        <div className="flex items-center justify-between mt-4">
          <span className="text-[11px] dark:text-dark-muted text-light-muted">
            {total.toLocaleString()} resultado{total !== 1 ? "s" : ""}
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
