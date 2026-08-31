import type { NextConfig } from "next";

// En Docker el backend es otro contenedor ("backend"); en local sigue siendo localhost.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8001";

const nextConfig: NextConfig = {
  // El /24 cubre toda la LAN, asi que no hace falta listar maquinas sueltas.
  // Antes estaban 192.168.1.191 (servidor viejo, muerto el 2026-08-28) y
  // 192.168.1.179, ambas ya incluidas en el rango.
  allowedDevOrigins: ["192.168.1.0/24"],
  async rewrites() {
    return [
      {
        source: "/api/py/:path*",
        destination: `${BACKEND_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
