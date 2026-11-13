/**
 * The five strips around a window with no frame.
 *
 * Two things that cannot be seen from the machine this was written on: that
 * macOS draws none of them — it has its own resize margin, and two mechanisms
 * at one edge is one too many — and that **there is nothing along the top**.
 * A 4px `North` strip and two 16x4 top corners shipped here first and were
 * taken out: they sat entirely inside tao's own 5px border, so they added no
 * reach, and being in the DOM they swallowed the top 4px of all three window
 * buttons, which tao's border does not. That absence is the one a tidy-up
 * completes — three of the eight directions missing reads as unfinished — so
 * it is asserted rather than left to a comment.
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
  it("cover the sides and the bottom, with the matching cursor", async () => {
    const { STRIPS } = await import("./Resize");
    expect(STRIPS.map((s) => s.d)).toEqual(["South", "West", "East", "SouthWest", "SouthEast"]);
    expect(Object.fromEntries(STRIPS.map((s) => [s.d, s.cursor]))).toEqual({
      South: "ns-resize",
      West: "ew-resize",
      East: "ew-resize",
      SouthWest: "nesw-resize",
      SouthEast: "nwse-resize",
    });
  });

  it("draws nothing along the top, where the window buttons are", async () => {
    const { STRIPS } = await import("./Resize");

    // The top edge and the two top corners are tao's 5px border and nothing
    // of ours. A strip here is the top 4px of Minimise, Maximise and Close.
    for (const d of ["North", "NorthWest", "NorthEast"]) {
      expect(STRIPS.find((s) => s.d === d)).toBeUndefined();
    }
    // And the side strips start below that border rather than at the corner,
    // so the 6px the right-hand one takes never reaches the buttons' row.
    expect(STRIPS.find((s) => s.d === "West")!.box.top).toBe(4);
    expect(STRIPS.find((s) => s.d === "East")!.box.top).toBe(4);
  });

  it("keeps the numbers the design is", async () => {
    const { STRIPS } = await import("./Resize");
    const box = (d: string) => STRIPS.find((s) => s.d === d)!.box;

    // The bottom two are square and large, because they are the two people use.
    expect(box("SouthEast")).toMatchObject({ width: 16, height: 16 });
    expect(box("SouthWest")).toMatchObject({ width: 16, height: 16 });
    // 6px at the left, right and bottom, against tao's 5.
    expect(box("West").width).toBe(6);
    expect(box("East").width).toBe(6);
    expect(box("South").height).toBe(6);
  });

  it("draws nothing on macOS, which has a frame of its own", async () => {
    expect(await stripsOn("macOS")).toBe("");

    const linux = await stripsOn("Linux");
    expect(linux).toContain('data-resize="SouthEast"');
    expect((linux.match(/data-resize=/g) ?? []).length).toBe(5);

    const windows = await stripsOn("Windows");
    expect(windows).toContain('data-resize="SouthEast"');
    // Windows gets the sides and the bottom for the same reason — an
    // undecorated window with a shadow has no non-client area to put a border
    // in — and not the top, which tao answers `HTTOP` for already.
    expect(windows).not.toContain('data-resize="North"');
  });
});
