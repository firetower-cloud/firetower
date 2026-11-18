/**
 * Reading a drop, and refusing one.
 *
 * **Every limit here is deliberately tiny.** Three files, a hundred bytes
 * each, two hundred in total: figures no installation would publish, so a
 * reader that had a real bound written into it would pass none of these. A
 * previous attempt at this feature hard-coded figures that were not the
 * server's, and a test using the real ones cannot tell the two apart.
 *
 * The other half of what is asserted is **when** a file is read. A bound that
 * is checked after a drop is expanded is not a bound, so the files below throw
 * if anything reads them, and the tests that expect a refusal expect it
 * without a single read.
 */
import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { readProfileDrop, readProfileFiles } from "./profiles";
import type { PlanLimits } from "~/api/generated/model";

const LIMITS: PlanLimits = { files: 3, fileBytes: 100, totalBytes: 200, depth: 3 };

const bundle = (name: string) => `---\nname: ${name}\ndoes: does\n---\n\nGo.\n`;

/** A file at a path, the way a folder drop gives one. */
function at(path: string, body: string | Uint8Array, opts: { unreadable?: boolean } = {}): File {
  const file = new File([body as BlobPart], path.split("/").pop() ?? path);
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  if (opts.unreadable) {
    /* **Reading this is the failure.** An own property shadows the
       prototype's, so anything that reaches for the bytes throws instead of
       quietly succeeding. */
    Object.defineProperty(file, "arrayBuffer", {
      value: () => Promise.reject(new Error(`${path} was read`)),
    });
  }
  return file;
}

/** A file whose size is claimed rather than measured, for the size bounds. */
function claiming(path: string, bytes: number): File {
  const file = at(path, "", { unreadable: true });
  Object.defineProperty(file, "size", { value: bytes });
  return file;
}

/** What a drag event carries, as the reader takes it off one. */
const dragged = (files: File[]) =>
  ({
    items: files.map((f) => ({ webkitGetAsEntry: () => null, getAsFile: () => f })),
  }) as unknown as DataTransfer;

const chosen = (files: File[]) => files as unknown as FileList;

describe("what a drop comes to", () => {
  it("reads every bundle as text and leaves everything else as a path", async () => {
    const got = await readProfileFiles(
      chosen([
        at("profiles/designer/PROFILE.md", bundle("Designer")),
        at("profiles/engineer/PROFILE.md", bundle("Engineer")),
        /* Named rather than dropped: the plan lists it under `ignored`, and
           somebody who expected it to be read should see that it was not. It
           is never read, which is what `unreadable` asserts. */
        at("profiles/README.md", "a library of profiles", { unreadable: true }),
      ]),
      LIMITS,
    );

    expect(got.refused).toBe(null);
    expect(got.files.map((f) => f.path)).toEqual([
      "profiles/designer/PROFILE.md",
      "profiles/engineer/PROFILE.md",
      "profiles/README.md",
    ]);
    expect(got.files[0]!.text).toContain("name: Designer");
    expect(got.files[2]!.text).toBe("");
  });

  it("takes a single bundle, dropped on its own", async () => {
    const got = await readProfileDrop(
      dragged([at("designer/PROFILE.md", bundle("Designer"))]),
      LIMITS,
    );
    expect(got.refused).toBe(null);
    expect(got.files).toHaveLength(1);
    expect(got.files[0]!.text).toContain("name: Designer");
  });

  it("leaves out what the tools put there", async () => {
    const got = await readProfileFiles(
      chosen([
        at("profiles/designer/PROFILE.md", bundle("Designer")),
        at("profiles/.DS_Store", "junk", { unreadable: true }),
        at("profiles/.git/HEAD", "ref: refs/heads/main", { unreadable: true }),
      ]),
      LIMITS,
    );
    expect(got.refused).toBe(null);
    expect(got.files.map((f) => f.path)).toEqual(["profiles/designer/PROFILE.md"]);
  });
});

describe("the bounds are the server's, and they are checked first", () => {
  it("refuses more files than an import takes, without reading one", async () => {
    const got = await readProfileFiles(
      chosen(
        ["a", "b", "c", "d"].map((k) =>
          at(`profiles/${k}/PROFILE.md`, bundle(k), { unreadable: true }),
        ),
      ),
      LIMITS,
    );
    expect(got.files).toEqual([]);
    expect(got.refused).toContain("at most 3 files");
    expect(got.refused).toContain("Drop the folder that holds the bundles");
  });

  it("refuses a file past the file bound, naming the file and the figure", async () => {
    const got = await readProfileFiles(
      chosen([claiming("profiles/designer/PROFILE.md", 101)]),
      LIMITS,
    );
    expect(got.files).toEqual([]);
    expect(got.refused).toContain("profiles/designer/PROFILE.md");
    expect(got.refused).toContain("at most 100 B");
    expect(got.refused).toContain("Shorten the instructions");
  });

  it("refuses a drop past the total bound, naming the figure", async () => {
    const got = await readProfileFiles(
      chosen([
        at("profiles/a/PROFILE.md", "x".repeat(90)),
        at("profiles/b/PROFILE.md", "y".repeat(90)),
        at("profiles/c/PROFILE.md", "z".repeat(90)),
      ]),
      LIMITS,
    );
    expect(got.files).toEqual([]);
    expect(got.refused).toContain("at most 200 B");
    expect(got.refused).toContain("Drop fewer folders");
  });

  it("refuses a path deeper than an import reads", async () => {
    const got = await readProfileFiles(
      chosen([at("repo/stack/profiles/designer/PROFILE.md", bundle("Designer"))]),
      LIMITS,
    );
    expect(got.files).toEqual([]);
    expect(got.refused).toContain("5 folders deep");
    expect(got.refused).toContain("at most 3");
  });

  it("refuses a bundle that is not text", async () => {
    const got = await readProfileFiles(
      chosen([at("profiles/designer/PROFILE.md", new Uint8Array([0xff, 0xfe, 0x00, 0x9f]))]),
      LIMITS,
    );
    expect(got.files).toEqual([]);
    expect(got.refused).toContain("is not text");
    expect(got.refused).toContain("UTF-8");
  });
});

