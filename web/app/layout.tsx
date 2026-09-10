import type { Metadata, Viewport } from "next";
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

/**
 * How the page meets the device it is on.
 *
 * There was none of this, so the page took the default and a phone could
 * pinch the workbench to 1.4× and leave the composer off the right edge.
 *
 * `maximumScale` and `userScalable` are the half of that fix browsers agree
 * on; Safari has ignored them for pinch since iOS 10, on accessibility
 * grounds, which is why there is a `.no-zoom` rule and a `useNoZoom` hook as
 * well and why the two of them are scoped to the workbench rather than
 * applied here. What this *does* buy on every browser is the other half of
 * the complaint: a field under 16px no longer zooms the page when it takes
 * focus.
 *
 * `viewportFit: "cover"` draws under the notch and the home indicator, which
 * is only correct because everything resting on the floor pads itself with
 * `env(safe-area-inset-bottom)` — see `.safe-bottom`.
 *
 * `interactiveWidget: "resizes-content"` makes the soft keyboard shrink the
 * viewport rather than slide over it, so `h-dvh` is the room actually left
 * and the composer rides up without a line of JavaScript measuring anything.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
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
