"use client";
import { useTheme } from "@/context/ThemeContext";
import type { Page } from "@/types";

const NAV: { id: Page; icon: string; label: string }[] = [
  { id: "overview",  icon: "⊡", label: "Panel de Control" },
  { id: "mapa",      icon: "⊕", label: "Mapa" },
  { id: "sedes",     icon: "⊞", label: "Por Sede" },
  { id: "alertas",   icon: "⊗", label: "Alertas" },
  { id: "historial", icon: "☰", label: "Historial" },
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
  ts: string;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
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

export default function Sidebar({ open = false, page, setPage, zonas, setZonas, estados, setEstados, ts }: Props) {
  const { toggle } = useTheme();

  function toggleZona(z: string) {
    setZonas(zonas.includes(z) ? zonas.filter(x => x !== z) : [...zonas, z]);
  }
  function toggleEstado(e: string) {
    setEstados(estados.includes(e) ? estados.filter(x => x !== e) : [...estados, e]);
  }

  return (
    <aside className={`fixed top-0 left-0 w-[230px] h-screen z-50 flex flex-col
      dark:bg-dark-surface dark:border-dark-border bg-white border-light-border
      border-r overflow-y-auto transition-transform duration-300 ease-in-out
      ${open ? "translate-x-0" : "-translate-x-full"} lg:translate-x-0`}>

      {/* Logo */}
      <div className="px-4 py-5 mb-2">
        <img src="/comutel-logo.png" alt="COMUTEL"
          className="h-7 w-auto dark:brightness-0 dark:invert mb-1" />
        <div className="text-[10px] tracking-wide dark:text-dark-muted text-light-muted">MONITOREO</div>
      </div>

      {/* Toggle tema */}
      <button
        onClick={toggle}
        className="mx-3 mb-4 py-2 px-3 rounded-lg text-[11px] font-semibold
          dark:border-dark-border dark:text-dark-text dark:bg-dark-card
          border border-light-border text-light-text bg-white
          cursor-pointer transition-colors hover:opacity-80">
        ◐ Cambiar tema
      </button>

      {/* Nav */}
      <nav className="px-2 mb-4">
        {NAV.map(({ id, icon, label }) => {
          const active = page === id;
          return (
            <button
              key={id}
              onClick={() => setPage(id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 mb-0.5
                rounded-r-lg text-left transition-all cursor-pointer
                border-l-[3px]
                ${active
                  ? "dark:border-brand-blue border-brand-blue dark:bg-dark-border/40 bg-blue-50"
                  : "border-transparent bg-transparent hover:bg-black/5 dark:hover:bg-white/5"
                }`}>
              <span className="text-sm opacity-70">{icon}</span>
              <span className={`text-[13px] ${active ? "font-bold dark:text-dark-text text-light-text" : "font-medium dark:text-white/55 text-light-muted"}`}>
                {label}
              </span>
            </button>
          );
        })}
      </nav>

      {/* Filtros */}
      <div className="px-4 pt-4 border-t dark:border-dark-border border-light-border">
        <div className="text-[9px] font-bold tracking-widest dark:text-dark-muted text-light-muted mb-3 uppercase">
          Filtros
        </div>
        <div className="text-[11px] dark:text-dark-text text-light-text mb-1.5">Zona</div>
        <Toggle label="Lima"      checked={zonas.includes("Lima")}      onChange={() => toggleZona("Lima")} />
        <Toggle label="Provincia" checked={zonas.includes("Provincia")} onChange={() => toggleZona("Provincia")} />

        <div className="text-[11px] dark:text-dark-text text-light-text mt-3 mb-1.5">Estado</div>
        <Toggle label="Online"  checked={estados.includes("Online")}  onChange={() => toggleEstado("Online")} />
        <Toggle label="Offline" checked={estados.includes("Offline")} onChange={() => toggleEstado("Offline")} />
      </div>

      {/* Footer sync */}
      <div className="mt-auto mx-4 mb-4 flex justify-between items-center">
        <span className="text-[9px] dark:text-dark-muted text-light-muted tracking-wide">{ts}</span>
        <span className="live-dot text-[9px] font-bold tracking-widest text-brand-green">● LIVE</span>
      </div>
    </aside>
  );
}
