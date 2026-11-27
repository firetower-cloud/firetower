/**
 * The rules behind *Get the mobile app*, asked directly.
 *
 * Three of the Android column's four faces are only reachable through a
 * network call, so a test that had to stall or break a `fetch` to see one
 * would be testing the stub. They are pure functions instead, and this is
 * where they are checked; `get-the-mobile-app.test.tsx` checks that the
 * markup wears what they return.
 *
 * **The arithmetic is the part worth testing, and the reason is specific.** A
 * dialog that writes its own width down does not break loudly when a release
 * tag grows: the APK URL tips from QR version 6 to version 7, the module count
 * jumps 41 → 45, and the code quietly drops to 3.7 CSS px per module inside a
 * box that still looks right. So the tests below do not check that the width
 * is 444 — they check that it *moves* when the payload does, which is the
 * thing a literal cannot do.
 */
import { describe, expect, it } from "vitest";
import { codeWidth, FLOOR, spanOfVersion, widthOfSpan } from "~/components/ui/QrCode";
import {
  androidFace,
  apkIn,
  apkShown,
  boxFor,
  dialogWidth,
  TESTFLIGHT,
  type Found,
} from "./mobile-app";

/** What `.github/workflows/mobile-release.yml` uploads, as the feed returns it. */
const APK_URL =
  "https://github.com/firetower-cloud/firetower/releases/download/mobile-v0.35.0/firetower-0.35.0.apk";

const release = (tag: string, assets: { name: string; browser_download_url: string }[]) => ({
  tag_name: tag,
  assets,
});
const apkAsset = (url = APK_URL) => ({ name: url.split("/").pop()!, browser_download_url: url });

/* ── What the feed is asked for ───────────────────────────────────────── */

describe("the APK in a releases feed", () => {
  it("is the newest mobile release that carries one", () => {
    expect(
      apkIn([
        release("firetower-v0.58.0", []),
        release("mobile-v0.35.0", [apkAsset()]),
        release("mobile-v0.34.0", [apkAsset(APK_URL.replace(/0\.35\.0/g, "0.34.0"))]),
      ]),
    ).toEqual({ url: APK_URL, version: "0.35.0" });
  });

  /* A release whose Android job failed would otherwise leave the code
     pointing at nothing. Walking back past it gives an older version, which
     is a true answer; showing it empty is not. */
  it("walks back past a mobile release with no APK rather than showing it empty", () => {
    const older = APK_URL.replace(/0\.35\.0/g, "0.34.0");
    expect(
      apkIn([
        release("mobile-v0.35.0", [{ name: "sources.zip", browser_download_url: "…/sources.zip" }]),
        release("mobile-v0.34.0", [apkAsset(older)]),
      ]),
    ).toEqual({ url: older, version: "0.34.0" });
  });

  it("does not take the desktop app's installers for a phone build", () => {
    expect(
      apkIn([
        release("desktop-v0.35.0", [
          { name: "Firetower_0.35.0.dmg", browser_download_url: "…/Firetower_0.35.0.dmg" },
        ]),
      ]),
    ).toBeNull();
  });

  it("answers nothing when every mobile release is missing its APK", () => {
    expect(apkIn([release("mobile-v0.35.0", [])])).toBeNull();
  });

  /* The response comes from a server nobody here operates. `reuse.test.ts`
     holds the rule this is the other half of: three white screens came from a
     guard one link short of the field it was reading. */
  it.each([
    ["nothing at all", null],
    ["an object where a list was promised", { message: "API rate limit exceeded" }],
    ["a list of the wrong shape", [{ tag_name: 7, assets: "lots" }]],
    ["a release whose asset has no URL", [release("mobile-v0.35.0", [{ name: "x.apk" } as never])]],
  ])("survives %s", (_what, body) => {
    expect(apkIn(body)).toBeNull();
  });

  it("shows the file name under the code, not the whole URL", () => {
    expect(apkShown(APK_URL)).toBe("firetower-0.35.0.apk");
  });
});

/* ── What the Android column says ─────────────────────────────────────── */

const FOUND = {
  ready: { at: "ready", apk: { url: APK_URL, version: "0.35.0" } },
  looking: { at: "looking" },
  none: { at: "none" },
  unreachable: { at: "unreachable" },
} satisfies Record<string, Found>;

