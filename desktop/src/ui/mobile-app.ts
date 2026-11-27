/**
 * What the *Get the mobile app* dialog says, as functions of what it knows.
 *
 * Pure, and in its own module, because the Android column has four faces and
 * three of them are only reachable through a network call. A test that had to
 * stall or break a `fetch` to see "Couldn't reach GitHub" would be testing the
 * stub; here each face is a value in and a sentence out, the way
 * `usage-rules.ts` and `Inspector.tsx`'s `tabsFor` already do it.
 *
 * The geometry is here for the same reason and a sharper one: the dialog's
 * width is arithmetic on the encoded URLs, and arithmetic that lives inside a
 * component is arithmetic nobody can check.
 */
import { codeWidth, spanOfVersion, widthOfSpan } from "~/components/ui/QrCode";

/**
 * The public TestFlight link. A constant, unlike the APK: Apple's public link
 * for a beta group does not move, and each new submission appears behind the
 * same URL — so there is nothing to look up and this column never waits and
 * never fails.
 */
export const TESTFLIGHT = "https://testflight.apple.com/join/uhgjMk1y";

/** What the chip shows for it. The host, not the path: the whole URL is on the
 *  clipboard and in the code, and the host is the part that says who it is. */
export const TESTFLIGHT_SHOWN = "testflight.apple.com";

/** Every release, which is where the APK is and where the footer points. */
export const RELEASES = "https://github.com/firetower-cloud/firetower/releases";

/**
 * The feed, read once when the dialog opens.
 *
 * Public and anonymous, as `releases.ts` already reads it, and
 * `crates/ft-server/src/web.rs`'s renderer policy is
 * `connect-src 'self' http: https: ws: wss:` — so this is allowed from a
 * served page as well as from the shell. One page: the APK is wanted newest
 * first and a phone release older than thirty releases is not the answer to
 * *get the app*.
 */
export const FEED = "https://api.github.com/repos/firetower-cloud/firetower/releases?per_page=30";

/** How the phone's releases are tagged, and what the asset is called. */
const MOBILE_TAG = "mobile-v";

/**
 * Where the Android column is.
 *
 * `looking` is the state on open and is the only one that resolves into
 * another; `none` and `unreachable` are both answers, and they are different
 * answers — a feed that said *no release carries an APK* is a fact about the
 * release, and a feed that could not be asked is a fact about the network.
 * Collapsing them is how a page ends up telling somebody the build does not
 * exist because their office has no outbound route.
 */
export type Lookup = "looking" | "ready" | "none" | "unreachable";

/** The APK, once the feed has been read. */
export type Apk = { url: string; version: string };

/**
 * Where the lookup is, and what it found — as one value rather than two.
 *
 * A pair of `{ at, apk }` makes *ready with no APK* expressible, which is a
 * state nothing can draw: the code has nothing to encode and the placeholder
 * has nothing to say. A union makes it unsayable instead of making every
 * reader of it guess, which is the same reasoning `Build` on the page this
 * replaces got wrong — `settled` and `read` as two booleans, and the fourth
 * corner meaningless.
 */
export type Found =
  | { at: "looking" }
  | { at: "ready"; apk: Apk }
  | { at: "none" }
  | { at: "unreachable" };

/** As much of a GitHub release as this dialog reads. */
type Release = {
  tag_name?: unknown;
  assets?: unknown;
};

/**
 * The newest `mobile-v*` release that actually carries an APK.
 *
 * **Not simply the newest `mobile-v*` release.** A release whose Android job
 * failed, or one cut before there was an APK at all, would otherwise leave the
 * code pointing at nothing; walking back past it degrades into an older
 * version, which is a true answer, rather than into an empty one. It is also
 * why no version is written into this file — GitHub's own `/latest` is
 * whichever component was tagged last, usually the control plane, and the
 * asset carries its version in its name.
 *
 * Takes `unknown` and checks its way in. This is a response from a server
 * nobody here operates, and `reuse.test.ts` holds the rule this is the other
 * half of: an optional chain that guards the response and not the field is
 * how three white screens happened, on three different days.
 */
