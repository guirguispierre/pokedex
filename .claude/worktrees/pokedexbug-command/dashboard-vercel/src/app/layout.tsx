import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PokeMod Dashboard",
  description: "Moderator dashboard for PokeMod Discord bot",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-discord-primary text-discord-text min-h-screen">
        {children}
      </body>
    </html>
  );
}
