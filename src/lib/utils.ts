import { SUMINISTROS } from "@/types";
import type { Printer } from "@/types";

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace("%", "").trim();
  if (["N/A", "OK", "", "None", "nan"].includes(s)) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/**
 * Color del nivel de un suministro.
 *
 * El parametro `theme` existia pero se descartaba con `void theme`, asi que en
 * modo claro se pintaban los tonos pensados para fondo oscuro. El amarillo
 * #e0b030 sobre una tarjeta blanca da un contraste de ~1.9:1 — practicamente
 * ilegible. En claro se usan variantes mas oscuras del mismo tono: se mantiene
 * el codigo de color (rojo/ambar/verde) y se recupera la lectura.
 */
export function nivelColor(v: number | null, theme: "dark" | "light"): string {
  const claro = theme === "light";
  if (v === null) return claro ? "#6c757d" : "#4e6070";
  if (v <= 10)    return claro ? "#c92a2a" : "#f04545";
  if (v <= 30)    return claro ? "#9a6700" : "#e0b030";
  return            claro ? "#0f7a48" : "#20c97a";
}

export function parsePrinter(r: Printer) {
  const out: Record<string, number | null> = {};
  for (const [col] of SUMINISTROS) {
    out[col + "_N"] = toNum(r[col]);
  }
  out["CONTADOR_N"] = toNum(r.CONTADOR);
  return { ...r, ...out };
}

export function clsx(...args: (string | undefined | null | false)[]): string {
  return args.filter(Boolean).join(" ");
}