export function apkIn(body: unknown): Apk | null {
  if (!Array.isArray(body)) return null;
  for (const release of body as Release[]) {
    const tag = typeof release?.tag_name === "string" ? release.tag_name : null;
    if (!tag || !tag.startsWith(MOBILE_TAG)) continue;
    if (!Array.isArray(release.assets)) continue;
    for (const asset of release.assets as { name?: unknown; browser_download_url?: unknown }[]) {
      const name = typeof asset?.name === "string" ? asset.name : null;
      const url = typeof asset?.browser_download_url === "string" ? asset.browser_download_url : null;
      if (!name || !url || !name.endsWith(".apk")) continue;
      return { url, version: tag.slice(MOBILE_TAG.length) };
    }
  }
  return null;
}

/** The file name under the Android code, which is what the chip shows. */
export const apkShown = (url: string): string => url.split("/").pop() ?? url;

/** What the Android column says, in each of its four states. */
export type AndroidFace = {
  /** The caption's second line, always present. */
  line: string;
  /** What stands in the code's place, or null when there is a code. */
  wait: string | null;
  /** A sentence instead of a chip, where nothing will ever resolve. */
  why: string | null;
  /** Whether there is a chip at all, and whether it can be copied from. */
  chip: "live" | "dead" | "none";
};

/**
 * The Android column, as one function of the lookup.
 *
 * Three decisions are in here rather than in the markup, and each is one a
 * reviewer should be able to find:
 *
 * **No middle dot.** The page this replaces writes the hint as
 * `` `APK · ${version}` ``, which is the second of `STYLE.md`'s three habits.
 * Two lines of real layout instead — *Android*, then *An APK, version 0.35.0*.
 *
 * **Not brick, in either failure.** Nothing has failed that the reader did. A
 * release whose Android build is not out yet, and a Firetower with no outbound
 * route, are both ordinary; `STYLE.md`'s reachability rule is about exactly
 * this case.
 *
 * **The dead chip exists only while a lookup is still out.** It is there to
 * stop the column moving when the answer lands. In the two states where
 * nothing will ever resolve there is no movement to prevent, so the sentence
 * takes the chip's place — which also keeps the two columns' links on one
 * line.
 */
export function androidFace(found: Found): AndroidFace {
  switch (found.at) {
    case "ready":
      return {
        line: `An APK, version ${found.apk.version}`,
        wait: null,
        why: null,
        chip: "live",
      };
    case "looking":
      return { line: "An APK", wait: "Looking for the latest release…", why: null, chip: "dead" };
    case "none":
      return {
        line: "An APK",
        wait: "No release carries an APK yet",
        why: "The Android build has not been published yet. Every release is on GitHub.",
        chip: "none",
      };
    case "unreachable":
      return {
        line: "An APK",
        wait: "Couldn’t reach GitHub",
        why: "A Firetower on a private network often can’t. The APK is on the releases page.",
        chip: "none",
      };
  }
}

/**
 * The QR version the dialog plans for before the APK URL is known.
 *
 * Six at correction level M, which is where today's APK URL sits: 98 bytes
 * against the 106 that version holds. **Eight characters of headroom** — a
 * longer tag, a longer version or a renamed asset tips it to version 7, and
 * then the box and the dialog both grow. Which is the whole reason none of
 * those numbers is written down below.
 */
const PLANNED_VERSION = 6;

/** The gap between the two columns. */
const PAIR_GAP = 20;

/** `.dlg`'s horizontal padding, each side. */
const DLG_PAD = 24;

/**
 * How big to draw both codes.
 *
 * **Both the same, and the longer payload sets it.** Two codes side by side at
 * different sizes read as a mistake, and sizing each to its own payload is
 * what would produce that — TestFlight encodes to 29 modules and the APK to
 * 41. So the box is the widest any of them needs at the module floor, and the
 * shorter code simply gets roomier modules.
 *
 * Never below what version 6 needs, so the dialog does not resize under the
 * reader when the APK lookup lands — the iPhone code is drawn immediately and
 * the Android side is a placeholder of the same footprint.
 */
export function boxFor(urls: (string | null | undefined)[]): number {
  return Math.max(
    widthOfSpan(spanOfVersion(PLANNED_VERSION)),
    ...urls.filter((u): u is string => !!u).map((u) => codeWidth(u)),
  );
}

/**
 * How wide the dialog is: two boxes, the gap, and its own padding.
 *
 * At today's URLs that is 2 × 188 + 20 + 48 = 444, which is 28rem — and it is
 * **computed rather than written**, because a version-7 APK URL makes it
 * 2 × 204 + 20 + 48 = 476 and a literal would silently drop the Android code
 * to 3.7px per module on whichever release crossed the line.
 */
export const dialogWidth = (box: number): number => box * 2 + PAIR_GAP + DLG_PAD * 2;
