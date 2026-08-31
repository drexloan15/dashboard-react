"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { InventarioItem } from "@/types";
import {
  useInventario,
  useGuardarInventario,
  useBorrarInventario,
  useVerifyPin,
  leerPinGuardado,
  PIN_STORAGE_KEY,
} from "@/hooks/useData";

const VACIA: Omit<InventarioItem, "updated_at" | "updated_by"> = {
  serie: "", ip: "", sede: "", area: "", zona: "", modelo: "", tipo: "", conexion: "RED",
  activo: true,
};

const input =
  "w-full px-3 py-2 rounded-lg text-[13px] outline-none border " +
  "dark:border-dark-border border-light-border dark:bg-dark-surface bg-white " +
  "dark:text-dark-text text-light-text focus:border-blue-500";

/** Pide el PIN y lo guarda en sessionStorage: el backend lo exige en cada
 *  edicion (cabecera X-Admin-Pin), no basta con marcar la sesion como admin. */
function PedirPin({ onOk }: { onOk: () => void }) {
  const [pin, setPin]     = useState("");
  const [error, setError] = useState("");
  const verify            = useVerifyPin();

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const ok = await verify.mutateAsync(pin);
      if (!ok) return setError("PIN incorrecto.");
      try { sessionStorage.setItem(PIN_STORAGE_KEY, pin); } catch {}
      onOk();
    } catch {
      setError("No se pudo validar el PIN. Reintenta.");
    }
  }

  return (
    <div className="dark:bg-dark-card bg-white rounded-xl border dark:border-dark-border border-light-border p-6 max-w-sm">
      <h3 className="text-[14px] font-semibold dark:text-dark-text text-light-text mb-1">
        Editar inventario
      </h3>
      <p className="text-[12px] dark:text-dark-muted text-light-muted mb-4">
        El inventario decide qué impresoras se monitorean. Ingresa el PIN de
        administrador para poder modificarlo.
      </p>
      <form onSubmit={enviar} className="flex flex-col gap-3">
        <input
          type="password" value={pin} autoFocus
          onChange={e => setPin(e.target.value)}
          placeholder="PIN" className={input}
        />
        {error && <p className="text-[12px] text-red-500">{error}</p>}
        <button
          type="submit" disabled={!pin || verify.isPending}
          className="px-4 py-2 rounded-lg text-[13px] font-medium bg-blue-600 text-white disabled:opacity-50"
        >
          {verify.isPending ? "Validando..." : "Desbloquear"}
        </button>
      </form>
    </div>
  );
}

