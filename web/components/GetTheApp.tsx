"use client";

/**
 * Where an administrator ends up, and comes back to: how to connect the app.
 *
 * The pairing method as it is today — this server's address and a password
 * sign-in — and the app itself, for either desk platform and for the phone.
 * The download links come from the latest GitHub release, asked for when the
 * page opens, so the page never carries a version number that goes stale.
 */
import { useEffect, useState } from "react";
import { useMe } from "@/src/api/generated/auth/auth";
import { Card, CardHead } from "@/components/ui/Card";
import { Copyable, CopyButton } from "@/components/ui/Copy";
import { QrCode } from "@/components/ui/QrCode";

const RELEASES = "https://github.com/firetower-cloud/firetower/releases";

/**
 * The public TestFlight link, which is a constant.
 *
 * Apple's invitation link belongs to the app, not to a build: a new TestFlight
 * submission appears behind the same URL. So unlike the Android APK below,
 * this one is written down.
 */
const TESTFLIGHT = "https://testflight.apple.com/join/uhgjMk1y";

type Downloads = {
  mac?: string;
  windows?: string;
  version?: string;
  android?: string;
  androidVersion?: string;
};

/** The latest release's installers, by file name. Nothing to show while it is unknown. */
function useDownloads(): Downloads {
  const [found, setFound] = useState<Downloads>({});
  useEffect(() => {
    let live = true;
    fetch("https://api.github.com/repos/firetower-cloud/firetower/releases?per_page=30")
      .then((r) => (r.ok ? r.json() : []))
      .then((releases: { tag_name: string; assets: { name: string; browser_download_url: string }[] }[]) => {
        if (!live) return;
        const desktop = releases.find((r) => r.tag_name.startsWith("desktop-v"));
        const by = (of: typeof desktop, test: (n: string) => boolean) =>
          of?.assets.find((a) => test(a.name))?.browser_download_url;

        // The phone is asked for the newest `mobile-v*` release that actually
        // carries an APK, not simply the newest one: a release whose Android
        // job failed, or which was cut before there was an APK at all, would
        // otherwise leave the code pointing at nothing. Resolving it here is
        // also why there is no version written into this file — GitHub has no
        // "latest" that means the latest *phone* release (its own `/latest`
        // is whichever component was tagged last, usually the control plane)
        // and the asset carries its version in its name, so the only link
        // that stays correct across releases is the one looked up on load.
        const apk = releases
          .filter((r) => r.tag_name.startsWith("mobile-v"))
          .map((r) => ({ tag: r.tag_name, url: by(r, (n) => n.endsWith(".apk")) }))
          .find((r) => r.url);

        setFound({
          version: desktop?.tag_name.replace(/^desktop-v/, ""),
          mac: by(desktop, (n) => n.endsWith(".dmg")),
          windows: by(desktop, (n) => n.endsWith("-setup.exe")) ?? by(desktop, (n) => n.endsWith(".exe")),
          android: apk?.url,
          androidVersion: apk?.tag.replace(/^mobile-v/, ""),
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
        Firetower is used from the desktop app, and from the phone when you are away from it. This page
        is how they find this server.
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

      {/* The phone is the one client that cannot be installed from this page by
          clicking: the link is on this screen and the device that needs it is
          another device. So the code is the control, and the link beside it is
          for anybody who would rather mail it to themselves. */}
      <Card className="mt-4">
        <CardHead note={<span className="text-meta text-mute">Both are betas, and neither is on a store yet.</span>}><span className="text-ui text-bone">On your phone</span></CardHead>
        <div className="flex flex-wrap gap-3 px-4 pt-4 pb-4">
          <Phone
            name="iPhone"
            hint="TestFlight"
            href={TESTFLIGHT}
            shown="testflight.apple.com/join/…"
            glyph={<AppleGlyph />}
          />
          <Phone
            name="Android"
            hint={downloads.androidVersion ? `APK · ${downloads.androidVersion}` : "APK"}
            href={downloads.android}
            shown={downloads.android?.split("/").pop()}
            glyph={<AndroidGlyph />}
          />
        </div>
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

/**
 * One phone platform: the code, what it is, and the link as text.
 *
 * The code sits above the name rather than beside it, because scanning is the
 * whole point of the tile and the name is the caption for it.
 */
function Phone({
  name,
  hint,
  href,
  shown,
  glyph,
}: {
  name: string;
  hint: string;
  /** Absent while the release is still being looked up. */
  href?: string;
  shown?: string;
  glyph: React.ReactNode;
}) {
  return (
    <div className="flex min-w-[15rem] flex-1 flex-col items-center gap-3 rounded-lg border border-line bg-panel px-3 py-4">
      {href ? (
        <QrCode value={href} label={`${name}: ${href}`} size={176} />
      ) : (
        // Same footprint, so the card does not jump when the release resolves.
        <span className="grid h-[176px] w-[176px] place-items-center rounded-lg border border-line-soft bg-raise px-4 text-center text-meta text-mute">
          Looking for the latest release…
        </span>
      )}

      {/* Also a link, because this page is itself reachable from a phone — and
          nobody can scan the screen they are holding. */}
      <Row as={href ? "a" : "span"} href={href} glyph={glyph} name={name} hint={hint} />

      <div className="flex w-full items-center gap-1 rounded-md border border-line-soft bg-raise py-1 pr-1 pl-2">
        <span className="min-w-0 flex-1 truncate font-mono text-meta text-dim" title={href}>
          {shown ?? "—"}
        </span>
        {href && <CopyButton text={href} label="Copy link" className="bg-raise" />}
      </div>
    </div>
  );
}

/** The caption under a code: what it installs, and where from. */
function Row({
  as: As,
  href,
  glyph,
  name,
  hint,
}: {
  as: "a" | "span";
  href?: string;
  glyph: React.ReactNode;
  name: string;
  hint: string;
}) {
  return (
    <As
      href={href}
      target={As === "a" ? "_blank" : undefined}
      rel={As === "a" ? "noreferrer" : undefined}
      className="group flex w-full items-center gap-3"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-raise text-bone">{glyph}</span>
      <span className="min-w-0">
        <span className="block text-ui text-bone group-hover:underline group-hover:decoration-line group-hover:underline-offset-2">
          {name}
        </span>
        <span className="block text-meta text-mute">{hint}</span>
      </span>
    </As>
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
function AndroidGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6.6 3.3l.9 1.6A6.9 6.9 0 0 1 12 4.1c1.7 0 3.2.5 4.5 1.3l.9-1.6a.4.4 0 1 1 .7.4l-.9 1.6A6.5 6.5 0 0 1 20.7 11H3.3a6.5 6.5 0 0 1 3.5-5.3l-.9-1.6a.4.4 0 1 1 .7-.4zM8.6 8.2a.8.8 0 1 0 0-1.6.8.8 0 0 0 0 1.6zm6.8 0a.8.8 0 1 0 0-1.6.8.8 0 0 0 0 1.6zM3.4 12h17.2v6.3c0 .7-.6 1.3-1.3 1.3h-1.1v2a1.2 1.2 0 0 1-2.4 0v-2h-7.6v2a1.2 1.2 0 0 1-2.4 0v-2H4.7c-.7 0-1.3-.6-1.3-1.3V12zM1.9 12.2a1.2 1.2 0 0 1 1.2 1.2v3.9a1.2 1.2 0 0 1-2.4 0v-3.9c0-.7.5-1.2 1.2-1.2zm20.2 0a1.2 1.2 0 0 1 1.2 1.2v3.9a1.2 1.2 0 0 1-2.4 0v-3.9c0-.7.5-1.2 1.2-1.2z" />
    </svg>
  );
}
