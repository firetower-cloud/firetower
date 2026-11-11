/**
 * The eight strips around a window with no frame.
 *
 * Two things that cannot be seen from the machine this was written on: that
 * macOS draws none of them — it has its own resize margin, and two mechanisms
 * at one edge is one too many — and that **the two top corners are the height
 * of the top edge rather than square**. A 16px square at the top right takes a
 * bite out of *Close*, and a mis-grab there does not close a window, it
 * resizes one. That is the number a tidy-up would square off, so it is
 * asserted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/** The strips as they render on `where`, inside the native shell. */
async function stripsOn(where: string) {
  vi.resetModules();
  vi.stubGlobal("navigator", { userAgentData: { platform: where } });
  vi.doMock("~/bridge", () => ({ bridge: { native: true } }));
  const { Resize } = await import("./Resize");
  return renderToStaticMarkup(<Resize />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("~/bridge");
});

describe("the resize strips", () => {
  it("cover all eight regions, with the matching cursor", async () => {
    const { STRIPS } = await import("./Resize");
    expect(STRIPS.map((s) => s.d)).toEqual([
      "North",
      "South",
      "West",
      "East",
      "NorthWest",
      "NorthEast",
      "SouthWest",
      "SouthEast",
    ]);
    expect(Object.fromEntries(STRIPS.map((s) => [s.d, s.cursor]))).toEqual({
      North: "ns-resize",
      South: "ns-resize",
      West: "ew-resize",
      East: "ew-resize",
      NorthWest: "nwse-resize",
      NorthEast: "nesw-resize",
      SouthWest: "nesw-resize",
      SouthEast: "nwse-resize",
    });
  });

  it("keeps the top corners out of the window buttons", async () => {
    const { STRIPS } = await import("./Resize");
    const box = (d: string) => STRIPS.find((s) => s.d === d)!.box;

    // The top edge is 4px and the top corners are no taller than it.
    expect(box("North").height).toBe(4);
    expect(box("NorthWest").height).toBe(4);
    expect(box("NorthEast").height).toBe(4);
    // The bottom two are square and larger, because they are the two people use.
    expect(box("SouthEast")).toMatchObject({ width: 16, height: 16 });
    expect(box("SouthWest")).toMatchObject({ width: 16, height: 16 });
    // 6px at the left, right and bottom.
    expect(box("West").width).toBe(6);
    expect(box("East").width).toBe(6);
    expect(box("South").height).toBe(6);
  });

  it("draws nothing on macOS, which has a frame of its own", async () => {
    expect(await stripsOn("macOS")).toBe("");

    const linux = await stripsOn("Linux");
    expect(linux).toContain('data-resize="SouthEast"');
    expect((linux.match(/data-resize=/g) ?? []).length).toBe(8);

    expect(await stripsOn("Windows")).toContain('data-resize="North"');
  });
});
