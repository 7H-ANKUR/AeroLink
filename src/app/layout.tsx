import type { Metadata, Viewport } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const inter = Inter({
  variable: "--font-ui",
  subsets: ["latin"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-tech",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "FSOC-PAT — Virtual Coarse Alignment Laboratory",
  description:
    "AI-Assisted Virtual Camera Tracking System for Coarse Alignment of Mobile FSOC Terminals. SIH 2026 Problem Statement 169.",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230a0d10'/%3E%3Ccircle cx='16' cy='16' r='9' fill='none' stroke='%2372d9e8' stroke-width='1.5'/%3E%3Ccircle cx='16' cy='16' r='2.5' fill='%23fff7d8'/%3E%3Cpath d='M16 3v5M16 24v5M3 16h5M24 16h5' stroke='%2372d9e8' stroke-width='1.5'/%3E%3C/svg%3E",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0d10",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} ${plexMono.variable} antialiased bg-background text-foreground`}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
