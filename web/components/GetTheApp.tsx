"use client";

/**
 * Where an administrator ends up, and comes back to: how to connect the app.
 *
 * The pairing method as it is today — this server's address and a password
 * sign-in — and the app itself, for each of the three desk platforms and for
 * the phone.
 *
 * **The desk downloads are the general-access build**, which is a pin and not
 * a date: the version a maintainer promoted, named by the channel manifest and
 * read from it by this control plane (`generalPin`). The bundles are then
 * fetched from the release that pin names, **by its own tag** — nothing here
 * finds the general-access build by scanning the releases feed. General access
 * can lag beta by more than one page of releases, and reading a pin by
 * enumerating releases is the failure the manifest exists to prevent (#454,
 * specification §05).
 *
 * And, under the downloads, the one route onto the beta channel for a copy
 * that cannot reach it any other way — see `BetaRoute`. Downloading the app is
 * this surface's job (`docs/which-surface.md`), which is why that route lives
 * here and not on the desktop client's Updates screen. That block reads the
 * newest desktop release, which is what a beta is, and is the only thing on
 * this card that still comes from the feed.
 */
import { useEffect, useState } from "react";
import { useMe } from "@/src/api/generated/auth/auth";
import { useGetChannel } from "@/src/api/generated/updates/updates";
import type { ManifestView } from "@/src/api/generated/model";
import { Badge } from "@/components/ui/Badge";
import { Card, CardHead } from "@/components/ui/Card";
import { Copyable, CopyButton } from "@/components/ui/Copy";
import { QrCode } from "@/components/ui/QrCode";

const RELEASES = "https://github.com/firetower-cloud/firetower/releases";

/** Every release, newest first. The beta build and the phone's APK are in here. */
const FEED = "https://api.github.com/repos/firetower-cloud/firetower/releases?per_page=30";

/** One release, by the tag naming it. How a pin is turned into bundles. */
const BY_TAG = "https://api.github.com/repos/firetower-cloud/firetower/releases/tags/";

/** What the Linux build cannot do yet, in full, for the one line that cannot hold it. */
const LINUX_DOC = "https://github.com/firetower-cloud/firetower/blob/main/docs/linux.md";

/** The key, the command, and what each platform does on its own. Too long for a card. */
const VERIFY_DOC =
  "https://github.com/firetower-cloud/firetower/blob/main/docs/verifying-a-download.md";

/**
 * The public TestFlight link, which is a constant.
 *
 * Apple's invitation link belongs to the app, not to a build: a new TestFlight
 * submission appears behind the same URL. So unlike the Android APK below,
 * this one is written down.
 */
const TESTFLIGHT = "https://testflight.apple.com/join/uhgjMk1y";

/**
 * What the page knows about the version general access is pinned to.
 *
 * Three states and no fourth: a version to offer, a reason there is none, or
 * the lookup still out. **No state falls through to the newest release.**
 * That fallback is the defect this exists to close — from the first release
 * deliberately left unpromoted the newest desktop release is a *beta*, and
 * this card is the one surface whose whole job is handing somebody a build to
 * install.
 */
export type Pin =
  /** Still being asked. Nothing is known either way yet. */
  | { state: "looking" }
  /**
   * A version to offer. `behind` is set when the most recent read of the
   * manifest did not succeed and this is the pin from the last one that did —
   * a general-access version that may be stale, which is a different thing
   * from a beta, and is said out loud rather than quietly served.
   */
  | { state: "pinned"; version: string; behind?: string; detail?: string }
  /** No version to offer, and why — which is never "so here is the newest". */
  | { state: "none"; why: string; detail?: string };

