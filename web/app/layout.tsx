import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Shell } from "@/components/Shell";
import { ApiProvider } from "@/src/api/provider";

/**
 * Fonts are checked in under `public/fonts` rather than fetched at build time.
 *
 * Firetower is meant to be cloned and built by whoever runs it — sometimes
 * offline, sometimes behind a proxy that doesn't reach a font CDN. A build that
 * needs the network to render text is a build that fails for reasons that have
 * nothing to do with the change being made.
 *
 * These are variable fonts, so one file covers the whole weight range.
 */
const archivo = localFont({
  src: "../public/fonts/archivo.woff2",
  variable: "--font-archivo",
  weight: "100 900",
  display: "swap",
});

const archivoNarrow = localFont({
  src: "../public/fonts/archivo-narrow.woff2",
  variable: "--font-archivo-narrow",
  weight: "100 900",
  display: "swap",
});

const jetbrains = localFont({
  src: "../public/fonts/jetbrains-mono.woff2",
  variable: "--font-jetbrains",
  weight: "100 800",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Firetower",
  description: "Run any coding agent, on your own servers, from anywhere.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${archivo.variable} ${archivoNarrow.variable} ${jetbrains.variable}`}>
        <ApiProvider>
          <Shell>{children}</Shell>
        </ApiProvider>
      </body>
    </html>
  );
}
