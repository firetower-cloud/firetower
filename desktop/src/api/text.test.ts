/**
 * What a tab does with the bytes it was handed.
 *
 * The bug these exist for: a PNG has a NUL inside the first few bytes, so the
 * binary sniff claimed every screenshot and the answer on screen was "a binary
 * file, nothing to draw". That sniff is right about a lockfile and wrong about
 * the thing you opened the tab to look at, so pictures are decided by
 * extension *before* it runs — and that ordering is what is pinned here.
 */
import { describe, expect, it } from "vitest";
import { decide, imageTypeOf, isImage, MOST, MOST_IMAGE } from "./text";

/** A PNG's real first eight bytes — the signature carries two NULs. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

const buffer = (bytes: Uint8Array | string) =>
  (typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).buffer as ArrayBuffer;

const sized = (n: number) => new ArrayBuffer(n);

describe("imageTypeOf", () => {
  it("names the media type an extension implies", () => {
    expect(imageTypeOf("shot.png")).toBe("image/png");
    expect(imageTypeOf("a/b/photo.JPG")).toBe("image/jpeg");
    expect(imageTypeOf("icon.svg")).toBe("image/svg+xml");
  });

  it("says nothing about a file that is not a picture", () => {
    expect(imageTypeOf("src/main.rs")).toBeNull();
    expect(imageTypeOf("README.md")).toBeNull();
    expect(imageTypeOf("noextension")).toBeNull();
  });

  it("agrees with isImage", () => {
    expect(isImage("/tmp/annotation/10-card-grown-near-bottom.png")).toBe(true);
    expect(isImage("Cargo.lock")).toBe(false);
  });
});

describe("decide", () => {
  it("draws a PNG rather than calling it binary", () => {
    const what = decide("shot.png", buffer(PNG));
    expect(what.kind).toBe("image");
    if (what.kind !== "image") return;
    expect(what.mediaType).toBe("image/png");
    expect(what.url).toMatch(/^blob:/);
    expect(what.bytes).toBe(PNG.byteLength);
  });

  /* The same bytes without the extension are still just bytes — the picture
     branch must not have loosened the sniff for everything else. */
  it("still calls a NUL-bearing file binary when it is not a picture", () => {
    expect(decide("weird.bin", buffer(PNG)).kind).toBe("binary");
  });

  it("reads an ordinary file as text", () => {
    const what = decide("src/main.rs", buffer("fn main() {}"));
    expect(what.kind).toBe("text");
    if (what.kind === "text") expect(what.text).toBe("fn main() {}");
  });

  /* A screenshot is routinely several times the text cap. If pictures shared
     it, the feature would report "too much to put on a screen" for exactly the
     retina captures it was built for. */
  it("gives pictures a larger cap than text", () => {
    expect(MOST_IMAGE).toBeGreaterThan(MOST);
    expect(decide("shot.png", sized(MOST + 1)).kind).toBe("image");
    expect(decide("notes.txt", sized(MOST + 1)).kind).toBe("huge");
  });

  it("refuses a picture past its own cap", () => {
    const what = decide("huge.png", sized(MOST_IMAGE + 1));
    expect(what.kind).toBe("huge");
    if (what.kind === "huge") expect(what.bytes).toBe(MOST_IMAGE + 1);
  });

  /* Every blob handed out is a reference the browser holds until it is
     revoked, so each call must mint exactly one and no more. */
  it("mints a fresh url per call", () => {
    const a = decide("shot.png", buffer(PNG));
    const b = decide("shot.png", buffer(PNG));
    if (a.kind !== "image" || b.kind !== "image") throw new Error("expected pictures");
    expect(a.url).not.toBe(b.url);
    URL.revokeObjectURL(a.url);
    URL.revokeObjectURL(b.url);
  });
});