/**
 * The general-access pin, as this page comes to have it.
 *
 * **The control plane reads the manifest, not this page**, and that is not a
 * preference. A release asset cannot be fetched from a browser at all:
 * `github.com/…/releases/download/…` redirects to
 * `release-assets.githubusercontent.com`, which answers with no
 * `access-control-allow-origin` on either hop, so the document is unreadable
 * from here however the request is phrased — measured on both hops rather
 * than assumed (#454).
 *
 * Reading it server-side is the better path anyway, and costs nothing in
 * version skew: the console is a static export compiled into the control
 * plane's binary, so this page and the endpoint it calls ship as one
 * artefact. `updates/channel.rs` bounds the document's size, bounds how long
 * the read may take, and keeps a durable record of having read one before —
 * which is what makes a later absence a *destroyed* manifest rather than a
 * fresh start, and is the one thing a browser could not honestly keep.
 *
 * So this is a reading of that read's six outcomes, and only `found` hands
 * over a version — or a document that read before and is still held, which
 * `behind` then marks as possibly stale.
 */
export function generalPin({
  pending,
  failed,
  manifest,
}: {
  /** This server has not answered yet. */
  pending: boolean;
  /** This server could not be asked at all. */
  failed: boolean;
  manifest?: ManifestView;
}): Pin {
  if (pending) return { state: "looking" };
  // A server that did not answer has said nothing about the manifest, which
  // is not the same as a manifest that is not there.
  if (failed || !manifest)
    return {
      state: "none",
      why: "this server could not be asked which version general access is at.",
    };
  const desktop = manifest.packages.find((p) => p.package === "desktop");
  if (!desktop?.general)
    return { state: "none", why: whyNoPin(manifest), detail: manifest.problem ?? undefined };
  return manifest.outcome === "found"
    ? { state: "pinned", version: desktop.general }
    : {
        state: "pinned",
        version: desktop.general,
        behind: whyNoPin(manifest),
        detail: manifest.problem ?? undefined,
      };
}

/**
 * Why there is no pin, in a sentence that says what to do about it.
 *
 * **The six outcomes are kept apart here because the operator's next action
 * differs** — which is the whole reason the control plane keeps them apart:
 * ask again after a failed fetch, republish a destroyed document, fix a
 * malformed one, wait for a promotion that has not happened. Collapsing them
 * into one "could not check" is the mistake this design has already paid for,
 * and `vanished` is the one that gets worse while nobody acts on it, so it
 * must never read as a network hiccup.
 */
function whyNoPin(manifest: ManifestView): string {
  switch (manifest.outcome) {
    case "absent":
      return "no channel manifest has been published yet, so nothing has been promoted to general access.";
    case "vanished":
      return "the channel manifest was published before and is gone now. It has been destroyed rather than never written, and somebody has to put it back — this one does not come right on its own.";
    case "unreadable":
      return "this server could not read the channel manifest just now, which is worth asking again.";
    case "malformed":
      return "what came back from the channel manifest is not that document, so it has to be fixed before anything here can name a version.";
    case "incomplete":
      return "the channel manifest is missing a version it has to carry, so it has to be fixed before anything here can name one.";
    case "found":
      // It read, and says nothing about this package — a document written
      // before the desktop had a channel, or before its first promotion.
      return "the channel manifest names no general-access version for the desktop app yet.";
  }
}

/** What the feed answers: the beta build, and the phone's APK. */
type Releases = {
  /**
   * False when GitHub could not be asked at all, which is not an empty feed.
   *
   * There is no *settled* beside it, as there is on `Build`: nothing on this
   * side of the card distinguishes a lookup still out from one that failed.
   * The beta route says "could not be looked up just now" in both, which is
   * true of both, and the phone's code keeps its own placeholder.
   */
  reached: boolean;
  /**
   * The newest desktop release, which **is** the beta build: every released
   * version reaches beta as it is cut and nothing holds one back. So this
   * stays correct however far beta runs ahead of general access — which is
   * exactly what the pin above it will not do, and why they are two lookups.
   */
  beta?: { version: string; href: string; mac?: string; windows?: string; linux?: string };
  android?: string;
  androidVersion?: string;
};

const ASKING: Releases = { reached: true };

/** As much of a GitHub release as this page reads. */
type Release = {
  tag_name: string;
  html_url: string;
  assets: { name: string; browser_download_url: string }[];
};

