import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Lexmark Monitor",
  description: "Dashboard de monitoreo de impresoras Lexmark – Molitalia Perú",
  icons: { icon: "/short-logo.png" },
};

// Corre ANTES del primer pintado: sin esto, la página arranca siempre en oscuro
// y salta al claro cuando React hidrata — un parpadeo blanco/negro en cada carga.
// Deja puestas la clase y el color-scheme; ThemeContext los lee de ahí.
const TEMA_INICIAL = `
(function () {
  try {
    var t = localStorage.getItem("theme");
    if (t !== "light" && t !== "dark") t = "dark";
    var e = document.documentElement;
    e.classList.add(t);
    e.style.colorScheme = t;
  } catch (_) {
    document.documentElement.classList.add("dark");
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: TEMA_INICIAL }} />
      </head>
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
