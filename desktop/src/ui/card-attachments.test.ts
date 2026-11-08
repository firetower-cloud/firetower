import { describe, expect, it, vi } from "vitest";
import type { TaskAttachment } from "~/api/generated/model";
import { BIGGEST_FILE, BIGGEST_IMAGE, MOST } from "./attach";
import { chipForAttachment, download, fromCard, holdsAttachments, refusalOf, withLinks } from "./card-attachments";

const shot: TaskAttachment = {
  id: "5f1b2c3d4e5f60718293a4b5",
  name: "screenshot.png",
  mime: "image/png",
  bytes: 150_000,
  url: "https://trello.com/1/cards/c/attachments/5f1b2c3d4e5f60718293a4b5/download/screenshot.png",
  upload: true,
};
const spec: TaskAttachment = {
  id: "5f1b2c3d4e5f60718293a4b6",
  name: "spec.pdf",
  mime: "application/pdf",
  bytes: 2_000_000,
  url: "https://trello.com/1/cards/c/attachments/5f1b2c3d4e5f60718293a4b6/download/spec.pdf",
  upload: true,
};
const figma: TaskAttachment = {
  id: "5f1b2c3d4e5f60718293a4b7",
  name: "Checkout mockup",
  mime: null,
  bytes: null,
  url: "https://www.figma.com/file/abc/Checkout",
  upload: false,
};

/**
 * A card's attachments, sorted the way a drop would sort them.
 *
 * Files are brought along under the same caps as a file dropped on the
 * composer, decided from the size the card states so nothing too big is
 * downloaded at all. Links have no bytes and go into the description instead.
 */
describe("what a card's attachments become", () => {
  it("brings the files and writes down the links", () => {
    const plan = fromCard([shot, figma, spec], 0);
    expect(plan.files.map((a) => a.name)).toEqual(["screenshot.png", "spec.pdf"]);
    expect(plan.links.map((a) => a.name)).toEqual(["Checkout mockup"]);
    expect(plan.refusals).toEqual([]);
  });

  it("refuses a picture over the picture cap and a file over the file cap, before downloading", () => {
    const plan = fromCard(
      [
        { ...shot, bytes: BIGGEST_IMAGE + 1 },
        { ...spec, bytes: BIGGEST_FILE + 1 },
      ],
      0,
    );
    expect(plan.files).toEqual([]);
    expect(plan.refusals).toEqual(["screenshot.png is over 5 MB.", "spec.pdf is over 25 MB."]);
  });

  it("takes a file whose size the card does not state, to be sifted once it arrives", () => {
    expect(fromCard([{ ...spec, bytes: null }], 0).files).toHaveLength(1);
  });

  it("stops at the message's cap, counting what is already attached", () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ ...spec, id: `${i}`, name: `${i}.pdf` }));
    const plan = fromCard(many, MOST - 2);
    expect(plan.files.map((a) => a.name)).toEqual(["0.pdf", "1.pdf"]);
    expect(plan.refusals).toHaveLength(1);
  });
});

describe("the chip an attachment shows while it comes", () => {
  it("is pending, named, sized from the card, and a picture when the card says so", () => {
    expect(chipForAttachment(3, shot)).toMatchObject({
      id: 3,
      name: "screenshot.png",
      kind: "image",
      size: "147 KB",
      pending: true,
    });
    expect(chipForAttachment(4, spec).kind).toBe("file");
  });

  it("says nothing about a size the card did not state", () => {
    expect(chipForAttachment(5, { ...spec, bytes: null }).size).toBe("");
  });
});

describe("links on the card, in the description", () => {
  it("adds them under the seeded body", () => {
    expect(withLinks("Fix the export\nhttps://trello.com/c/aB3dE9fG", [figma])).toBe(
      "Fix the export\nhttps://trello.com/c/aB3dE9fG\n\nLinks on the card:\nCheckout mockup: https://www.figma.com/file/abc/Checkout",
    );
  });

  it("writes a link named by its own address once", () => {
    expect(withLinks("Title", [{ ...figma, name: figma.url }])).toBe(
      "Title\n\nLinks on the card:\nhttps://www.figma.com/file/abc/Checkout",
    );
  });

  it("leaves the body alone when there are none", () => {
    expect(withLinks("Title", [])).toBe("Title");
  });
});

describe("which tasks are asked for their attachments", () => {
  it("only those from a tracker that has them", () => {
    expect(holdsAttachments("trello")).toBe(true);
    expect(holdsAttachments("github")).toBe(false);
    expect(holdsAttachments("linear")).toBe(false);
    expect(holdsAttachments(undefined)).toBe(false);
  });
});

describe("what a chip says when a download is refused", () => {
  it("says the server's own sentence", () => {
    expect(
      refusalOf('{"code":"ProviderNotConnected","message":"Trello refused the token. It may have been revoked."}', "spec.pdf"),
    ).toBe("Trello refused the token. It may have been revoked.");
    expect(refusalOf('{"code":"InvalidRequest","message":"That attachment is over 25 MB."}', "spec.pdf")).toBe(
      "That attachment is over 25 MB.",
    );
  });

  it("falls back to naming the file when there is no sentence", () => {
    expect(refusalOf("<html>bad gateway</html>", "spec.pdf")).toBe("spec.pdf could not be brought from the card.");
    expect(refusalOf('{"code":"Internal"}', "spec.pdf")).toBe("spec.pdf could not be brought from the card.");
  });
});

describe("which attachments are pictures", () => {
  const as = (mime: string): TaskAttachment => ({ ...shot, mime });

  it("are the four kinds the server serves as images", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(chipForAttachment(1, as(mime)).kind).toBe("image");
    }
    expect(fromCard([as("image/png"), as("image/webp")], 0).files).toHaveLength(2);
  });

  it("leave a phone's heic and svg and tiff to go in as files", () => {
    for (const mime of ["image/heic", "image/svg+xml", "image/tiff"]) {
      expect(chipForAttachment(1, as(mime)).kind).toBe("file");
    }
  });

  it("are not relabelled as images when downloaded as something else", async () => {
    const fetched = (type: string) =>
      vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["x"], { type }))));
    fetched("application/octet-stream");
    const heic = await download("https://trello.com/c/aB3dE9fG", { ...shot, name: "IMG_1.heic", mime: "image/heic" });
    expect(heic.type).not.toMatch(/^image\//);
    fetched("image/png");
    const png = await download("https://trello.com/c/aB3dE9fG", shot);
    expect(png.type).toBe("image/png");
    vi.unstubAllGlobals();
  });
});