/** The installers on one release, by file name. */
function bundles(of: Release | undefined) {
  const by = (test: (n: string) => boolean) =>
    of?.assets.find((a) => test(a.name))?.browser_download_url;
  return {
    mac: by((n) => n.endsWith(".dmg")),
    windows: by((n) => n.endsWith("-setup.exe")) ?? by((n) => n.endsWith(".exe")),
    // One Linux download, and it is the one that can update itself.
    linux: by((n) => n.endsWith(".AppImage")),
  };
}

/**
 * The newest releases: the beta desktop build, and the phone's APK.
 *
 * The one lookup on this page that is a scan, and the right shape for what it
 * answers — *the newest release* is precisely the question being asked here.
 * The general-access build is a pin, and is never found this way.
 */
function useReleases(): Releases {
  const [found, setFound] = useState<Releases>(ASKING);
  useEffect(() => {
    let live = true;
    fetch(FEED)
      // A refusal is a failed lookup and not an empty release list — the
      // common one is this unauthenticated request being rate-limited, and
      // answering it with `[]` would put "Not in this release" under all
      // three platforms, which is a different and untrue thing to say.
      .then((r) => {
        if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
        return r.json();
      })
      .then((releases: Release[]) => {
        if (!live) return;
        const desktop = releases.find((r) => r.tag_name.startsWith("desktop-v"));

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
          .map((r) => ({
            tag: r.tag_name,
            url: r.assets.find((a) => a.name.endsWith(".apk"))?.browser_download_url,
          }))
          .find((r) => r.url);

        setFound({
          reached: true,
          beta: desktop && {
            version: desktop.tag_name.replace(/^desktop-v/, ""),
            // The page GitHub already has for this release, rather than a tag
            // URL assembled here: one less shape of ours to keep in step with
            // theirs, and it is where the bundles are.
            href: desktop.html_url,
            ...bundles(desktop),
          },
          android: apk?.url,
          androidVersion: apk?.tag.replace(/^mobile-v/, ""),
        });
      })
      .catch(() => {
        if (live) setFound({ reached: false });
      });
    return () => {
      live = false;
    };
  }, []);
  return found;
}

/** The bundles the general-access pin resolves to. */
export type Build = {
  /** Whether the lookup has answered, including by not needing to be made. */
  settled: boolean;
  /** Whether a release was actually read. A 404 and a refusal are both false. */
  read: boolean;
  /** Which of those two it was, when a lookup was made and read nothing. */
  missing?: "gone" | "unreachable";
  mac?: string;
  windows?: string;
  linux?: string;
};

const NOTHING_TO_LOOK_UP: Build = { settled: true, read: false };
const LOOKING_UP: Build = { settled: false, read: false };

/**
 * The release a pin names, fetched **by its tag** rather than found in a feed.
 *
 * `releases/tags/desktop-v<pin>` is the lookup of a value. Searching the feed
 * for it would work today and stop working the day general access falls more
 * than a page of releases behind beta — which is normal rather than
 * exceptional, because promotion skips versions as a matter of course. It
 * costs one more of GitHub's sixty unauthenticated requests an hour, and that
 * is what a pin being a value rather than a guess costs.
 */
function useGeneralBuild(version?: string): Build {
  // The answer, and the pin it is the answer *to*. Keeping the two together
  // is what lets a pin that has just changed read as "still looking" without
  // the effect setting state to say so, and it means an answer about an older
  // pin can never be drawn against a newer one.
  const [answered, setAnswered] = useState<{ pin?: string; build: Build }>({
    build: NOTHING_TO_LOOK_UP,
  });
  useEffect(() => {
    if (!version) return;
    let live = true;
    fetch(`${BY_TAG}desktop-v${encodeURIComponent(version)}`)
      .then((r) => {
        // A pin naming a release that is not on GitHub is an answer, not a
        // refusal, and the card says which version it went looking for.
        if (r.status === 404) return undefined;
        if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
        return r.json() as Promise<Release>;
      })
      .then((release) => {
        if (!live) return;
        setAnswered({
          pin: version,
          build: release
            ? { settled: true, read: true, ...bundles(release) }
            : { settled: true, read: false, missing: "gone" },
        });
      })
      .catch(() => {
        if (live)
          setAnswered({ pin: version, build: { settled: true, read: false, missing: "unreachable" } });
      });
    return () => {
      live = false;
    };
  }, [version]);
  if (!version) return NOTHING_TO_LOOK_UP;
  return answered.pin === version ? answered.build : LOOKING_UP;
}

