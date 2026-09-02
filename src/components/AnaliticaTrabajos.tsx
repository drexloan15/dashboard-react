"use client";
import { useMemo, useState } from "react";
import Card from "@/components/ui/Card";
import { useAnalitica } from "@/hooks/useData";

// Analítica sobre pr_stats (trabajos de impresión), calculada en el backend.
//
// Es la contraparte de lo que hay más abajo en esta misma página, que trabaja
// sobre historial (contadores SNMP). La diferencia importa: historial arrancó el
// 2026-08-31 — el servidor anterior murió y se llevó el histórico —, mientras
// que pr_stats tiene ~495 mil trabajos desde el 2026-04-23. Casi todo lo que se
// puede afirmar hoy con datos suficientes sale de acá.

const N = (v: number) => v.toLocaleString("es-PE");

function Kpi({ label, value, sub, tono }: {
  label: string; value: string; sub: string; tono?: "rojo" | "azul" | "verde";
}) {
  const color = tono === "rojo" ? "text-brand-red"
              : tono === "verde" ? "text-brand-green"
              : "text-brand-blue";
  return (
    <Card className="dark:bg-dark-card p-4">
      <p className="text-[9px] dark:text-dark-muted text-light-muted uppercase font-bold tracking-wider mb-1">
        {label}
      </p>
      <p className={`text-[20px] font-black ${color}`}>{value}</p>
      <p className="text-[10px] dark:text-dark-muted text-light-muted">{sub}</p>
    </Card>
  );
}

