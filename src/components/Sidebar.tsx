"use client";
import { useTheme } from "@/context/ThemeContext";
import type { Page } from "@/types";

const NAV: { id: Page; icon: string; label: string }[] = [
  { id: "overview", icon: "⊡", label: "Panel de Control" },
  { id: "mapa", icon: "⊕", label: "Mapa" },
  { id: "sedes", icon: "⊞", label: "Por Sede" },
  { id: "alertas", icon: "⊗", label: "Alertas" },
  { id: "historial", icon: "☰", label: "Historial" },
  { id: "analiticas", icon: "◈", label: "Analíticas" },
  { id: "usuarios",    icon: "◉", label: "Usuarios" },
  { id: "solicitudes", icon: "◫", label: "Solicitudes" },
  { id: "inventario",  icon: "▤", label: "Inventario" },
];

interface Props {
  open?: boolean;
  onClose?: () => void;
  page: Page;
  setPage: (p: Page) => void;
  zonas: string[];
  setZonas: (z: string[]) => void;
  estados: string[];
  setEstados: (e: string[]) => void;
  ts?: string;
  isCollapsed: boolean;
  setIsCollapsed: (v: boolean) => void;
}

function Toggle({ label, checked, onChange, isCollapsed }: { label: string; checked: boolean; onChange: () => void, isCollapsed: boolean }) {
  if (isCollapsed) return null;
  return (
    <label className="flex items-center gap-2 cursor-pointer mb-1 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="accent-blue-500 w-3 h-3"
      />
      <span className="dark:text-dark-text text-light-text">{label}</span>
    </label>
  );
}

export default function Sidebar({ open = false, page, setPage, zonas, setZonas, estados, setEstados, ts, isCollapsed, setIsCollapsed }: Props) {
  const { toggle } = useTheme();

  function toggleZona(z: string) {
    setZonas(zonas.includes(z) ? zonas.filter(x => x !== z) : [...zonas, z]);
  }
  function toggleEstado(e: string) {
    setEstados(estados.includes(e) ? estados.filter(x => x !== e) : [...estados, e]);
  }

  return (
    <aside className={`fixed top-0 left-0 h-screen z-50 flex flex-col
      dark:bg-dark-surface dark:border-dark-border bg-white border-light-border
      border-r overflow-y-auto transition-all duration-300 ease-in-out
      ${isCollapsed ? "w-[70px]" : "w-[230px]"}
      ${open ? "translate-x-0" : "-translate-x-full"} lg:translate-x-0`}>

      {/* Logo */}
      <div className={`px-4 py-5 mb-2 flex flex-col ${isCollapsed ? "items-center" : ""}`}>
        <img
          src={isCollapsed ? "/short-logo.png" : "/comutel-logo.png"}
          alt="COMUTEL"
          className={`object-contain dark:brightness-0 dark:invert mb-1 transition-all ${isCollapsed ? "h-8 w-auto" : "h-7 w-auto max-w-[150px]"}`}
        />
        {!isCollapsed && <div className="text-[13px] tracking-wide dark:text-dark-muted text-light-muted">MONITOREO</div>}
      </div>

      {/* Toggle tema */}
      <button
        onClick={toggle}
        title={isCollapsed ? "Cambiar tema" : ""}
        className={`mx-3 mb-4 py-2 rounded-lg transition-all hover:opacity-80
          dark:border-dark-border dark:text-dark-text dark:bg-dark-card
          border border-light-border text-light-text bg-white cursor-pointer
          ${isCollapsed ? "px-0 text-[14px]" : "px-3 text-[11px] font-semibold"}`}>
        {isCollapsed ? "◐" : "◐ Cambiar tema"}
      </button>

      {/* Nav */}
      <nav className="px-2 mb-4">
        {NAV.map(({ id, icon, label }) => {
          const active = page === id;
          return (
            <button
              key={id}
              onClick={() => setPage(id)}
              title={isCollapsed ? label : ""}
              className={`w-full flex items-center mb-0.5 rounded-r-lg text-left transition-all cursor-pointer relative
                border-l-[3px]
                ${isCollapsed ? "justify-center px-0 py-3" : "gap-2.5 px-3 py-2.5"}
                ${active
                  ? "dark:border-brand-blue border-brand-blue dark:bg-brand-blue/10 bg-brand-blue/5"
                  : "border-transparent bg-transparent hover:opacity-80"
                }`}>
              <span className={`transition-all dark:text-white ${isCollapsed ? "text-lg" : "text-sm"} ${active ? "opacity-100 text-brand-blue" : "opacity-70"}`}>
                {icon}
              </span>
              {!isCollapsed && (
                <div className="flex items-center justify-between flex-1">
                  <span className={`text-[13px] ${active ? "font-bold dark:text-dark-text text-light-text" : "font-medium dark:text-white/55 text-light-muted"}`}>
                    {label}
                  </span>
                </div>
              )}
            </button>
          );
        })}
      </nav>

      {/* Filtros */}
      {!isCollapsed && (
        <div className="px-4 pt-4 border-t dark:border-dark-border border-light-border">
          <div className="text-[9px] font-bold tracking-widest dark:text-dark-muted text-light-muted mb-3 uppercase">
            Filtros
          </div>
          <div className="text-[11px] dark:text-dark-text text-light-text mb-1.5">Zona</div>
          <Toggle label="Lima" checked={zonas.includes("Lima")} onChange={() => toggleZona("Lima")} isCollapsed={isCollapsed} />
          <Toggle label="Provincia" checked={zonas.includes("Provincia")} onChange={() => toggleZona("Provincia")} isCollapsed={isCollapsed} />

          <div className="text-[11px] dark:text-dark-text text-light-text mt-3 mb-1.5">Estado</div>
          <Toggle label="Online" checked={estados.includes("Online")} onChange={() => toggleEstado("Online")} isCollapsed={isCollapsed} />
          <Toggle label="Offline" checked={estados.includes("Offline")} onChange={() => toggleEstado("Offline")} isCollapsed={isCollapsed} />
        </div>
      )}

      {/* Footer sync */}
      <div className={`mt-auto px-4 mb-4 flex flex-col gap-2 ${isCollapsed ? "items-center" : ""}`}>
        {!isCollapsed && (
          <div className="flex justify-between items-center w-full">
            <span className="text-[9px] dark:text-dark-muted text-light-muted tracking-wide">{ts}</span>
            <span className="live-dot text-[9px] font-bold tracking-widest text-brand-green">● LIVE</span>
          </div>
        )}

        {/* Botón de Contraer/Expandir (Opción A - Abajo) */}
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className={`w-full py-2 rounded-lg border dark:border-dark-border border-light-border
            dark:text-dark-text text-light-text hover:bg-black/5 dark:hover:bg-white/5
            transition-all cursor-pointer flex items-center justify-center
            ${isCollapsed ? "text-lg" : "text-xs gap-2"}`}
        >
          <span>{isCollapsed ? "»" : "«"}</span>
          {!isCollapsed && <span>Contraer menú</span>}
        </button>
      </div>
    </aside>
  );
}