export function GetTheApp() {
  const { data: me } = useMe();
  const releases = useReleases();
  // This server's own read of the channel manifest. One ask, cached by the
  // query client, and the only place the general-access version comes from.
  const channel = useGetChannel();
  const pin = generalPin({
    pending: channel.isPending,
    failed: channel.isError,
    manifest: channel.data?.manifest,
  });
  const build = useGeneralBuild(pin.state === "pinned" ? pin.version : undefined);
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

      <DownloadCard pin={pin} build={build} releases={releases} />

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
            hint={releases.androidVersion ? `APK · ${releases.androidVersion}` : "APK"}
            href={releases.android}
            shown={releases.android?.split("/").pop()}
            glyph={<AndroidGlyph />}
          />
        </div>
      </Card>
    </div>
  );
}

/**
 * The Download card: the general-access build, and the route onto beta.
 *
 * Everything it draws is in its arguments, which is what lets every state of
 * it — pinned, pinned and stale, no pin for each of six reasons, a pin whose
 * release is not there, a refusal — be rendered and asserted on rather than
 * described. **The two versions on this card come from two different places
 * on purpose**: the tiles and the line above them from the pin, the badge
 * under *Beta builds* from the newest release. They differ from the first
 * release left unpromoted, and that is the whole point of the change.
 */
export function DownloadCard({
  pin,
  build,
  releases,
}: {
  pin: Pin;
  build: Build;
  releases: Releases;
}) {
  // Settled once both the pin and the lookup it leads to have answered: a
  // tile that said "Not in this release" while the pin was still out would be
  // a claim about a release nobody had named yet.
  const settled = pin.state !== "looking" && build.settled;
  const note = generalNote(pin, build);
  return (
    <Card className="mt-4">
      <CardHead note={<span className="text-meta text-mute">{downloadNote(pin)}</span>}><span className="text-ui text-bone">Download</span></CardHead>
      <div className="flex flex-wrap gap-3 px-4 pt-4 pb-3">
        <Platform name="macOS" hint="Apple silicon and Intel" href={build.mac} glyph={<AppleGlyph />} settled={settled} resolved={build.read} />
        <Platform name="Windows" hint="64-bit, installs per user" href={build.windows} glyph={<WindowsGlyph />} settled={settled} resolved={build.read} />
        {/* The third tile, the same shape as the other two. The tier is a
            tag on it rather than a different kind of tile: one download, one
            press, and the block below carries everything that is particular
            about it. */}
        <Platform name="Linux" hint="AppImage, x86_64" href={build.linux} glyph={<TuxGlyph />} tag="Experimental" settled={settled} resolved={build.read} />
      </div>

      {/* Why there is no general-access build above, or why the one there is
          may be behind. Directly under the tiles it is about, and above the
          Linux advice and the dropped-connection line — a reader looking at
          three tiles that are not links wants this sentence first. */}
      {note && <GeneralNote note={note} />}

      {showsOnLinux({ settled, resolved: build.read, linux: build.linux }) && <OnLinux />}

      {/* A dropped connection is not a release with nothing in it, and it is
          not Linux's fault — said once, under the tiles, with the link to
          every release already below it. */}
      {(!releases.reached || build.missing === "unreachable") && (
        <p className="px-4 pb-3 text-meta text-mute">Couldn&apos;t reach GitHub.</p>
      )}

      {/* Last in the card, under the tiles and the platform note that
          belongs to one of them, and directly above the other line on this
          card that points at GitHub. */}
      <BetaRoute
        found={{
          version: releases.beta?.version,
          betaRelease: releases.beta?.href,
          mac: releases.beta?.mac,
          windows: releases.beta?.windows,
          linux: releases.beta?.linux,
        }}
      />

      <p className="px-4 pb-4 text-meta text-mute">
        Every release, with its notes, is on <a className="text-dim underline decoration-line underline-offset-2" href={RELEASES} target="_blank" rel="noreferrer">GitHub</a>.
      </p>
    </Card>
  );
}

