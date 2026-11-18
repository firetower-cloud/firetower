import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BetaRoute, GetTheApp, betaOffer, downloadNote, showsOnLinux, tileLine } from "./GetTheApp";

/** Where the page sends anybody it cannot hand a release page to. */
const RELEASES_INDEX = "https://github.com/firetower-cloud/firetower/releases";

/** The rendered block as somebody reads it: text, with the markup taken out. */
function words(node: React.ReactNode): string {
  return renderToStaticMarkup(node)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Three states, three sentences — the thing a download tile could not say.
 *
 * Still looking, answered-and-there-is-no-such-file, and could-not-ask were
 * one state with one sentence, and the sentence was the hopeful one. So a
 * release whose macOS job never ran said "Looking for the latest release…"
 * underneath a tile that would never become a link, for as long as anybody
 * was prepared to sit in front of it.
 */
describe("the line under a platform's name", () => {
  const linux = { hint: "AppImage, x86_64" };

  it("is what the file is, once there is one to download", () => {
    expect(tileLine({ ...linux, href: "…/Firetower_0.29.1_amd64.AppImage", settled: true, reached: true })).toBe(
      "AppImage, x86_64",
    );
  });

  it("says it is still looking only while it is still looking", () => {
    expect(tileLine({ ...linux, settled: false, reached: true })).toBe("Looking for the latest release…");
  });

  it("says so when the release answered and has nothing for this platform", () => {
    expect(tileLine({ ...linux, settled: true, reached: true })).toBe("Not in this release");
  });

  it("does not blame the platform for a lookup that failed", () => {
    // Nothing is known about what the release holds, so "Not in this release"
    // would be a claim we cannot make. The card says "Couldn't reach GitHub"
    // once, under the tiles, and each tile goes on describing its platform.
    expect(tileLine({ ...linux, settled: true, reached: false })).toBe("AppImage, x86_64");
  });

  it("tells the same three apart for macOS and Windows", () => {
    const mac = { hint: "Apple silicon and Intel" };
    expect(tileLine({ ...mac, settled: false, reached: true })).toBe("Looking for the latest release…");
    expect(tileLine({ ...mac, settled: true, reached: true })).toBe("Not in this release");
    expect(tileLine({ ...mac, href: "…/Firetower_0.29.1_macos.dmg", settled: true, reached: true })).toBe(
      "Apple silicon and Intel",
    );
  });
});

/**
 * The block under the tiles, which is advice rather than a download.
 *
 * It carries where to keep the AppImage, the known gaps, and this card's only
 * link to `docs/linux.md`. So which states it appears in is the same question
 * as which states that link exists in, and the answer follows the tiles: a
 * lookup that failed is not a release with nothing in it.
 */
describe("whether On Linux is drawn", () => {
  it("is drawn while the lookup is still out", () => {
    // What it says is true whatever the lookup returns, and the card should
    // not grow under somebody's cursor when the links arrive.
    expect(showsOnLinux({ settled: false, reached: true })).toBe(true);
  });

  it("is drawn once there is an AppImage to keep somewhere", () => {
    expect(showsOnLinux({ settled: true, reached: true, linux: "…/Firetower_0.29.1_amd64.AppImage" })).toBe(true);
  });

  it("is drawn when the lookup failed, where nothing is known about the release", () => {
    // The tile above is still offering "AppImage, x86_64" in this state, and
    // where to keep a file is not a claim about any particular release. This
    // is also the only state in which the reader has least to go on, so it is
    // the worst one in which to remove the link to the documentation.
    expect(showsOnLinux({ settled: true, reached: false })).toBe(true);
  });

  it("is hidden only when the release was read and has no AppImage", () => {
    // The one case where there positively is no Linux download: the tile says
    // "Not in this release" itself, and advice about a file nobody can get
    // from here is noise.
    expect(showsOnLinux({ settled: true, reached: true })).toBe(false);
  });
});

/**
 * The version line on the Download card, which names a channel.
 *
 * It used to say *Latest*, which is a date-ish claim and says nothing about
 * which channel the three tiles under it are on. The block below opens by
 * saying the downloads above are general access, so there has to be something
 * above it making that claim.
 */
describe("the version line under Download", () => {
  it("names the channel the tiles are on, not just a number", () => {
    expect(downloadNote("0.55.0")).toBe("General access: 0.55.0");
  });

  it("still names the channel when there is no version yet", () => {
    // Still looking, or GitHub could not be asked. The channel is known
    // either way — it is which build these tiles are — so the line does not
    // fall back to saying nothing about it.
    expect(downloadNote()).toBe("The general-access release");
  });
});

/** A lookup that found a beta build with bundles on it. */
const FOUND = {
  version: "0.56.0",
  betaRelease: "https://example.invalid/desktop-v0.56.0",
  mac: "https://example.invalid/Firetower_0.56.0_macos.dmg",
  windows: "https://example.invalid/Firetower_0.56.0_x64-setup.exe",
  linux: "https://example.invalid/Firetower_0.56.0_amd64.AppImage",
};

/**
 * What the route can honestly offer, which is not always a build.
 *
 * Two states hand the reader the releases index instead of a release page,
 * and they are different sentences — so they are different values here rather
 * than one boolean, and neither of them keeps the version.
 */
describe("what the beta route can offer", () => {
  it("names the build and links at its own page when there is one", () => {
    expect(betaOffer(FOUND)).toEqual({
      version: "0.56.0",
      href: "https://example.invalid/desktop-v0.56.0",
    });
  });

  it("falls back to the index when nothing resolved, and says which case that is", () => {
    // Still looking, GitHub refused, or no desktop release in the feed. The
    // refusal is the common one: sixty unauthenticated calls an hour, per
    // address, shared by everyone behind an admin console.
    expect(betaOffer({})).toEqual({ href: RELEASES_INDEX, insteadOf: "unknown" });
    expect(betaOffer({ version: "0.56.0" })).toEqual({ href: RELEASES_INDEX, insteadOf: "unknown" });
  });

  it("will not name a build whose bundles never uploaded", () => {
    // The three tiles above already say "Not in this release". A confident
    // version here, linking at an empty page, would be the only part of the
    // card still claiming there is something to download.
    expect(betaOffer({ version: "0.56.0", betaRelease: "https://example.invalid/r" })).toEqual({
      href: RELEASES_INDEX,
      insteadOf: "empty",
    });
  });

  it("names a build on the strength of any one platform", () => {
    expect(betaOffer({ ...FOUND, mac: undefined, windows: undefined }).version).toBe("0.56.0");
  });
});

/**
 * The route onto beta for a copy that cannot reach it any other way.
 *
 * This is the whole reason the page is load-bearing rather than a download
 * list, so the tests are about what it *says*. Every one of these sentences
 * is the only place a reader is told the thing, and a quiet edit that drops
 * one leaves a correct-looking page that misleads.
 */
describe("the beta route", () => {
  const drawn = words(<BetaRoute found={FOUND} />);

  it("says why a manual install is necessary, and not only that one is", () => {
    // The compiled-in updater address is the fact the whole route rests on:
    // a copy can only read a different address by updating, and it can only
    // update through the address it has. Without this the hand-install reads
    // as an arbitrary inconvenience somebody should have automated.
    expect(drawn).toContain("its update address is compiled into the bundle");
    expect(drawn).toContain("the only way to a different address is to install from it once");
  });

  it("scopes that reason to the copies it is true of", () => {
    // It is true of a copy that predates the channel release. A copy that
    // carries it chooses its endpoint per check — which is what the next
    // sentence means by a switch in the app under Updates — so stating the
    // requirement of every copy made the two contradict each other one line
    // apart. The page said exactly that, and must not again.
    expect(drawn).toContain("A copy that predates all of this cannot be switched from inside itself");
    expect(drawn).not.toContain("Every copy carries its update address inside the bundle");
  });

  it("offers the beta bundle, at the release page it is actually on", () => {
    const markup = renderToStaticMarkup(<BetaRoute found={FOUND} />);
    expect(markup).toContain('href="https://example.invalid/desktop-v0.56.0"');
    expect(drawn).toContain("Beta builds on GitHub");
  });

  it("carries the version beta is at", () => {
    expect(drawn).toContain("0.56.0");
  });

  it("says what happens after the hand-install", () => {
    // Once, not a habit: the copy is on beta from then on and updates itself.
    expect(drawn).toContain("From the next release on, that copy updates on beta by itself");
  });

  it("says switching back stops new betas rather than reverting the build", () => {
    expect(drawn).toContain("Switching back in the app stops new betas");
    expect(drawn).toContain("It does not reinstall the general-access build");
    expect(drawn).toContain("a copy is never moved back to an older one");
  });

  it("says the route is permanent, by naming the other situation it answers", () => {
    // A copy that stopped updating needs the same download, which is why the
    // route does not go away when everybody has taken the channel release.
    expect(drawn).toContain("The same download is how a copy that stopped updating is brought back");
    expect(drawn).toContain("rather than being a one-off for this change");
  });

  it("does not present the route as temporary", () => {
    // The route is permanent, so nothing may hedge it into a migration step
    // somebody is waiting to withdraw. These are the words that would.
    for (const hedge of [
      "for now",
      "until ",
      "temporar",
      "migrat",
      "in the meantime",
      "eventually",
      // Not a bare "soon": "as soon as it is cut" is the sentence that says
      // beta is continuous, which is the opposite of a hedge.
      "coming soon",
      "for the time being",
      "scaffold",
      "one-time",
      "transition",
      "interim",
      "no longer be needed",
    ]) {
      expect(drawn.toLowerCase()).not.toContain(hedge);
    }
  });

  it("says a bundle installed by hand is not checked the way an update is", () => {
    // This route goes around the updater's signature check, which is the one
    // thing on the automatic path nobody has to remember to do. The page that
    // sends somebody down it owes them the alternative.
    expect(drawn).toContain("An automatic update is verified against a signing key inside the app");
    expect(drawn).toContain("A bundle you install by hand is not");
  });

  it("names what each platform does on its own, because the three differ", () => {
    expect(drawn).toContain("macOS is notarised");
    expect(drawn).toContain("The Windows installer is not signed");
    expect(drawn).toContain("nothing checks an AppImage you run");
  });

  it("points at the signature rather than a checksum", () => {
    // A digest published on the same release as the bundle it describes
    // proves only that the two agree. The separate signing key is the
    // guarantee, so that is what the page sends somebody to check.
    expect(drawn).toContain("a detached signature is published beside the bundle");
    expect(drawn.toLowerCase()).not.toContain("checksum");
    expect(drawn.toLowerCase()).not.toContain("sha256");
    expect(renderToStaticMarkup(<BetaRoute found={FOUND} />)).toContain("verifying-a-download.md");
  });

  it("says so when the link is the index rather than the release page", () => {
    // The reader has just been told to use *the release page* and is being
    // handed thirty releases across three packages. Two links with two labels
    // and one destination, with no sign which is the fallback, is the state
    // this is here to prevent.
    const missed = words(<BetaRoute found={{}} />);
    expect(missed).toContain("All releases on GitHub");
    expect(missed).toContain("could not be looked up just now");
    expect(missed).toContain("the newest one tagged desktop-v");
    expect(missed).not.toContain("Beta builds on GitHub");
  });

  it("says something different when the release is there and its bundles are not", () => {
    const empty = words(<BetaRoute found={{ version: "0.56.0", betaRelease: "https://e.invalid/r" }} />);
    expect(empty).toContain("the newest release has no bundles on it yet");
    // And no confident version against a download nobody can get.
    expect(empty).not.toContain("0.56.0");
  });

  it("still has somewhere to send a reader when the lookup failed", () => {
    // Every sentence here is true whatever the release holds, so the block is
    // drawn in that state too. The same argument `showsOnLinux` makes for the
    // block above it.
    const markup = renderToStaticMarkup(<BetaRoute found={{}} />);
    expect(markup).toContain(`href="${RELEASES_INDEX}"`);
    expect(words(<BetaRoute found={{}} />)).toContain("Beta builds");
  });

  it("answers no question ember answers, and adds no tone", () => {
    // `desktop/STYLE.md`: ember means one thing — something is waiting on you
    // — and nothing else may use it. A new section is told apart by position
    // and weight, never by a new hue.
    const markup = renderToStaticMarkup(<BetaRoute found={FOUND} />);
    for (const tone of ["ember", "sage", "brick", "slate"]) {
      expect(markup).not.toContain(tone);
    }
  });

  it("draws every one of its sentences above the faintest tiers", () => {
    // `--color-dim` is recorded in the sheet at 2.94:1 on `--color-panel`,
    // under the floor for normal text and spent on counts, timestamps and
    // paths; `--color-mute` is fainter still. These sentences decide whether
    // somebody hand-installs a build, so all four are `--color-text` —
    // including the closing one, which carries the permanence of the route
    // and is an aside by being `--text-meta` and last, not by fading.
    const markup = renderToStaticMarkup(<BetaRoute found={FOUND} />);
    for (const sentence of [
      "The downloads above are general access",
      "A copy that predates all of this",
      "Switching back in the app stops new betas",
      "The same download is how a copy that stopped updating",
    ]) {
      // The paragraph's own class, not a window before it — a window picks
      // up the version badge, which is `--color-dim` and correctly so.
      const tag = markup.match(new RegExp(`<p class="([^"]+)">${sentence}`));
      expect(tag?.[1]).toBeDefined();
      expect(tag?.[1]).toContain("text-text");
      expect(tag?.[1]).not.toContain("text-dim");
      expect(tag?.[1]).not.toContain("text-mute");
    }
  });

  it("keeps the closing line's link above the line it sits in", () => {
    // Lifting the prose and leaving the link where it was would put a link
    // one tier *below* its own sentence, which reads as a disabled control.
    // `OnLinux` and this card's footer line both take the same step up.
    const markup = renderToStaticMarkup(<BetaRoute found={FOUND} />);
    const link = markup.match(/<a class="([^"]+)"[^>]*>Beta builds on GitHub/);
    expect(link?.[1]).toContain("text-bone");
    expect(link?.[1]).not.toContain("text-dim");
  });
});

/**
 * That the page actually carries the route.
 *
 * Every test above renders `BetaRoute` directly, so all of them pass with the
 * block deleted from the card — which is the regression this ticket is most
 * exposed to: the block dropped, moved into another card, or put behind a
 * condition that is false in production. This renders the page itself.
 *
 * Server rendering, so no effect runs and the release lookup never answers.
 * That is the state the assertions want anyway: the sentences are the same in
 * every state of the lookup, and this proves they reach the page in the one
 * state a reader is guaranteed to see first.
 */
describe("the Get the app page", () => {
  const page = words(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <GetTheApp />
    </QueryClientProvider>,
  );

  it("carries the beta route, in the Download card", () => {
    expect(page).toContain("Beta builds");
    expect(page).toContain("Download");
  });

  it("carries all four of the sentences the route exists to say", () => {
    expect(page).toContain("A copy that predates all of this cannot be switched from inside itself");
    expect(page).toContain("From the next release on, that copy updates on beta by itself");
    expect(page).toContain("Switching back in the app stops new betas");
    expect(page).toContain("The same download is how a copy that stopped updating is brought back");
  });

  it("carries the version line as a channel", () => {
    expect(page).toContain("The general-access release");
  });
});
