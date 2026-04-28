"use client";
import { useState } from "react";
import Sidebar from "@/components/Sidebar";
import Overview from "@/components/pages/Overview";
import Mapa from "@/components/pages/Mapa";
import Sedes from "@/components/pages/Sedes";
import Alertas from "@/components/pages/Alertas";
import Historial from "@/components/pages/Historial";
import { useData } from "@/hooks/useData";
import type { Page } from "@/types";

export default function DashboardClient() {
  const [page, setPage]         = useState<Page>("overview");
  const [zonas, setZonas]       = useState(["Lima", "Provincia"]);
  const [estados, setEstados]   = useState(["Online", "Offline"]);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const { data, isLoading, isError } = useData();

  const printers = (data?.estado ?? []).filter(p => {
    const zonaOk   = !zonas.length || !p.ZONA || zonas.includes(p.ZONA);
    const estadoOk = !estados.length || estados.includes(p.ESTADO);
    return zonaOk && estadoOk;
  });
  const historial = data?.historial ?? [];
  const ts = data?.ts ?? "";

  function handleSetPage(p: Page) {
    setPage(p);
    setSidebarOpen(false);
  }

  return (
    <div className="min-h-screen dark:bg-dark-bg bg-light-bg">

      {/* Overlay oscuro en móvil cuando el sidebar está abierto */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        page={page} setPage={handleSetPage}
        zonas={zonas} setZonas={setZonas}
        estados={estados} setEstados={setEstados}
        ts={ts}
      />

      <main className="lg:ml-[230px] min-h-screen px-4 sm:px-6 lg:px-9 py-5 lg:py-8">

        {/* Header móvil con botón hamburguesa */}
        <div className="flex items-center gap-3 mb-5 lg:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-lg dark:bg-dark-card bg-white dark:border-dark-border border border-light-border
              dark:text-dark-text text-light-text cursor-pointer"
            aria-label="Abrir menú"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
              <rect y="2"  width="18" height="2" rx="1"/>
              <rect y="8"  width="18" height="2" rx="1"/>
              <rect y="14" width="18" height="2" rx="1"/>
            </svg>
          </button>
          <div className="flex items-center">
            <img src="/comutel-logo.png" alt="COMUTEL"
              className="h-6 w-auto dark:brightness-0 dark:invert" />
          </div>
        </div>

        {isLoading && (
          <div className="flex flex-col items-center justify-center h-80 gap-4">
            <div className="w-10 h-10 rounded-full border-4 border-brand-blue border-t-transparent animate-spin" />
            <p className="dark:text-dark-muted text-light-muted text-[13px]">Conectando con Google Sheets…</p>
          </div>
        )}
        {isError && !isLoading && (
          <div className="text-center mt-20">
            <p className="text-brand-red font-bold text-lg mb-2">Error de conexión</p>
            <p className="dark:text-dark-muted text-light-muted text-[13px]">
              Servidor Offline... Comuniquese con el administrador.
            </p>
          </div>
        )}
        {!isLoading && !isError && (
          <>
            {page === "overview"  && <Overview  printers={printers} historial={historial} />}
            {page === "mapa"      && <Mapa      printers={printers} />}
            {page === "sedes"     && <Sedes     printers={printers} />}
            {page === "alertas"   && <Alertas   printers={printers} />}
            {page === "historial" && <Historial historial={historial} />}
          </>
        )}
      </main>
    </div>
  );
}