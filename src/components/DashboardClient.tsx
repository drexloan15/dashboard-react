"use client";
import { useState, useMemo, useCallback, useRef } from "react";
import Sidebar from "@/components/Sidebar";
import Overview from "@/components/pages/Overview";
import Mapa from "@/components/pages/Mapa";
import Sedes from "@/components/pages/Sedes";
import Alertas from "@/components/pages/Alertas";
import Historial from "@/components/pages/Historial";
import Analiticas from "@/components/pages/Analiticas";
import Usuarios from "@/components/pages/Usuarios";
import Solicitudes from "@/components/pages/Solicitudes";
import Inventario from "@/components/pages/Inventario";
import { useEstadoData, useRecentHistorial, usePrStats } from "@/hooks/useData";
import type { Page } from "@/types";

export default function DashboardClient() {
  const [page, setPage] = useState<Page>("overview");
  const [zonas, setZonas] = useState(["Lima", "Provincia"]);
  const [estados, setEstados] = useState(["Online", "Offline"]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const { data: estadoData, isLoading, isError, refetch } = useEstadoData();

  // Historial reciente: 30 días para overview/sedes, 365 para analíticas
  const needsHistorial = page === "overview" || page === "sedes" || page === "analiticas";
  const historialDays  = page === "analiticas" ? 365 : 30;
  const { data: recentHistorialData } = useRecentHistorial(needsHistorial, historialDays);

  const { data: prStats } = usePrStats(page === "usuarios");

  // Todos los equipos, SIN el filtro de Zona/Estado del Sidebar. Ese filtro
  // representa "quiero ver esto ahora mismo" y tiene sentido para Overview,
  // Mapa y Alertas -- pero Historial, Sedes y Analiticas muestran datos
  // HISTORICOS, donde un equipo offline hoy puede ser justo el que se quiere
  // auditar, y una sede entera desaparecia de esas paginas sin ningun aviso
  // con solo destildar un checkbox en una pagina distinta. Ver
  // correcciones/funcional.md, hallazgo #1.
  const allPrinters = estadoData?.estado ?? [];

  const printers = useMemo(
    () =>
      allPrinters.filter(p => {
        const zonaOk   = !zonas.length  || !p.ZONA  || zonas.includes(p.ZONA);
        const estadoOk = !estados.length || estados.includes(p.ESTADO);
        return zonaOk && estadoOk;
      }),
    [allPrinters, zonas, estados]
  );

  const historial = recentHistorialData?.historial ?? [];
  const ts = estadoData?.ts ?? "";

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    window.requestAnimationFrame(() => menuButtonRef.current?.focus());
  }, []);

  function handleSetPage(p: Page) {
    setPage(p);
    if (sidebarOpen) closeSidebar();
  }

  return (
    <div className="min-h-screen dark:bg-dark-bg bg-light-bg">

      {sidebarOpen && (
        <div
          aria-hidden="true"
          className="fixed inset-0 bg-black/60 z-40 lg:hidden"
          onClick={closeSidebar}
        />
      )}

      <Sidebar
        open={sidebarOpen}
        onClose={closeSidebar}
        page={page} setPage={handleSetPage}
        zonas={zonas} setZonas={setZonas}
        estados={estados} setEstados={setEstados}
        ts={ts}
        isCollapsed={isCollapsed}
        setIsCollapsed={setIsCollapsed}
      />

      <main className={`${isCollapsed ? "lg:ml-[70px]" : "lg:ml-[230px]"} min-h-screen px-4 sm:px-6 lg:px-9 py-5 lg:py-8 transition-all duration-300`}>

        <div className="flex items-center gap-3 mb-5 lg:hidden">
          <button
            ref={menuButtonRef}
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-lg dark:bg-dark-card bg-white dark:border-dark-border border border-light-border
              dark:text-dark-text text-light-text cursor-pointer"
            aria-label="Abrir menú"
            aria-controls="main-sidebar"
            aria-expanded={sidebarOpen}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
              <rect y="2" width="18" height="2" rx="1" />
              <rect y="8" width="18" height="2" rx="1" />
              <rect y="14" width="18" height="2" rx="1" />
            </svg>
          </button>
          <div className="flex items-center">
            <img src="/comutel-logo.png" alt="COMUTEL"
              className="h-6 w-auto dark:brightness-0 dark:invert" />
          </div>
        </div>

        {isLoading && (
          <div role="status" aria-live="polite" className="flex flex-col items-center justify-center h-80 gap-4">
            <div aria-hidden="true" className="w-10 h-10 rounded-full border-4 border-brand-blue border-t-transparent animate-spin" />
            <p className="dark:text-dark-muted text-light-muted text-[13px]">Conectando con la base de datos…</p>
          </div>
        )}
        {isError && !isLoading && (
          <div role="alert" aria-live="assertive" className="text-center mt-20">
            <p className="text-brand-red font-bold text-lg mb-2">Error de conexión</p>
            <p className="dark:text-dark-muted text-light-muted text-[13px] mb-4">
              No se pudo conectar con el servidor. Intenta nuevamente; si el problema continúa, comunícate con el administrador.
            </p>
            <button type="button" onClick={() => void refetch()}
              className="rounded-lg bg-brand-blue px-4 py-2 text-sm font-semibold text-white hover:opacity-90
                focus:outline-none focus:ring-2 focus:ring-brand-blue/50 focus:ring-offset-2 dark:focus:ring-offset-dark-bg">
              Reintentar
            </button>
          </div>
        )}
        {!isLoading && !isError && (
          <>
            {page === "overview"   && <Overview   printers={printers} historial={historial} />}
            {page === "mapa"       && <Mapa        printers={printers} />}
            {page === "alertas"    && <Alertas     printers={printers} />}
            {/* Sedes, Historial y Analiticas reciben allPrinters (sin filtrar):
                son vistas historicas, no un snapshot del estado actual. */}
            {page === "sedes"      && <Sedes       printers={allPrinters} historial={historial} />}
            {page === "historial"  && <Historial   printers={allPrinters} />}
            {page === "analiticas" && <Analiticas  printers={allPrinters} historial={historial} />}
            {page === "usuarios"   && <Usuarios    data={prStats ?? null} />}
            {page === "solicitudes" && <Solicitudes printers={printers} />}
            {page === "inventario" && <Inventario />}
          </>
        )}
      </main>
    </div>
  );
}