describe("the Android column, in each of its four states", () => {
  it("names the version it found, with no middle dot in it", () => {
    const face = androidFace(FOUND.ready);
    expect(face).toEqual({ line: "An APK, version 0.35.0", wait: null, why: null, chip: "live" });
  });

  it("holds the column's place while the lookup is still out", () => {
    expect(androidFace(FOUND.looking)).toEqual({
      line: "An APK",
      wait: "Looking for the latest release…",
      why: null,
      /* Dead rather than absent: the chip is here to stop the column moving
         when the answer lands, which is the only reason it is drawn at all. */
      chip: "dead",
    });
  });

  it("says the release is the problem when the feed answered and had no APK", () => {
    expect(androidFace(FOUND.none)).toEqual({
      line: "An APK",
      wait: "No release carries an APK yet",
      why: "The Android build has not been published yet. Every release is on GitHub.",
      /* Nothing will ever resolve here, so there is no movement to prevent
         and the sentence takes the chip's place. */
      chip: "none",
    });
  });

  it("does not blame the release for a network that could not be reached", () => {
    expect(androidFace(FOUND.unreachable)).toEqual({
      line: "An APK",
      wait: "Couldn’t reach GitHub",
      why: "A Firetower on a private network often can’t. The APK is on the releases page.",
      chip: "none",
    });
  });

  /* The two failures are different answers and have to stay different. A feed
     that said *no release carries an APK* is a fact about the release; a feed
     that could not be asked is a fact about the network, and self-hosting
     makes the second one ordinary. Collapsing them tells somebody the build
     does not exist because their office has no outbound route. */
  it("tells the two failures apart", () => {
    const none = androidFace(FOUND.none);
    const out = androidFace(FOUND.unreachable);
    expect(none.wait).not.toBe(out.wait);
    expect(none.why).not.toBe(out.why);
  });

  it("writes no middle dot in any state — the page this replaces wrote `APK · 0.35.0`", () => {
    const said = Object.values(FOUND)
      .map((found) => androidFace(found))
      .flatMap((face) => [face.line, face.wait, face.why])
      .filter((s): s is string => !!s);
    expect(said.filter((s) => s.includes("·"))).toEqual([]);
    /* And the version really is said somewhere, so the line above is not
       passing because the copy went missing. */
    expect(said).toContain("An APK, version 0.35.0");
  });
});

/* ── The geometry, which is the part a literal would get wrong ─────────── */

describe("how wide a code has to be drawn", () => {
  it("counts the quiet zone, because it is part of the code", () => {
    /* Three modules each side. A code of 41 modules occupies 47. */
    expect(widthOfSpan(41, 1)).toBe(47);
  });

  it("is the standard's own module count for a version — 17 + 4v", () => {
    expect(spanOfVersion(6)).toBe(41);
    expect(spanOfVersion(7)).toBe(45);
  });

  it("gives every module at least the floor, for both of the real payloads", () => {
    for (const url of [TESTFLIGHT, APK_URL]) {
      const span = codeWidth(url, 1);
      expect(codeWidth(url) / span).toBeGreaterThanOrEqual(FLOOR);
    }
  });

  it("is bigger for the longer payload, which is why one fixed size is wrong", () => {
    expect(codeWidth(APK_URL)).toBeGreaterThan(codeWidth(TESTFLIGHT));
  });
});

describe("the box both codes are drawn at", () => {
  const box = boxFor([TESTFLIGHT, APK_URL]);

  it("is what the longer payload needs, at today's URLs 188px", () => {
    expect(box).toBe(codeWidth(APK_URL));
    expect(box).toBe(188);
  });

  /* Two codes side by side at different sizes read as a mistake, so the
     shorter payload simply gets roomier modules. */
  it("leaves the shorter payload above the floor rather than shrinking it", () => {
    expect(box / codeWidth(TESTFLIGHT, 1)).toBeGreaterThan(FLOOR);
  });

  /* The iPhone code is drawn at once and the Android side is a placeholder of
     the same footprint, so a box that grew when the lookup landed would resize
     the dialog under the reader. */
  it("never falls below what version 6 needs, even before the APK is known", () => {
    expect(boxFor([TESTFLIGHT])).toBe(box);
    expect(boxFor([])).toBe(box);
  });

  it("ignores a URL that is not there yet", () => {
    expect(boxFor([TESTFLIGHT, null, undefined])).toBe(box);
  });
});

describe("the dialog's width", () => {
  it("is two boxes, the gap and its own padding — 444 at today's URLs", () => {
    expect(dialogWidth(boxFor([TESTFLIGHT, APK_URL]))).toBe(444);
  });

  /**
   * **The assertion a hard-coded `28rem` fails.**
   *
   * Version 6 at level M holds 106 bytes in byte mode and the APK URL is 98,
   * so there are eight characters of headroom: a ninth tips it to version 7,
   * 45 modules, a 204px box and a 476px dialog. The literal would not break —
   * it would quietly draw the Android code at 3.7px per module.
   */
  it("grows with the payload, which is the whole reason it is not a literal", () => {
    /* A release candidate: the tag lengthens and so does the asset, which is
       exactly how the eight characters get spent in practice. */
    const longer = APK_URL.replace(/0\.35\.0/g, "0.35.0-rc.1");
    expect(longer.length).toBeGreaterThan(APK_URL.length + 8);

    const box = boxFor([TESTFLIGHT, longer]);
    expect(box).toBe(204);
    expect(dialogWidth(box)).toBe(476);
    /* And still at the floor at the bigger size, which is the point of
       growing rather than of fitting the code into the old box. */
    expect(box / codeWidth(longer, 1)).toBeGreaterThanOrEqual(FLOOR);
  });

  it("has exactly eight characters of headroom before that happens", () => {
    const stretch = (by: number) =>
      APK_URL.replace("firetower-0.35.0.apk", `firetower-0.35.0${"x".repeat(by)}.apk`);
    expect(boxFor([stretch(8)])).toBe(188);
    expect(boxFor([stretch(9)])).toBe(204);
  });
});
