import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";

import { AppShell } from "@/components/AppShell";

import "./globals.css";

const display = Instrument_Serif({
  weight: "400",
  style: "normal",
  subsets: ["latin"],
  variable: "--font-display-face",
});

const ui = Geist({
  subsets: ["latin"],
  variable: "--font-ui-face",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono-face",
});

export const metadata: Metadata = {
  title: "PolishedTake",
  description: "Raw footage and a one-line brief in. A self-correcting cut out.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable} ${mono.variable}`}>
      <body className="bg-background text-foreground">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
