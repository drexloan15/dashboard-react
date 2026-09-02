"use client";
import dynamic from "next/dynamic";

const Dashboard = dynamic(() => import("@/components/DashboardClient"), {
  ssr: false,
  loading: () => (
    // Fondo transparente a propósito: el <body> ya pinta el color del tema
    // activo (lo deja puesto el script inline de layout.tsx antes del primer
    // pintado). Antes esto forzaba "#07090f", así que en modo claro cada carga
    // empezaba con una pantalla casi negra y luego saltaba a blanco.
    <div style={{
      minHeight: "100vh",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: "50%",
        border: "4px solid #3d8ef5", borderTopColor: "transparent",
        animation: "spin 1s linear infinite",
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  ),
});

export default function ClientWrapper() {
  return <Dashboard />;
}
