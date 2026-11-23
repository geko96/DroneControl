import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Control de dron",
  description: "Dashboard de control de dron con simulación 3D sobre datos satelitales",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
