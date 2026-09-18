import { describe, expect, it } from "vitest";
import { carriesFiles, depth, filesFrom, folderRefusals } from "./drop";

/**
 * The three things about a drop that are easy to get wrong and invisible when
 * you do.
 *
 * A dragged *selection* must not light up the overlay, or reading the
 * conversation with the mouse down looks like an upload is about to happen. A
 * dragged *folder* must be named rather than uploaded, because it arrives
 * looking exactly like an empty file and fails with nothing useful to say. And
 * `dragleave` fires on every child crossed, so the depth has to be counted or
 * the overlay blinks off the moment the pointer reaches the textarea.
 */

/** Enough of a `DataTransfer` for the pure helpers. */
function transfer(
  entries: { name: string; directory?: boolean }[],
  { items = true, types = ["Files"] }: { items?: boolean; types?: string[] } = {},
) {
  const files = entries.map((e) => new File(["x"], e.name));
  const list = entries.map((e) => ({
    webkitGetAsEntry: () => ({ name: e.name, isDirectory: !!e.directory }),
  }));
  return {
    types,
    files,
    items: items ? Object.assign(list, { length: list.length }) : undefined,
  } as unknown as DataTransfer;
}

describe("telling a file drag from any other drag", () => {
  it("is a file drag when the payload says so", () => {
    expect(carriesFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
  });

  it("is not a file drag when text is being dragged", () => {
    expect(carriesFiles({ types: ["text/plain", "text/html"] } as unknown as DataTransfer)).toBe(false);
  });

  it("is not a file drag when there is no payload at all", () => {
    expect(carriesFiles(null)).toBe(false);
  });
});

describe("reading the files out of a drop", () => {
  it("passes ordinary files through", () => {
    const { files, folders } = filesFrom(transfer([{ name: "shot.png" }, { name: "notes.md" }]));
    expect(files.map((f) => f.name)).toEqual(["shot.png", "notes.md"]);
    expect(folders).toEqual([]);
  });

  it("holds a folder back and names it", () => {
    const { files, folders } = filesFrom(transfer([{ name: "assets", directory: true }, { name: "shot.png" }]));
    expect(files.map((f) => f.name)).toEqual(["shot.png"]);
    expect(folders).toEqual(["assets"]);
  });

  it("takes the files as they are when the entries cannot be inspected", () => {
    // Older WebKit has no `items`. Better to try the upload than to refuse.
    const { files, folders } = filesFrom(transfer([{ name: "shot.png" }], { items: false }));
    expect(files.map((f) => f.name)).toEqual(["shot.png"]);
    expect(folders).toEqual([]);
  });

  it("is empty for no payload", () => {
    expect(filesFrom(null)).toEqual({ files: [], folders: [] });
  });

  it("says what is wrong with a dropped folder", () => {
    expect(folderRefusals(["assets"])[0]).toMatch(/^assets is a folder\./);
  });
});

describe("counting how deep into the pane the drag is", () => {
  it("stays over the pane while children are crossed", () => {
    // enter pane, enter scroller, enter composer, then leave the composer.
    let at = 0;
    for (const move of ["enter", "enter", "enter", "leave"] as const) at = depth(at, move);
    expect(at).toBeGreaterThan(0);
  });

  it("is over nothing once every element has been left", () => {
    let at = 0;
    for (const move of ["enter", "enter", "leave", "leave"] as const) at = depth(at, move);
    expect(at).toBe(0);
  });

  it("never goes negative on a leave that was never entered", () => {
    // WKWebView does send these, and a negative count would mean the next
    // real enter had to happen twice before the overlay came back.
    expect(depth(0, "leave")).toBe(0);
  });

  it("clears outright when the drag is abandoned", () => {
    expect(depth(3, "reset")).toBe(0);
  });
});
