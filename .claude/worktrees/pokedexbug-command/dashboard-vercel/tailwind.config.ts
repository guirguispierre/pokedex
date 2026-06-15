import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        discord: {
          primary: "#313338",
          secondary: "#2b2d31",
          tertiary: "#1e1f22",
          text: {
            DEFAULT: "#dbdee1",
            muted: "#949ba4",
          },
          muted: "#949ba4",
          accent: "#5865f2",
          blurple: "#5865f2",
          green: "#57f287",
          red: "#ed4245",
          yellow: "#fee75c",
          border: "#3f4147",
        },
      },
    },
  },
  plugins: [],
};

export default config;
