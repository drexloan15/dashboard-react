"use client";
import dynamic from "next/dynamic";

const Dashboard = dynamic(() => import("@/components/DashboardClient"), {
  ssr: false,
  loading: () => (
    <div style={{
      minHeight: "100vh", background: "#07090f",
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
