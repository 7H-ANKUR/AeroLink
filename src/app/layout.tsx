import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-ui",
  subsets: ["latin"],
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-tech",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "AeroLink FSOC-PAT — Virtual Coarse Alignment Laboratory",
  description:
    "AI-Assisted Virtual Camera Tracking System for Coarse Alignment of Mobile FSOC Terminals. SIH 2026 Problem Statement 169.",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23fbf4ee'/%3E%3Ccircle cx='16' cy='16' r='9' fill='none' stroke='%23ce4710' stroke-width='1.5'/%3E%3Ccircle cx='16' cy='16' r='2.5' fill='%23ce4710'/%3E%3Cpath d='M16 3v5M16 24v5M3 16h5M24 16h5' stroke='%23ce4710' stroke-width='1.5'/%3E%3C/svg%3E",
  },
};

export const viewport: Viewport = {
  themeColor: "#fbf4ee",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${jakarta.variable} ${jetbrains.variable} antialiased bg-background text-foreground`}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
