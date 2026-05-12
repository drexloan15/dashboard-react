import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.1.191", "192.168.1.179", "192.168.1.0/24"],
  async rewrites() {
    return [
      {
        source: "/api/py/:path*",
        destination: "http://localhost:8001/:path*",
      },
    ];
  },
};

export default nextConfig;