describe("an archive", () => {
  const zipped = (entries: Record<string, string | Uint8Array>) =>
    new File([zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v]))) as BlobPart], "profiles.zip");

  /* A zip of two tiny files is still a few hundred bytes of container, which
     is past the 200-byte total these tests use everywhere else. So this one
     has room for the archive and keeps the same 100-byte file bound — the
     figures are the caller's, which is the property under test. */
  const ROOMY: PlanLimits = { ...LIMITS, totalBytes: 2000 };

  it("is read for its bundles and nothing else", async () => {
    const got = await readProfileDrop(
      dragged([
        zipped({
          "designer/PROFILE.md": bundle("Designer"),
          "README.md": "a library",
        }),
      ]),
      ROOMY,
    );
    expect(got.refused).toBe(null);
    expect(got.files.map((f) => f.path).sort()).toEqual([
      "profiles/README.md",
      "profiles/designer/PROFILE.md",
    ]);
    expect(got.files.find((f) => f.path.endsWith("designer/PROFILE.md"))!.text).toContain(
      "name: Designer",
    );
    // Read for the bundle, and not for the file beside it.
    expect(got.files.find((f) => f.path === "profiles/README.md")!.text).toBe("");
  });

  /**
   * **The zip bomb, refused.** 40 KB of zeroes compresses to a few dozen
   * bytes, so the archive is inside every bound a compressed size could be
   * judged by, and the entry says it will be 400 times what a file may be.
   * The entry's own header is what the filter judges, and what comes out is
   * measured as well — this asserts the refusal, and the test below is the
   * one that can tell whether anything was inflated.
   */
  it("is refused for a bundle past the file bound, however small it compresses to", async () => {
    const bomb = zipped({ "designer/PROFILE.md": new Uint8Array(40 * 1024) });
    expect(bomb.size).toBeLessThan(ROOMY.totalBytes);

    const got = await readProfileDrop(dragged([bomb]), ROOMY);
    expect(got.files).toEqual([]);
    expect(got.refused).toContain("at most 100 B");
    expect(got.refused).toContain("profiles/designer/PROFILE.md");
  });

  /**
   * **Nothing but a bundle is inflated, and this is how that is visible.**
   *
   * `big.bin` is four megabytes of zeroes in an archive of a few kilobytes,
   * against a total bound of sixty-four. Anything that inflated it would
   * count four megabytes of drop and refuse — so a drop that reads cleanly is
   * a drop in which that entry was never decompressed. It travels as its path
   * and no bytes, which is what the plan needs to name it under `ignored`.
   */
  it("inflates its bundles and not the rest of it", async () => {
    const roomier: PlanLimits = { ...LIMITS, totalBytes: 64 * 1024 };
    const archive = zipped({
      "designer/PROFILE.md": bundle("Designer"),
      "big.bin": new Uint8Array(4 * 1024 * 1024),
    });
    expect(archive.size).toBeLessThan(roomier.totalBytes);

    const got = await readProfileDrop(dragged([archive]), roomier);
    expect(got.refused).toBe(null);
    expect(got.files.find((f) => f.path === "profiles/big.bin")!.text).toBe("");
    expect(got.files.find((f) => f.path.endsWith("PROFILE.md"))!.text).toContain("name: Designer");
  });

  it("is refused before it is opened when the archive itself is too big", async () => {
    const got = await readProfileDrop(
      dragged([claiming("profiles.zip", LIMITS.totalBytes + 1)]),
      LIMITS,
    );
    expect(got.files).toEqual([]);
    expect(got.refused).toContain("before it is even unpacked");
    expect(got.refused).toContain("Unpack it");
  });

  it("is refused rather than read as empty when it cannot be opened", async () => {
    const got = await readProfileDrop(
      dragged([new File([strToU8("not a zip at all")] as BlobPart[], "profiles.zip")]),
      ROOMY,
    );
    expect(got.files).toEqual([]);
    expect(got.refused).toContain("could not be opened as a .zip");
  });
});
