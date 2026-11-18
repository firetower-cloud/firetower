import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BetaRoute, downloadNote, showsOnLinux, tileLine } from "./GetTheApp";

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

/**
 * The route onto beta for a copy that cannot reach it any other way.
 *
 * This is the whole reason the page is load-bearing rather than a download
 * list, so the tests are about what it *says*. Every one of these sentences
 * is the only place a reader is told the thing, and a quiet edit that drops
 * one leaves a correct-looking page that misleads.
 */
describe("the beta route", () => {
  const drawn = words(<BetaRoute version="0.56.0" release="https://example.invalid/desktop-v0.56.0" />);

  it("says why a manual install is necessary, and not only that one is", () => {
    // The compiled-in updater address is the fact the whole route rests on:
    // a copy can only read a different address by updating, and it can only
    // update through the address it has. Without this the hand-install reads
    // as an arbitrary inconvenience somebody should have automated.
    expect(drawn).toContain("Every copy carries its update address inside the bundle");
    expect(drawn).toContain("installing by hand once is the only way to reach a different one");
  });

  it("offers the beta bundle, at the release page it is actually on", () => {
    const markup = renderToStaticMarkup(
      <BetaRoute version="0.56.0" release="https://example.invalid/desktop-v0.56.0" />,
    );
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

  it("still has somewhere to send a reader when the lookup failed", () => {
    // Every sentence here is true whatever the release holds, so the block is
    // drawn in that state too — and then the link is the releases index. The
    // same argument `showsOnLinux` makes for the block above it.
    const markup = renderToStaticMarkup(<BetaRoute />);
    expect(markup).toContain('href="https://github.com/firetower-cloud/firetower/releases"');
    expect(words(<BetaRoute />)).toContain("Beta builds");
  });

  it("answers no question ember answers, and adds no tone", () => {
    // `desktop/STYLE.md`: ember means one thing — something is waiting on you
    // — and nothing else may use it. A new section is told apart by position
    // and weight, never by a new hue.
    const markup = renderToStaticMarkup(
      <BetaRoute version="0.56.0" release="https://example.invalid/desktop-v0.56.0" />,
    );
    for (const tone of ["ember", "sage", "brick", "slate"]) {
      expect(markup).not.toContain(tone);
    }
  });
});
