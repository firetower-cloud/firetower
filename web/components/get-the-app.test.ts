import { describe, expect, it } from "vitest";
import { tileLine } from "./GetTheApp";

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