/** What the card has to say about the general-access build, if anything. */
export type Note = {
  /** What is wrong, and what would put it right. */
  says: string;
  /** Said only where there is nothing to download, because it is the thing somebody would otherwise assume. */
  next?: string;
  /** This server's own words for the failure, for whoever has to act on it. */
  detail?: string;
};

/**
 * The line under the tiles that says why they are empty, or stale.
 *
 * The page used to need no such line, because the version it drew was the
 * newest release and the newest release is always there. A pin can be
 * unreadable, missing, destroyed, or name a release that is not on the host —
 * and in every one of those the honest card offers **nothing** and says which
 * it is. Falling back to the newest release is the one thing it must never
 * do: that is a beta, and handing it out under a general-access label is the
 * failure this whole design avoids everywhere else.
 */
export function generalNote(pin: Pin, build: Build): Note | undefined {
  if (pin.state === "looking") return undefined;
  if (pin.state === "none")
    return {
      says: `There is no general-access build to offer here: ${pin.why}`,
      next: "The newest release is not offered in its place — a release nobody has promoted is a beta, and the route onto beta is below.",
      detail: pin.detail,
    };
  // A pin that names a release GitHub does not have. Not a refusal, and not
  // an empty release: the tiles say nothing about platforms because there is
  // no release to have platforms.
  if (build.missing === "gone")
    return {
      says: `General access is at ${pin.version}, and there is no desktop-v${pin.version} release on GitHub to download it from.`,
      next: "The newest release is not offered in its place — a release nobody has promoted is a beta, and the route onto beta is below.",
    };
  if (pin.behind)
    return {
      says: `General access was ${pin.version} when the channel manifest last read, and the most recent read did not succeed: ${pin.behind}`,
      detail: pin.detail,
    };
  return undefined;
}

/**
 * That note, drawn.
 *
 * `--text-meta` so it is an aside and `--color-text` so it is legible: these
 * sentences change what somebody does next — ask again, republish a document,
 * wait for a promotion — and `--color-dim` is recorded in the sheet at 2.94:1
 * on `--color-panel`, below the floor for normal text. The server's own words
 * for the failure are the one part that is a diagnostic rather than an
 * instruction, so that is the part drawn in the tier reserved for them.
 */
function GeneralNote({ note }: { note: Note }) {
  return (
    <div className="px-4 pb-3">
      <p className="text-meta text-text">{note.says}</p>
      {note.next && <p className="mt-1 text-meta text-text">{note.next}</p>}
      {note.detail && <p className="mt-1 text-meta text-dim">{note.detail}</p>}
    </div>
  );
}

/**
 * The version line under *Download*, which names a channel and its pin.
 *
 * It says *general access* because the block below it opens by saying the
 * downloads above are general access, and that sentence needs something above
 * it to be about. The number is the channel manifest's `desktop.general` pin,
 * read by this control plane — **not the newest desktop release**, which is
 * the same number only while the two channels are level and is a beta from
 * the first release left unpromoted.
 *
 * Three states, three lines, and the unknown one is not the hopeful one: a
 * pin that could not be read says so, and the note under the tiles says which
 * of the six reasons it was and what to do about it.
 */
export function downloadNote(pin: Pin): string {
  switch (pin.state) {
    case "pinned":
      return `General access: ${pin.version}`;
    case "looking":
      return "The general-access release";
    case "none":
      return "General access: unknown";
  }
}

