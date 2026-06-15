import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: "#0a0e17",
          card: "rgba(255,255,255,0.035)",
          hover: "rgba(255,255,255,0.06)",
        },
        gold: {
          DEFAULT: "#f0c840",
          soft: "#d4a828",
          glow: "rgba(240,200,64,0.12)",
        },
        accent: "#6366f1",
        border: "rgba(255,255,255,0.06)",
      },
      fontFamily: {
        sans: ["Outfit", "system-ui", "sans-serif"],
        mono: ["Fira Code", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
