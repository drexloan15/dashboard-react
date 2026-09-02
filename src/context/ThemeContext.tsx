"use client";
import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light";
interface ThemeCtx { theme: Theme; toggle: () => void }

export const THEME_KEY = "theme";

const Ctx = createContext<ThemeCtx>({ theme: "dark", toggle: () => {} });

/**
 * Antes esto solo hacía `classList.toggle("dark", ...)`. Tres consecuencias:
 *
 * 1. La clase `light` no se ponía NUNCA, así que la regla
 *    `.light ::-webkit-scrollbar-thumb` de globals.css era código muerto y la
 *    barra de scroll se quedaba oscura en modo claro.
 * 2. No se tocaba `color-scheme`, así que los controles nativos del navegador
 *    (el desplegable de un `<select>`, el calendario de un `<input type=date>`)
 *    se dibujaban siempre en claro. En modo oscuro el icono del calendario
 *    quedaba negro sobre fondo negro.
 * 3. No se guardaba nada: al recargar siempre volvía a oscuro.
 *
 * El estado inicial se lee del `<html>`, que el script inline de layout.tsx ya
 * dejó puesto antes del primer pintado. Así el arranque no parpadea.
 */
function temaInicial(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(temaInicial);

  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle("dark",  theme === "dark");
    el.classList.toggle("light", theme === "light");
    // Le dice al navegador con qué paleta pintar scrollbars, selects y el
    // selector de fecha. Es lo que arregla el calendario invisible.
    el.style.colorScheme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* modo privado */ }
  }, [theme]);

  const toggle = () => setTheme(t => (t === "dark" ? "light" : "dark"));

  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
