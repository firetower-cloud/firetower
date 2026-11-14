import { describe, expect, it } from "vitest";
import { showsOnLinux, tileLine } from "./GetTheApp";

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
