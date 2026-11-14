"use client";

/**
 * Where an administrator ends up, and comes back to: how to connect the app.
 *
 * The pairing method as it is today — this server's address and a password
 * sign-in — and the app itself, for each of the three desk platforms and for
 * the phone. The download links come from the latest GitHub release, asked
 * for when the page opens, so the page never carries a version number that
 * goes stale.
 */
import { useEffect, useState } from "react";
import { useMe } from "@/src/api/generated/auth/auth";
import { Badge } from "@/components/ui/Badge";
import { Card, CardHead } from "@/components/ui/Card";
import { Copyable, CopyButton } from "@/components/ui/Copy";
import { QrCode } from "@/components/ui/QrCode";

const RELEASES = "https://github.com/firetower-cloud/firetower/releases";

/** What the Linux build cannot do yet, in full, for the one line that cannot hold it. */
const LINUX_DOC = "https://github.com/firetower-cloud/firetower/blob/main/docs/linux.md";

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
  linux?: string;
  version?: string;
  android?: string;
  androidVersion?: string;
  /**
   * Whether the lookup has answered — however it answered.
   *
   * Without this, *still looking*, *answered and there is no such file* and
   * *the lookup itself failed* are one state with one sentence, and the
   * sentence is the hopeful one: a release whose macOS job did not run says
   * "Looking for the latest release…" for as long as anybody is prepared to
   * sit there.
   */
  settled: boolean;
  /** False when GitHub could not be asked at all, which is not a missing file. */
  reached: boolean;
};

const LOOKING: Downloads = { settled: false, reached: true };

/** The latest release's installers, by file name. Nothing to show while it is unknown. */
function useDownloads(): Downloads {
  const [found, setFound] = useState<Downloads>(LOOKING);
  useEffect(() => {
    let live = true;
    fetch("https://api.github.com/repos/firetower-cloud/firetower/releases?per_page=30")
      // A refusal is a failed lookup and not an empty release list — the
      // common one is this unauthenticated request being rate-limited, and
      // answering it with `[]` would put "Not in this release" under all
      // three platforms, which is a different and untrue thing to say.
      .then((r) => {
        if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
        return r.json();
      })
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
          settled: true,
          reached: true,
          version: desktop?.tag_name.replace(/^desktop-v/, ""),
          mac: by(desktop, (n) => n.endsWith(".dmg")),
          windows: by(desktop, (n) => n.endsWith("-setup.exe")) ?? by(desktop, (n) => n.endsWith(".exe")),
          // One Linux download, and it is the one that can update itself.
          linux: by(desktop, (n) => n.endsWith(".AppImage")),
          android: apk?.url,
          androidVersion: apk?.tag.replace(/^mobile-v/, ""),
        });
      })
      .catch(() => {
        if (live) setFound({ settled: true, reached: false });
      });
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
          <Platform name="macOS" hint="Apple silicon and Intel" href={downloads.mac} glyph={<AppleGlyph />} settled={downloads.settled} reached={downloads.reached} />
          <Platform name="Windows" hint="64-bit, installs per user" href={downloads.windows} glyph={<WindowsGlyph />} settled={downloads.settled} reached={downloads.reached} />
          {/* The third tile, the same shape as the other two. The tier is a
              tag on it rather than a different kind of tile: one download, one
              press, and the block below carries everything that is particular
              about it. */}
          <Platform name="Linux" hint="AppImage, x86_64" href={downloads.linux} glyph={<TuxGlyph />} tag="Experimental" settled={downloads.settled} reached={downloads.reached} />
        </div>

        {/* Drawn while the lookup is still out, because it is true whatever
            the lookup returns and the card should not grow when the links
            arrive. Gone once we know there is no AppImage: it is advice about
            a file you cannot get from here. */}
        {(!downloads.settled || downloads.linux) && <OnLinux />}

        {/* A dropped connection is not a release with nothing in it, and it is
            not Linux's fault — said once, under the tiles, with the link to
            every release already below it. */}
        {!downloads.reached && <p className="px-4 pb-3 text-meta text-mute">Couldn&apos;t reach GitHub.</p>}

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

/**
 * One desk platform: a link, a mark, a name, one line under it.
 *
 * **The line is where the three states are told apart.** A tile with no link
 * used to say "Looking for the latest release…" whether the lookup was still
 * out or had come back with nothing, so a release whose macOS job never ran
 * appeared to be loading for ever. Now: dimmed and still looking, or full
 * opacity and *answered*, which is a different sentence. The footprint is the
 * same in all three, so the card does not jump when the release resolves.
 *
 * The one state with nothing of its own to say is a lookup that failed — the
 * tile keeps describing its platform, and the card says once, underneath,
 * that GitHub could not be reached. "Not in this release" is a claim about a
 * release we were never told anything about.
 */