/** What the beta route can honestly offer, once the release lookup has answered. */
export type BetaOffer = {
  /** The version beta is at — absent unless there is a bundle to go with it. */
  version?: string;
  href: string;
  /**
   * Why the link is the releases index rather than the beta build's own page,
   * when it is. The index is the worse answer: thirty releases across three
   * packages, and the reader has just been told to use *the release page*. So
   * it is never handed over silently — the sentence beside it says which of
   * the two reasons it is.
   */
  insteadOf?: "unknown" | "empty";
};

/** What the lookup has to turn up before the route can name a build. */
type BetaLookup = {
  version?: string;
  betaRelease?: string;
  mac?: string;
  windows?: string;
  linux?: string;
};

/**
 * Whether the route can name a build, and where its link goes.
 *
 * Two states send the reader to the releases index instead of a release page,
 * and they are not the same sentence:
 *
 * - **Nothing resolved.** Still looking, GitHub refused, or the feed carried
 *   no desktop release. The common one by far is the refusal: this feed is
 *   fetched unauthenticated from the browser and GitHub allows sixty of those
 *   an hour per address, which an admin console behind a shared address will
 *   spend without anybody doing anything unusual.
 * - **A release with nothing on it.** Every bundle upload failed, so the three
 *   tiles above already say *Not in this release* — and a confident version
 *   beside *Beta builds*, linking at an empty page, would be the only part of
 *   the card still claiming otherwise.
 *
 * In both, the version is dropped rather than shown against a download nobody
 * can get.
 */
export function betaOffer({ version, betaRelease, mac, windows, linux }: BetaLookup): BetaOffer {
  if (!version || !betaRelease) return { href: RELEASES, insteadOf: "unknown" };
  if (!mac && !windows && !linux) return { href: RELEASES, insteadOf: "empty" };
  return { version, href: betaRelease };
}

/**
 * The permanent route onto beta, which this page owns.
 *
 * Downloading the app is this surface's job (`docs/which-surface.md`), and
 * this is the only way onto beta for a copy that predates release channels or
 * stopped updating. So it is load-bearing documentation rather than a
 * footnote, and it says *why* it exists rather than only offering a file.
 *
 * **The why is scoped, and has to be.** A copy that predates all of this
 * cannot be switched from inside itself: its update address is compiled into
 * the bundle, and the only way to a different address is to install from it
 * once (#414, #415). That is not true of a copy carrying the channel release —
 * it chooses its endpoint per check, with no restart, which is what the next
 * sentence means by *a switch in the app under Updates* (spec §05, Decided).
 * Saying it of every copy made the two sentences contradict each other one
 * line apart, and made the page wrong for most of the people who will read it
 * once the channel release has been taken.
 *
 * Three more things are said, because leaving any of them out leaves a wrong
 * impression that this page is the only place to correct:
 *
 * - **What happens after.** Normal automatic updates, on that channel, from
 *   the next release on — so the hand-install is once and not a habit.
 * - **What switching back does not do.** It stops new betas. It does not
 *   reinstall the general-access build, and a copy is never moved back to an
 *   older one: a copy that took a beta is ahead of general access and waits
 *   there until general access overtakes it (#424).
 * - **That the route is permanent.** It is the same answer to a copy that
 *   stopped updating for any reason, so it is not scaffolding for this change
 *   and must not read as a migration step anybody is waiting to withdraw
 *   (#415). Nothing here is phrased as *for now*, *until*, or *while*.
 *
 * **Every sentence here is `--color-text` or brighter**, including the
 * closing one. The sheet records `--color-dim` at 2.94:1 on `--color-panel`,
 * below the floor for normal text and spent deliberately on counts,
 * timestamps and paths; `--color-mute` is fainter still. These are the
 * sentences on this page that change what somebody does next, so none of them
 * is drawn in a tier the design reserves for things nobody has to read. The
 * closing line stays an aside by being `--text-meta` and last, which is the
 * same rule `desktop/STYLE.md` applies everywhere else: a distinction is
 * carried by shape, weight or position, never by fading something out.
 *
 * Drawn in every state of the lookup, including the ones that know nothing.
 * Every sentence in it is true whatever the release turns out to hold, and the
 * link has somewhere to go either way — the same argument `showsOnLinux` makes
 * one block above.
 */
