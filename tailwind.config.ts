import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: { sans: ["Inter", "sans-serif"] },
      colors: {
        dark: {
          bg:      "#07090f",
          surface: "#0d1117",
          card:    "#0f1824",
          border:  "#1a2535",
          border2: "#223040",
          text:    "#d0dce8",
          muted:   "#4e6070",
        },
        light: {
          bg:      "#f8f9fa",
          surface: "#ffffff",
          card:    "#ffffff",
          border:  "#dee2e6",
          border2: "#e9ecef",
          text:    "#212529",
          muted:   "#6c757d",
        },
        brand: {
          green:  "#20c97a",
          yellow: "#e0b030",
          red:    "#f04545",
          blue:   "#3d8ef5",
          cyan:   "#2ec4d0",
          purple: "#9d6ff5",
          orange: "#d4632a",
        },
      },
    },
  },
  plugins: [],
};

export default config;