export default function Inventario() {
  const { data: items = [], isLoading, error } = useInventario();
  const guardar = useGuardarInventario();
  const borrar  = useBorrarInventario();

  const [desbloqueado, setDesbloqueado] = useState(() => !!leerPinGuardado());
  const [busqueda, setBusqueda]         = useState("");
  const [editando, setEditando]         = useState<string | null>(null);
  const [borrador, setBorrador]         = useState<typeof VACIA>(VACIA);
  const [nueva, setNueva]               = useState(false);
  const [aviso, setAviso]               = useState("");

  // El formulario se abre arriba de la tabla. Con 115 filas, al editar una de
  // abajo quedaba fuera de la pantalla y parecia que el boton no hacia nada.
  const panelRef = useRef<HTMLDivElement>(null);
  const primerCampoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editando) return;
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    // preventScroll: focus() hace su propio salto instantaneo y le ganaria
    // al desplazamiento suave de arriba.
    primerCampoRef.current?.focus({ preventScroll: true });
  }, [editando]);

  const filtradas = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i =>
      [i.serie, i.ip, i.sede, i.area, i.zona, i.modelo].some(v =>
        (v ?? "").toLowerCase().includes(q)));
  }, [items, busqueda]);

  function abrirEdicion(it: InventarioItem) {
    setNueva(false);
    setEditando(it.serie);
    setBorrador({ ...it });
    setAviso("");
  }

  function abrirNueva() {
    setNueva(true);
    setEditando("__nueva__");
    setBorrador(VACIA);
    setAviso("");
  }

  async function confirmar() {
    const serie = borrador.serie.trim();
    if (!serie) return setAviso("La serie es obligatoria: es la identidad de la impresora.");
    if (!borrador.ip.trim()) return setAviso("La IP es obligatoria.");
    if (nueva && items.some(i => i.serie === serie))
      return setAviso(`Ya existe una impresora con la serie ${serie}.`);
    try {
      const { serie: _s, ...datos } = borrador;
      await guardar.mutateAsync({ serie, datos });
      setEditando(null);
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: { detail?: string } } };
      setAviso(err.response?.status === 403
        ? "El PIN dejó de ser válido. Vuelve a desbloquear."
        : err.response?.data?.detail ?? "No se pudo guardar.");
    }
  }

  async function quitar(serie: string) {
    if (!confirm(`¿Quitar ${serie} del inventario?\n\nDeja de monitorearse. Su historial se conserva.`)) return;
    try {
      await borrar.mutateAsync(serie);
    } catch {
      setAviso("No se pudo eliminar.");
    }
  }

  if (!desbloqueado) return <PedirPin onOk={() => setDesbloqueado(true)} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="dark:bg-dark-card bg-white rounded-xl border dark:border-dark-border border-light-border p-4">
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={busqueda} onChange={e => setBusqueda(e.target.value)}
            placeholder="Buscar por serie, IP, sede, área o modelo..."
            className={input + " flex-1 min-w-[220px]"}
          />
          <button onClick={abrirNueva}
            className="px-4 py-2 rounded-lg text-[13px] font-medium bg-blue-600 text-white">
            + Agregar impresora
          </button>
          <a href="/api/py/inventario/export.csv"
            className="px-4 py-2 rounded-lg text-[13px] font-medium border dark:border-dark-border border-light-border dark:text-dark-text text-light-text">
            Descargar CSV
          </a>
        </div>
        <p className="text-[12px] dark:text-dark-muted text-light-muted mt-3">
          {filtradas.length} de {items.length} impresoras ·{" "}
          {items.filter(i => i.activo).length} activas. Los agentes descargan
          esta lista en cada ciclo, así que los cambios se aplican solos.
        </p>
      </div>

      {aviso && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-[12px] text-red-500">
          {aviso}
        </div>
      )}

      {isLoading && <p className="text-[12px] dark:text-dark-muted text-light-muted">Cargando inventario...</p>}
      {error && <p className="text-[12px] text-red-500">No se pudo cargar el inventario.</p>}

      {editando && (
        <div ref={panelRef}
          className="dark:bg-dark-card bg-white rounded-xl border-2 border-blue-500 p-5">
          <h3 className="text-[14px] font-semibold dark:text-dark-text text-light-text mb-4">
            {nueva ? "Nueva impresora" : `Editar ${borrador.serie}`}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] dark:text-dark-muted text-light-muted">
                SERIE {nueva ? "(no se puede cambiar después)" : "(fija)"}
              </span>
              <input className={input} value={borrador.serie} disabled={!nueva}
                ref={nueva ? primerCampoRef : undefined}
                onChange={e => setBorrador({ ...borrador, serie: e.target.value })} />
            </label>
            {([["ip", "IP"], ["sede", "SEDE"], ["area", "ÁREA"], ["zona", "ZONA"],
               ["modelo", "MODELO"], ["tipo", "TIPO"], ["conexion", "CONEXIÓN"]] as const).map(([campo, etiqueta]) => (
              <label key={campo} className="flex flex-col gap-1">
                <span className="text-[11px] dark:text-dark-muted text-light-muted">{etiqueta}</span>
                <input className={input} value={borrador[campo]}
                  ref={!nueva && campo === "ip" ? primerCampoRef : undefined}
                  onChange={e => setBorrador({ ...borrador, [campo]: e.target.value })} />
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 mt-4 text-[13px] dark:text-dark-text text-light-text">
            <input type="checkbox" checked={borrador.activo}
              onChange={e => setBorrador({ ...borrador, activo: e.target.checked })} />
            Activa — si la desmarcas deja de monitorearse, pero conserva su ficha y su historial
          </label>
          <div className="flex gap-2 mt-4">
            <button onClick={confirmar} disabled={guardar.isPending}
              className="px-4 py-2 rounded-lg text-[13px] font-medium bg-blue-600 text-white disabled:opacity-50">
              {guardar.isPending ? "Guardando..." : "Guardar"}
            </button>
            <button onClick={() => { setEditando(null); setAviso(""); }}
              className="px-4 py-2 rounded-lg text-[13px] font-medium border dark:border-dark-border border-light-border dark:text-dark-text text-light-text">
              Cancelar
            </button>
          </div>
        </div>
      )}

      <div className="dark:bg-dark-card bg-white rounded-xl border dark:border-dark-border border-light-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="dark:bg-dark-surface bg-gray-50 dark:text-dark-muted text-light-muted">
                {["SERIE", "IP", "SEDE", "ÁREA", "ZONA", "MODELO", "TIPO", "ESTADO", ""].map(h => (
                  <th key={h} className="text-left font-medium px-3 py-2.5 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtradas.map(it => (
                <tr key={it.serie}
                  className={"border-t dark:border-dark-border border-light-border " +
                    "dark:text-dark-text text-light-text " +
                    (editando === it.serie ? "bg-blue-500/10" : "")}>
                  <td className="px-3 py-2 font-mono whitespace-nowrap">{it.serie}</td>
                  <td className="px-3 py-2 font-mono whitespace-nowrap">{it.ip}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{it.sede}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{it.area}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{it.zona}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{it.modelo}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{it.tipo}</td>
                  <td className="px-3 py-2">
                    <span className={"text-[10px] font-bold px-1.5 py-0.5 rounded " +
                      (it.activo ? "text-green-600 bg-green-500/10" : "text-gray-500 bg-gray-500/10")}>
                      {it.activo ? "ACTIVA" : "INACTIVA"}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    <button onClick={() => abrirEdicion(it)} className="text-blue-500 mr-3">Editar</button>
                    <button onClick={() => quitar(it.serie)} className="text-red-500">Quitar</button>
                  </td>
                </tr>
              ))}
              {!isLoading && filtradas.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center dark:text-dark-muted text-light-muted">
                    Ninguna impresora coincide con la búsqueda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