export function BetaRoute({ found }: { found: BetaLookup }) {
  const offer = betaOffer(found);
  return (
    <div className="px-4 pt-0.5 pb-3.5">
      {/* A rule and the card's own ground, not a shape of its own. This is the
          last section of the Download card and it is not a warning: no tint,
          no tone, nothing that answers *is something waiting on you*. It is
          told apart by position and by the weight of its heading. */}
      <div className="border-t border-line pt-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui text-bone">Beta builds</span>
          {/* The version beta is at, which is the newest release by
              construction — every released version reaches beta as it is cut.
              Correct however far ahead of general access beta runs, and
              withheld when there is no bundle behind it. */}
          {offer.version && <Badge>{offer.version}</Badge>}
        </div>
        <p className="mt-2 text-ui text-text">
          The downloads above are general access: the releases a maintainer has promoted. Beta has
          every release as soon as it is cut.
        </p>
        <p className="mt-2 text-ui text-text">
          A copy that predates all of this cannot be switched from inside itself: its update address
          is compiled into the bundle, and the only way to a different address is to install from it
          once. So joining beta on one is one download from the release page, for the copy you are
          joining. From the next release on, that copy updates on beta by itself, and its channel is
          a switch in the app under Updates.
        </p>
        <p className="mt-2 text-ui text-text">
          Switching back in the app stops new betas. It does not reinstall the general-access build,
          and a copy is never moved back to an older one.
        </p>

        <CheckingIt />

        {/* The closing line earns its quietness from being smaller and last,
            not from being too faint to read: `--text-meta` at `--color-text`
            is an aside that clears the floor, where `--color-mute` at this
            size was decoration. It carries the permanence of the route, which
            is the one thing on this card somebody could leave believing the
            opposite of. The link keeps its tier above its own prose — the
            same step `OnLinux` and the card's footer line both take. */}
        <p className="mt-3 text-meta text-text">
          The same download is how a copy that stopped updating is brought back, so it stays on the
          release page rather than being a one-off for this change.{" "}
          <a
            className="text-bone underline decoration-line underline-offset-2"
            href={offer.href}
            target="_blank"
            rel="noreferrer"
          >
            {offer.insteadOf ? "All releases on GitHub" : "Beta builds on GitHub"}
          </a>
          {offer.insteadOf === "unknown" &&
            " — that build's own page could not be looked up just now, so this is every release instead. The beta build is the newest one tagged desktop-v."}
          {offer.insteadOf === "empty" &&
            " — the newest release has no bundles on it yet, so this is every release instead. The beta build is the newest one carrying them."}
        </p>
      </div>
    </div>
  );
}

/**
 * What is checked when a bundle is installed by hand, and what is not.
 *
 * This route goes around the one check that normally happens without anybody
 * asking: every automatic update is verified against a signing key compiled
 * into the app before it is installed. A file somebody downloads and opens
 * themselves gets none of that, and this page is the page that sends them to
 * do it — so it is the page that owes them the alternative.
 *
 * What each platform does on its own was established against the published
 * artifacts rather than read off the configuration, and the three answers are
 * different enough that one sentence covering all of them would be wrong:
 *
 * - **macOS** is notarised, and Gatekeeper checks the disk image on open.
 * - **Windows** is not signed. The published installer's certificate table is
 *   empty, so SmartScreen warns with no publisher to check — #455 is the
 *   standing defect, and it is not this branch's to close.
 * - **Linux** has nothing at all: an AppImage is executable and is executed.
 *
 * The remedy named is the detached signature published beside each bundle,
 * made with the same minisign key the updater checks, and verified during the
 * security review against the published bytes and against a one-byte
 * modification. **Not a checksums file** — a digest published on the same
 * release as the bundle it describes proves only that the two agree, which
 * whoever replaced the bundle would also have arranged. The separate key is
 * the whole guarantee.
 *
 * Drawn in the same recessed shape as `OnLinux`, because it is the same kind
 * of thing: advice attached to the download rather than part of the argument
 * for the route.
 */
