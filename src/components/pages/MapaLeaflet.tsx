"use client";
import L from "leaflet";
import { MapContainer, TileLayer, Marker, Popup, Tooltip } from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import "leaflet/dist/leaflet.css";

export interface OfflinePrinter { ip: string; modelo: string; }

export interface SedeInfo {
  sede: string;
  lat: number;
  lon: number;
  total: number;
  online: number;
  offline: number;
  pct: number;
  color: string;
  offlinePrinters: OfflinePrinter[];
}

// Separa ligeramente sedes que están a <0.04° entre sí (mismo bloque/edificio)
function spreadOverlapping(sedes: SedeInfo[]) {
  const out = sedes.map(s => ({ ...s, displayLat: s.lat, displayLon: s.lon }));
  const THRESH = 0.005;
  const RADIUS = 0.01;
  const used = new Set<number>();

  for (let i = 0; i < sedes.length; i++) {
    if (used.has(i)) continue;
    const group = [i];
    for (let j = i + 1; j < sedes.length; j++) {
      if (used.has(j)) continue;
      if (
        Math.abs(sedes[i].lat - sedes[j].lat) < THRESH &&
        Math.abs(sedes[i].lon - sedes[j].lon) < THRESH
      ) {
        group.push(j);
        used.add(j);
      }
    }
    used.add(i);
    if (group.length > 1) {
      const cLat = group.reduce((s, k) => s + sedes[k].lat, 0) / group.length;
      const cLon = group.reduce((s, k) => s + sedes[k].lon, 0) / group.length;
      group.forEach((k, pos) => {
        const angle = (pos / group.length) * 2 * Math.PI - Math.PI / 2;
        out[k].displayLat = cLat + RADIUS * Math.cos(angle);
        out[k].displayLon = cLon + RADIUS * Math.sin(angle);
      });
    }
  }
  return out;
}

function pinIcon(color: string, pct: number, total: number) {
  // Color con 28% opacidad para el ring exterior
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const glow = `rgba(${r},${g},${b},0.28)`;
  return L.divIcon({
    html: `<div class="map-pin" style="--c:${color};--g:${glow}">
             <span class="mp-pct">${pct}%</span>
             <span class="mp-eq">${total} eq</span>
           </div>`,
    className: "",
    iconSize: [56, 56],
    iconAnchor: [28, 28],
    popupAnchor: [0, -34],
  });
}

function clusterIcon(cluster: { getChildCount: () => number }) {
  const n = cluster.getChildCount();
  return L.divIcon({
    html: `<div class="map-pin" style="--c:#3d8ef5;--g:rgba(61,142,245,0.28)">
             <span class="mp-pct">${n}</span>
             <span class="mp-eq">sedes</span>
           </div>`,
    className: "",
    iconSize: [56, 56],
    iconAnchor: [28, 28],
  });
}

export default function MapaLeaflet({ sedes }: { sedes: SedeInfo[] }) {
  return (
    <MapContainer
      center={[-9.30, -75.00]}
      zoom={5}
      style={{ height: "100%", width: "100%", minHeight: 520 }}
      scrollWheelZoom
      className="rounded-xl"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      <MarkerClusterGroup
        iconCreateFunction={clusterIcon}
        maxClusterRadius={60}
        showCoverageOnHover={false}
        chunkedLoading
      >
      {sedes.map((s, i) => (
        <Marker
          key={i}
          position={[s.lat, s.lon]}
          icon={pinIcon(s.color, s.pct, s.total)}
        >
          {/* Nombre al hacer hover */}
          <Tooltip direction="top" offset={[0, -32]} className="sede-tip">
            {s.sede}
          </Tooltip>

          {/* Detalle al hacer click */}
          <Popup>
            <div style={{ fontFamily: "Inter, sans-serif", minWidth: 170 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8, color: "#111" }}>
                {s.sede}
              </div>
              <table style={{ fontSize: 12, width: "100%", borderCollapse: "collapse" }}>
                <tbody>
                  <tr>
                    <td style={{ color: "#555", paddingBottom: 3 }}>Total</td>
                    <td style={{ fontWeight: 700, textAlign: "right" }}>{s.total} equipos</td>
                  </tr>
                  <tr>
                    <td style={{ color: "#16a34a", paddingBottom: 3 }}>Online</td>
                    <td style={{ fontWeight: 700, textAlign: "right", color: "#16a34a" }}>{s.online}</td>
                  </tr>
                  <tr>
                    <td style={{ color: "#dc2626", paddingBottom: 3 }}>Offline</td>
                    <td style={{ fontWeight: 700, textAlign: "right", color: "#dc2626" }}>{s.offline}</td>
                  </tr>
                  <tr>
                    <td style={{ color: "#555", paddingTop: 6, borderTop: "1px solid #eee" }}>Uptime</td>
                    <td style={{ fontWeight: 800, textAlign: "right", color: s.color, paddingTop: 6, borderTop: "1px solid #eee", fontSize: 15 }}>
                      {s.pct}%
                    </td>
                  </tr>
                </tbody>
              </table>
              {s.offlinePrinters.length > 0 && (
                <div style={{ marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", marginBottom: 5 }}>
                    Offline ({s.offlinePrinters.length})
                  </div>
                  <div style={{ maxHeight: 120, overflowY: "auto" }}>
                    {s.offlinePrinters.map((p, i) => (
                      <div key={i} style={{ fontSize: 11, marginBottom: 3, display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <span style={{ fontFamily: "monospace", color: "#111" }}>{p.ip}</span>
                        {p.modelo && <span style={{ color: "#6b7280", fontSize: 10 }}>{p.modelo}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ fontSize: 10, color: "#aaa", marginTop: 6 }}>
                {s.lat.toFixed(5)}, {s.lon.toFixed(5)}
              </div>
            </div>
          </Popup>
        </Marker>
      ))}
      </MarkerClusterGroup>
    </MapContainer>
  );
}
