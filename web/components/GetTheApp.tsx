"use client";

/**
 * Where an administrator ends up, and comes back to: how to connect the app.
 *
 * The pairing method as it is today — this server's address and a password
 * sign-in — and the app itself, for either platform. The download links come
 * from the latest GitHub release, asked for when the page opens, so the page
 * never carries a version number that goes stale.
 */
import { useEffect, useState } from "react";
import { useMe } from "@/src/api/generated/auth/auth";
import { Card, CardHead } from "@/components/ui/Card";
import { Copyable } from "@/components/ui/Copy";

const RELEASES = "https://github.com/firetower-cloud/firetower/releases";

type Downloads = { mac?: string; windows?: string; version?: string };

/** The latest release's installers, by file name. Nothing to show while it is unknown. */
function useDownloads(): Downloads {
  const [found, setFound] = useState<Downloads>({});
  useEffect(() => {
    let live = true;
    fetch("https://api.github.com/repos/firetower-cloud/firetower/releases?per_page=20")
      .then((r) => (r.ok ? r.json() : []))
      .then((releases: { tag_name: string; assets: { name: string; browser_download_url: string }[] }[]) => {
        if (!live) return;
        const desktop = releases.find((r) => r.tag_name.startsWith("desktop-v"));
        if (!desktop) return;
        const by = (test: (n: string) => boolean) => desktop.assets.find((a) => test(a.name))?.browser_download_url;
        setFound({
          version: desktop.tag_name.replace(/^desktop-v/, ""),
          mac: by((n) => n.endsWith(".dmg")),
          windows: by((n) => n.endsWith("-setup.exe")) ?? by((n) => n.endsWith(".exe")),
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return found;
}

export function GetTheApp() {
  const { data: me } = useMe();
  const downloads = useDownloads();
  const address = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <div className="mx-auto max-w-[640px] px-6 py-8">
      <h1 className="text-display text-bone">Get the app</h1>
      <p className="mt-2 text-ui text-dim">
        Firetower is used from the desktop app. This page is how it finds this server.
      </p>

      <Card className="mt-7">
        <CardHead><span className="text-ui text-bone">Connect the app to this server</span></CardHead>
        <div className="px-4 py-4">
          <p className="text-ui text-dim">
            In the app, choose <span className="text-text">Connect to a Firetower</span>, paste the address, and sign in as{" "}
            <span className="font-mono text-text">{me?.user.username ?? "…"}</span> with your password.
          </p>
          <div className="mt-3">
            <Copyable text={address}>{address}</Copyable>
          </div>
        </div>
      </Card>

      <Card className="mt-4">
        <CardHead note={<span className="text-meta text-mute">{downloads.version ? `Latest: ${downloads.version}` : "The latest release"}</span>}><span className="text-ui text-bone">Download</span></CardHead>
        <div className="flex flex-wrap gap-3 px-4 pt-4 pb-3">
          <Platform name="macOS" hint="Apple silicon and Intel" href={downloads.mac} glyph={<AppleGlyph />} />
          <Platform name="Windows" hint="64-bit, installs per user" href={downloads.windows} glyph={<WindowsGlyph />} />
        </div>
        <p className="px-4 pb-4 text-meta text-mute">
          Every release, with its notes, is on <a className="text-dim underline decoration-line underline-offset-2" href={RELEASES} target="_blank" rel="noreferrer">GitHub</a>.
        </p>
      </Card>
    </div>
  );
}

function Platform({ name, hint, href, glyph }: { name: string; hint: string; href?: string; glyph: React.ReactNode }) {
  const inner = (
    <>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-raise text-bone">{glyph}</span>
      <span className="min-w-0">
        <span className="block text-ui text-bone">{name}</span>
        <span className="block text-meta text-mute">{href ? hint : "Looking for the latest release…"}</span>
      </span>
    </>
  );
  const className = "flex min-w-[15rem] flex-1 items-center gap-3 rounded-lg border border-line bg-panel px-3 py-3 text-left transition-colors";
  return href ? (
    <a href={href} className={`${className} hover:border-mute hover:bg-raise`}>{inner}</a>
  ) : (
    <span className={`${className} opacity-60`}>{inner}</span>
  );
}

/** The platform marks. Fixed shapes, filled, like the brand marks in `ui/Brand`. */
function AppleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M16.37 12.68c-.02-2.3 1.88-3.4 1.96-3.45-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.83-.81-3-.79-1.55.02-2.97.9-3.77 2.28-1.61 2.79-.41 6.92 1.16 9.18.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.39 0 1.78.74 3 .72 1.24-.02 2.02-1.12 2.78-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.4-.92-2.41-3.72zM14.1 5.94c.63-.77 1.06-1.83.94-2.89-.91.04-2.01.61-2.66 1.37-.58.67-1.1 1.76-.96 2.8 1.01.08 2.05-.52 2.68-1.28z" />
    </svg>
  );
}
function WindowsGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 5.5l7.5-1v7H3v-6zm0 13l7.5 1v-7H3v6zm8.5 1.1L21 21v-8.5h-9.5v7.1zm0-15.2v7.1H21V3l-9.5 1.4z" />
    </svg>
  );
}
