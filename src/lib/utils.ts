import { SUMINISTROS } from "@/types";
import type { Printer } from "@/types";

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace("%", "").trim();
  if (["N/A", "OK", "", "None", "nan"].includes(s)) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

export function nivelColor(v: number | null, theme: "dark" | "light"): string {
  void theme;
  if (v === null) return "#4e6070";
  if (v <= 10) return "#f04545";
  if (v <= 30) return "#e0b030";
  return "#20c97a";
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