export function tileLine({
  hint,
  href,
  settled,
  reached,
}: {
  hint: string;
  href?: string;
  settled: boolean;
  reached: boolean;
}): string {
  if (href) return hint;
  if (!settled) return "Looking for the latest release…";
  // Answered, and there is no such file in it.
  if (reached) return "Not in this release";
  // Nobody answered, so nothing is known about what the release holds: the
  // tile goes on describing its platform and the card says once, underneath,
  // that GitHub could not be reached.
  return hint;
}

function Platform({
  name,
  hint,
  href,
  glyph,
  tag,
  settled,
  reached,
}: {
  name: string;
  hint: string;
  href?: string;
  glyph: React.ReactNode;
  /** The tier, for a platform that is not held to the same promise as the others. */
  tag?: string;
  settled: boolean;
  reached: boolean;
}) {
  const line = tileLine({ hint, href, settled, reached });
  const inner = (
    <>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-raise text-bone">{glyph}</span>
      <span className="min-w-0">
        {tag ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-ui text-bone">{name}</span>
            <Badge tone="slate">{tag}</Badge>
          </span>
        ) : (
          <span className="block text-ui text-bone">{name}</span>
        )}
        <span className="block text-meta text-mute">{line}</span>
      </span>
    </>
  );
  const className = "flex min-w-[15rem] flex-1 items-center gap-3 rounded-lg border border-line bg-panel px-3 py-3 text-left transition-colors";
  return href ? (
    <a href={href} className={`${className} hover:border-mute hover:bg-raise`}>{inner}</a>
  ) : (
    <span className={`${className} ${settled ? "" : "opacity-60"}`}>{inner}</span>
  );
}

/**
 * The one thing on this card that is not a download.
 *
 * Always there, nothing to open: the gaps used to live at the foot of a tile
 * that expanded, and a tile that expands is one most people never press. It
 * costs about a hundred pixels on every reader of this page, including the
 * two thirds of them who are on something else — which is why the label names
 * the audience, so they can skip it in one glance, and why it is *On Linux*
 * rather than *Known gaps*: the first line is advice rather than a defect.
 *
 * Where to keep the file comes first, because it changes what somebody does in
 * the next minute. The gaps follow, because they change whether they install
 * at all.
 */
function OnLinux() {
  return (
    <div className="px-4 pb-3">
      <div className="rounded-md border border-line-soft bg-raise px-3 py-2.5">
        <div className="eyebrow">On Linux</div>
        <p className="mt-1 text-meta text-dim">
          Keep the AppImage somewhere you can write to: it updates itself by replacing that file.
        </p>
        <p className="mt-1.5 text-meta text-dim">
          No tray icon, no dock badge, and no poster images on artifacts. WebKit&apos;s sandbox is off, as it is in
          every Tauri app on Linux.{" "}
          <a className="text-text underline decoration-line underline-offset-2" href={LINUX_DOC} target="_blank" rel="noreferrer">
            The rest is written down.
          </a>
        </p>
      </div>
    </div>
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
/**
 * Tux, drawn for this size rather than scaled down to it.
 *
 * Both of the marks you would otherwise paste in — Simple Icons' and Font
 * Awesome's — are outline drawings that turn to mush at 18px, and the first
 * sketch of this one was a single blob that read as an egg. So: one closed
 * silhouette with the head, the body and two feet in it, and the eyes and the
 * beak as holes, which is the same idiom as the two marks beside it. 20px
 * rather than their 18 and 16, because it is the narrowest of the three and
 * needs the extra to carry the same weight.
 */
function TuxGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden>
      <path d="M12 1.9c2.6 0 4.4 2 4.4 4.6 0 1.1-.35 2-.85 2.65 2.25 1.55 3.25 4.05 3.25 6.75 0 2-.6 3.75-1.7 4.95 1.15.35 2.1.85 2.1 1.5 0 .75-1.2 1-2.4 1-1.35 0-2.7-.4-3.5-1-.45.1-.9.15-1.3.15s-.85-.05-1.3-.15c-.8.6-2.15 1-3.5 1-1.2 0-2.4-.25-2.4-1 0-.65.95-1.15 2.1-1.5-1.1-1.2-1.7-2.95-1.7-4.95 0-2.7 1-5.2 3.25-6.75-.5-.65-.85-1.55-.85-2.65C7.6 3.9 9.4 1.9 12 1.9zM10.45 4.55a1.25 1.55 0 0 0 0 3.1 1.25 1.55 0 0 0 0-3.1zM13.55 4.55a1.25 1.55 0 0 0 0 3.1 1.25 1.55 0 0 0 0-3.1zM12 7.9l1.3 1-1.3 1.1-1.3-1.1z" />
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