function CheckingIt() {
  return (
    <div className="mt-3 rounded-md border border-line-soft bg-raise px-3 py-2.5">
      <div className="eyebrow">Checking what you downloaded</div>
      <p className="mt-1 text-meta text-dim">
        An automatic update is verified against a signing key inside the app before it is installed.
        <span className="text-text"> A bundle you install by hand is not</span>, so it is worth
        checking it yourself.
      </p>
      <p className="mt-1.5 text-meta text-dim">
        macOS is notarised and Gatekeeper checks the disk image when you open it.{" "}
        <span className="text-text">The Windows installer is not signed</span> — Windows will warn,
        and there is no publisher on it to recognise — and nothing checks an AppImage you run. For
        both of those a detached signature is published beside the bundle, made with the same key
        the updater checks.{" "}
        <a
          className="text-text underline decoration-line underline-offset-2"
          href={VERIFY_DOC}
          target="_blank"
          rel="noreferrer"
        >
          How to check one.
        </a>
      </p>
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
 * It looks for *the general-access release* rather than the latest one, and
 * says so, because that is what these tiles are now: the release the channel
 * manifest pins, which is the newest one only while the channels are level.
 *
 * The one state with nothing of its own to say is a release that was never
 * read — GitHub refused, the pin names a release that is not there, or there
 * is no pin to resolve at all. The tile keeps describing its platform and the
 * card says underneath which of those it was. "Not in this release" is a
 * claim about a release we were never told anything about.
 */
export function tileLine({
  hint,
  href,
  settled,
  resolved,
}: {
  hint: string;
  href?: string;
  settled: boolean;
  /** Whether a general-access release was actually read. */
  resolved: boolean;
}): string {
  if (href) return hint;
  if (!settled) return "Looking for the general-access release…";
  // A release was read, and there is no such file in it.
  if (resolved) return "Not in this release";
  // No release was read, so nothing is known about what one holds: the tile
  // goes on describing its platform and the card says underneath why.
  return hint;
}

function Platform({
  name,
  hint,
  href,
  glyph,
  tag,
  settled,
  resolved,
}: {
  name: string;
  hint: string;
  href?: string;
  glyph: React.ReactNode;
  /** The tier, for a platform that is not held to the same promise as the others. */
  tag?: string;
  settled: boolean;
  resolved: boolean;
}) {
  const line = tileLine({ hint, href, settled, resolved });
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
 * Whether the *On Linux* block is drawn.
 *
 * Drawn while the lookup is still out, because what it says is true whatever
 * the lookup comes back with, and the card should not grow under somebody's
 * cursor when the links arrive.
 *
 * Drawn again when no release was read — GitHub refused, or there is no pin
 * to resolve — which is the same argument the tiles make one line above:
 * nothing is known about the general-access release, the Linux tile is still
 * offering an AppImage, and where to keep a file is not a claim about any
 * particular release. Hiding it there would take away the advice *and* this
 * card's only link to `docs/linux.md` on the one path where the reader has
 * least to go on.
 *
 * Hidden in exactly one case — the release was read and has no AppImage in it.
 * Then there positively is no Linux download, the tile says so itself, and
 * advice about where to keep a file nobody can get from here is noise.
 */
export function showsOnLinux({
  settled,
  resolved,
  linux,
}: {
  settled: boolean;
  resolved: boolean;
  linux?: string;
}) {
  return !settled || !resolved || Boolean(linux);
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

/** The platform marks. Fixed shapes, filled, drawn at the size they are used. */
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