function Barra({ pct, color = "bg-brand-blue" }: { pct: number; color?: string }) {
  return (
    <div className="h-2 w-full dark:bg-dark-border bg-gray-200 rounded-full overflow-hidden">
      <div className={`h-full ${color} rounded-full transition-all duration-700`}
           style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

export default function AnaliticaTrabajos() {
  const { data, isLoading, isError } = useAnalitica();
  const [sedeSel, setSedeSel] = useState("global");

  const d  = data?.descriptiva;
  const pv = data?.predictiva?.volumen;

  const serie = useMemo(() => {
    if (!pv) return null;
    return sedeSel === "global" ? pv.global : pv.sedes[sedeSel] ?? pv.global;
  }, [pv, sedeSel]);

  if (isLoading) {
    return <Card><p className="text-[12px] dark:text-dark-muted text-light-muted">Calculando analítica…</p></Card>;
  }
  if (isError || !data?.exists || !d || !pv || !serie) {
    return (
      <Card>
        <p className="text-[12px] dark:text-dark-muted text-light-muted">
          Analítica de trabajos no disponible (pr_stats sin datos).
        </p>
      </Card>
    );
  }

  const t = d.totales;
  const maxDow = Math.max(...d.por_dow.map(x => x.promedio), 1);
  const maxPron = Math.max(...serie.pronostico.map(p => p.paginas), 1);
  const bt = serie.backtest;

  return (
    <div className="flex flex-col gap-6">

      {/* Contexto del período: sin esto los números no se pueden interpretar */}
      <div className="flex items-center justify-between flex-wrap gap-2 text-[11px]">
        <span className="dark:text-dark-muted text-light-muted">
          Trabajos de impresión desde{" "}
          <span className="font-bold dark:text-dark-text text-light-text">{t.desde}</span>{" "}
          hasta <span className="font-bold dark:text-dark-text text-light-text">{t.hasta}</span>{" "}
          ({t.dias} días · {N(t.trabajos)} trabajos · {t.usuarios} usuarios)
        </span>
        <span
          title={data.regimen?.nota}
          className="px-2 py-0.5 rounded bg-brand-blue/10 text-brand-blue font-bold cursor-help"
        >
          ⓘ desde {data.regimen?.desde}
        </span>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi label="Páginas impresas" value={N(t.impresas)} sub="llegaron al papel" tono="verde" />
        <Kpi label="Enviadas, no impresas" value={N(t.no_impresas)}
             sub={`${t.pct_no_impresas}% de todo lo enviado`} tono="rojo" />
        <Kpi label="Impresión a color" value={`${d.modo.pct_color}%`}
             sub={`${N(d.modo.color)} págs. — cuesta varias veces más`} />
        <Kpi label="Impresión dúplex" value={`${d.modo.pct_duplex}%`}
             sub={`${N(d.modo.simplex)} págs. a una cara`} />
      </div>

      {/* Desperdicio por sede REAL (inventario), no por el `site` de LPM */}
      <Card className="dark:bg-dark-card">
        <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text uppercase tracking-wider mb-1">
          Enviadas que no se imprimieron, por sede
        </h2>
        <p className="text-[10px] dark:text-dark-muted text-light-muted mb-4">
          Páginas que se pidieron y no salieron en papel. La sede sale del
          inventario, cruzando por número de serie — no del campo <code>site</code> de
          LPM, que mezcla sedes distintas bajo una misma etiqueta.
        </p>
        <div className="overflow-x-auto max-h-[460px] overflow-y-auto">
          <table className="w-full text-left text-[11px] whitespace-nowrap">
            <thead className="sticky top-0 z-10 dark:bg-dark-card bg-white dark:text-dark-muted text-light-muted uppercase border-b dark:border-dark-border border-light-border">
              <tr>
                <th className="py-2 pr-3 font-bold">Sede</th>
                <th className="py-2 px-2 font-bold text-right">Total</th>
                <th className="py-2 px-2 font-bold text-right">Impresas</th>
                <th className="py-2 px-2 font-bold text-right text-brand-red">No impresas</th>
                <th className="py-2 px-2 font-bold text-right">Expiradas</th>
                <th className="py-2 px-2 font-bold text-right">Eliminadas</th>
                <th className="py-2 pl-2 font-bold w-36">% no impresas</th>
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-dark-border divide-light-border">
              {d.por_sede.map(s => {
                // Muy por encima de la media global: merece una mirada, no es ruido.
                const alto  = s.pct_no_impresas >= t.pct_no_impresas * 1.5;
                const fuera = s.sede === "(fuera de inventario)";
                return (
                  <tr key={s.sede} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                    <td className="py-2 pr-3 font-medium dark:text-dark-text text-light-text">
                      {s.sede}
                      {fuera && (
                        <span
                          title="Impresoras que registran trabajos en LPM pero no están en el inventario. No se monitorean por SNMP ni entran en la predicción de suministros."
                          className="ml-1.5 text-[9px] bg-orange-500/15 text-orange-500 px-1.5 py-0.5 rounded font-bold uppercase cursor-help"
                        >
                          ⚠ sin inventariar
                        </span>
                      )}
                      {alto && !fuera && (
                        <span
                          title={`Más del 150% de la media global (${t.pct_no_impresas}%).`}
                          className="ml-1.5 text-[9px] bg-red-500/15 text-brand-red px-1.5 py-0.5 rounded font-bold uppercase cursor-help"
                        >
                          ▲ atípico
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right dark:text-dark-muted text-light-muted">{N(s.paginas)}</td>
                    <td className="py-2 px-2 text-right dark:text-dark-text text-light-text">{N(s.impresas)}</td>
                    <td className="py-2 px-2 text-right font-bold text-brand-red">{N(s.no_impresas)}</td>
                    <td className="py-2 px-2 text-right dark:text-dark-muted text-light-muted">
                      {s.expiradas > 0 ? N(s.expiradas) : "—"}
                    </td>
                    <td className="py-2 px-2 text-right dark:text-dark-muted text-light-muted">
                      {s.eliminadas > 0 ? N(s.eliminadas) : "—"}
                    </td>
                    <td className="py-2 pl-2">
                      <div className="flex items-center gap-2">
                        <Barra pct={s.pct_no_impresas * 2} color="bg-brand-red" />
                        <span className="font-bold text-brand-red w-10 text-right">
                          {s.pct_no_impresas}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Por qué la comparación no se hace por el `site` de LPM */}
        <details className="mt-3 text-[10px] dark:text-dark-muted text-light-muted">
          <summary className="cursor-pointer font-semibold">
            Por qué no se agrupa por el campo <code>site</code> de LPM
          </summary>
          <p className="mt-2 leading-relaxed">
            LPM reporta solo dos <code>site</code>, y ninguno es una ubicación: cada uno
            contiene impresoras de las 16 sedes, y las mismas impresoras aparecen en los
            dos. Uno se llama además <code>VENEZUELA</code>, igual que una sede real que
            no es lo mismo. Lo que sí los distingue es cómo etiquetan el desenlace de un
            trabajo: el mismo evento sale como cancelado en uno y expirado en el otro, y
            las expiradas y eliminadas solo existen en uno. Por eso el desglose se hace por
            <code>releasemethod</code>, que significa lo mismo en ambos entornos.
          </p>
          <div className="mt-2 flex flex-wrap gap-4">
            {d.por_lpm.map(l => (
              <span key={l.entorno} className="font-mono">
                {l.entorno}: {N(l.paginas)} págs · {l.pct_no_impresas}% no impresas ·{" "}
                {N(l.expiradas)} expiradas · {N(l.eliminadas)} eliminadas
              </span>
            ))}
          </div>
        </details>
      </Card>

      {/* Las tres causas. Solo una tiene explicación comprobada. */}
      <Card className="dark:bg-dark-card">
        <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text uppercase tracking-wider mb-1">
          Por qué no se imprimieron
        </h2>
        <p className="text-[10px] dark:text-dark-muted text-light-muted mb-4">
          Un trabajo o llegó al papel o no llegó. Lo que no llegó <strong>no gastó
          papel ni tóner</strong> — esto mide fricción entre pedir una impresión y
          obtenerla, no dinero perdido.
        </p>
        <div className="grid sm:grid-cols-3 gap-3">
          {[
            { k: "sin_liberar" as const, t: "Sin liberar", n: t.sin_liberar,
              d: "Causa desconocida. Es la mayoría. Solo consta que no se imprimió: LPM copia la fecha final de la de envío, así que no se sabe cuánto esperó.",
              cierto: false },
            { k: "expiradas" as const, t: "Expiradas", n: t.expiradas,
              d: "Retención de 48 h agotada (mediana 48.5 h) y sin usuario, IP ni equipo de liberación registrados. Nadie las tocó nunca.",
              cierto: true },
            { k: "eliminadas" as const, t: "Eliminadas", n: t.eliminadas,
              d: "Alguien identificado actuó sobre el trabajo (mediana 23 min desde el envío).",
              cierto: true },
          ].map(c => (
            <div key={c.k} className="rounded-lg border dark:border-dark-border border-light-border p-3
                                      dark:bg-dark-border/20 bg-gray-50">
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <p className="text-[11px] font-bold dark:text-dark-text text-light-text">{c.t}</p>
                <span className={`text-[8px] uppercase font-bold px-1.5 py-0.5 rounded ${
                  c.cierto ? "bg-green-500/15 text-brand-green" : "bg-orange-500/15 text-orange-500"}`}>
                  {c.cierto ? "comprobado" : "sin explicar"}
                </span>
              </div>
              <p className="text-[18px] font-black text-brand-red leading-tight">{N(c.n)}</p>
              <p className="text-[9px] dark:text-dark-muted text-light-muted mt-1 leading-relaxed">{c.d}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* Zona: Lima vs Provincia, la misma partición que ya usa el sidebar */}
      <Card className="dark:bg-dark-card">
        <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text uppercase tracking-wider mb-3">
          Por zona
        </h2>
        <div className="flex flex-col gap-2">
          {d.por_zona.map(z => (
            <div key={z.zona} className="flex items-center gap-3 text-[11px]">
              <span className="w-28 dark:text-dark-muted text-light-muted">{z.zona}</span>
              <span className="w-24 text-right font-bold dark:text-dark-text text-light-text">
                {N(z.paginas)}
              </span>
              <div className="flex-1"><Barra pct={z.pct_no_impresas * 2} color="bg-brand-red" /></div>
              <span className="w-16 text-right font-bold text-brand-red">
                {z.pct_no_impresas}%
              </span>
            </div>
          ))}
        </div>
      </Card>

      {/* Patrón semanal */}
      <div className="grid lg:grid-cols-2 gap-6">
        <Card className="dark:bg-dark-card">
          <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text uppercase tracking-wider mb-1">
            Patrón por día de la semana
          </h2>
          <p className="text-[10px] dark:text-dark-muted text-light-muted mb-4">
            Promedio de páginas impresas. Acá se trabaja sábado: un calendario
            genérico de lunes a viernes modelaría mal buena parte del volumen.
          </p>
          <div className="flex flex-col gap-2">
            {d.por_dow.map(x => (
              <div key={x.dow} className="flex items-center gap-3 text-[11px]">
                <span className="w-20 dark:text-dark-muted text-light-muted">{x.nombre}</span>
                <div className="flex-1"><Barra pct={(x.promedio / maxDow) * 100} /></div>
                <span className="w-16 text-right font-bold dark:text-dark-text text-light-text">
                  {N(x.promedio)}
                </span>
              </div>
            ))}
          </div>
        </Card>

        {/* Tendencia mensual */}
        <Card className="dark:bg-dark-card">
          <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text uppercase tracking-wider mb-1">
            No impresas por mes
          </h2>
          <p className="text-[10px] dark:text-dark-muted text-light-muted mb-4">
            Sirve para ver si las medidas que se tomen mueven la aguja.
          </p>
          <div className="flex flex-col gap-2">
            {d.por_mes.map(m => (
              <div key={m.mes} className="flex items-center gap-3 text-[11px]">
                <span className="w-16 font-mono dark:text-dark-muted text-light-muted">{m.mes}</span>
                <div className="flex-1"><Barra pct={m.pct_no_impresas * 3} color="bg-brand-red" /></div>
                <span className="w-12 text-right font-bold text-brand-red">{m.pct_no_impresas}%</span>
                <span className="w-16 text-right dark:text-dark-muted text-light-muted">
                  {N(m.no_impresas)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Pronóstico de volumen */}
      <Card className="dark:bg-dark-card">
        <div className="flex items-start justify-between flex-wrap gap-3 mb-1">
          <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text uppercase tracking-wider">
            Pronóstico de volumen — próximos {pv.horizonte_dias} días
          </h2>
          <select value={sedeSel} onChange={e => setSedeSel(e.target.value)}
            className="text-[10px] dark:bg-dark-card bg-white border dark:border-dark-border border-light-border rounded px-1.5 py-0.5 dark:text-dark-text outline-none cursor-pointer">
            <option value="global">Todas las sedes</option>
            {Object.keys(pv.sedes).sort().map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <p className="text-[10px] dark:text-dark-muted text-light-muted mb-3">
          Línea base: la mediana de los últimos 8 mismos días de la semana. Es
          deliberadamente simple — con ~22 semanas de datos, un modelo complejo
          memorizaría en vez de aprender — y sirve de piso de comparación para
          cualquier modelo que se pruebe después.
        </p>

        {/* Precisión medida, no prometida */}
        <div className="mb-4 rounded-lg border dark:border-dark-border border-light-border p-3
                        dark:bg-dark-border/20 bg-gray-50">
          {bt.suficiente ? (
            <p className="text-[11px] dark:text-dark-text text-light-text">
              <span className="font-bold">Precisión medida:</span>{" "}
              se reservaron los últimos {bt.dias} días, se predijeron sin mirarlos y
              se comparó contra lo real → error medio{" "}
              <span className="font-bold text-brand-blue">{N(bt.mae ?? 0)} páginas</span>
              {bt.mape != null && <> (<span className="font-bold text-brand-blue">{bt.mape}%</span>)</>}.
              <span className="dark:text-dark-muted text-light-muted">
                {" "}La partición es cronológica, no aleatoria: en una serie temporal,
                partir al azar entrena con el futuro y devuelve métricas falsas.
              </span>
            </p>
          ) : (
            <p className="text-[11px] dark:text-dark-muted text-light-muted">
              Sin datos suficientes para validar ({bt.tiene_dias} días de {bt.requiere_dias}
              {" "}necesarios). El pronóstico se muestra, pero su precisión no está medida.
            </p>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px] whitespace-nowrap">
            <thead className="dark:text-dark-muted text-light-muted uppercase border-b dark:border-dark-border border-light-border">
              <tr>
                <th className="py-2 pr-3 font-bold">Fecha</th>
                <th className="py-2 px-2 font-bold">Día</th>
                <th className="py-2 px-2 font-bold text-right">Páginas previstas</th>
                <th className="py-2 px-2 font-bold text-right">Muestra</th>
                <th className="py-2 pl-2 font-bold w-40">Relativo</th>
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-dark-border divide-light-border">
              {serie.pronostico.map(p => (
                <tr key={p.fecha} className={p.dow === 7 ? "opacity-60" : ""}>
                  <td className="py-2 pr-3 font-mono dark:text-dark-text text-light-text">{p.fecha}</td>
                  <td className="py-2 px-2 dark:text-dark-muted text-light-muted">{p.nombre}</td>
                  <td className="py-2 px-2 text-right font-bold text-brand-blue">{N(p.paginas)}</td>
                  <td className="py-2 px-2 text-right dark:text-dark-muted text-light-muted"
                      title="Cuántos mismos días de la semana entraron en la mediana">
                    {p.muestra_n}
                  </td>
                  <td className="py-2 pl-2"><Barra pct={(p.paginas / maxPron) * 100} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Quién desperdicia: la lista accionable */}
      <Card className="dark:bg-dark-card">
        <h2 className="text-[13px] font-bold dark:text-dark-text text-light-text uppercase tracking-wider mb-1">
          Más envíos que no se imprimieron, por usuario
        </h2>
        <p className="text-[10px] dark:text-dark-muted text-light-muted mb-4">
          El % es sobre lo que esa persona mandó a imprimir, no sobre el total de
          la empresa. No es una lista de culpables: también puede señalar a quien
          tiene un problema con el flujo de liberación.
        </p>
        <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
          <table className="w-full text-left text-[11px] whitespace-nowrap">
            <thead className="sticky top-0 z-10 dark:bg-dark-card bg-white dark:text-dark-muted text-light-muted uppercase border-b dark:border-dark-border border-light-border">
              <tr>
                <th className="py-2 pr-3 font-bold">Usuario</th>
                <th className="py-2 px-2 font-bold text-right text-brand-red">Págs. no impresas</th>
                <th className="py-2 px-2 font-bold text-right">Trabajos</th>
                <th className="py-2 px-2 font-bold text-right">Sí impresas</th>
                <th className="py-2 pl-2 font-bold w-32">% suyo no impreso</th>
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-dark-border divide-light-border">
              {d.top_no_impresas.map(u => (
                <tr key={u.userid} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                  <td className="py-2 pr-3 font-mono font-semibold dark:text-dark-text text-light-text">
                    {u.userid}
                  </td>
                  <td className="py-2 px-2 text-right font-bold text-brand-red">{N(u.no_impresas)}</td>
                  <td className="py-2 px-2 text-right dark:text-dark-muted text-light-muted">
                    {N(u.trabajos_no_impresos)}
                  </td>
                  <td className="py-2 px-2 text-right dark:text-dark-muted text-light-muted">
                    {N(u.impresas)}
                  </td>
                  <td className="py-2 pl-2">
                    <div className="flex items-center gap-2">
                      <Barra pct={u.pct} color="bg-brand-red" />
                      <span className="font-bold text-brand-red w-10 text-right">{u.pct}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-[9px] dark:text-dark-muted text-light-muted text-right">
        Calculado en el servidor sobre {N(t.trabajos)} trabajos · generado {data.generado}
      </p>
    </div>
  );
}
