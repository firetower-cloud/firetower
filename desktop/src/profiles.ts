/**
 * Reading a dropped folder of profile bundles, within the bounds the server
 * says it will take.
 *
 * **Bounded before anything is expanded, which is the whole reason this is not
 * `skills.ts`'s reader.** That one reads every file of a drop into memory and
 * inflates every entry of an archive before anything looks at a size — so a
 * small, highly compressed archive is a denial of service on the desktop
 * rather than a refusal from the server. The fifth finding of
 * `profiles-as-code-threat-model` is exactly that, and it names bounded
 * reading as a dependency of the drop gesture. So, in order:
 *
 * * **Count first, and stop counting at the bound.** A walk that aborts at one
 *   past the limit never traverses a repository, and an archive's table of
 *   contents is read without inflating a byte of it.
 * * **Judge declared sizes, then actual ones.** A zip entry's header says how
 *   big it will be, which is enough to refuse it before it is inflated and is
 *   not evidence: what comes out is measured too.
 * * **Read only the bundles.** A `PROFILE.md` is read as text; everything else
 *   travels as its path and nothing else, because the plan names those under
 *   `ignored` and never reads them. Sending the bytes of somebody's repository
 *   for the server to throw away would be the same waste one layer along.
 *
 * **The figures are the server's**, from `GET /api/v1/roles/import/limits`.
 * Not written here: a second copy of a bound is a second place for it to be
 * wrong, and this feature has already had one attempt whose hard-coded figures
 * were not the server's.
 */
import { unzip, type UnzipFileInfo } from "fflate";
import type { DroppedFile, PlanLimits } from "~/api/generated/model";
import { size } from "~/skills";

/** The file a bundle is, spelled the way the format spells it. */
const PROFILE_MD = "PROFILE.md";

/** Junk that is in a folder because of the tools, not because of the library. */
const SKIP = /(^|\/)(\.git|node_modules|\.DS_Store|__pycache__|\.venv|\.idea|\.vscode)(\/|$)/;

/**
 * What a drop came to: the files to send, or the reason nothing was read.
 *
 * Never both. A refusal is about the drop as a whole — it is past a bound the
 * endpoint publishes — so there is nothing to plan and nothing to show per
 * profile. The review draws it as a refusal rather than as a plan with no
 * entries, which is a shape the server cannot produce.
 */
export type Dropped = {
  files: DroppedFile[];
  refused: string | null;
};

/** One file a drop holds, before its bytes have been read. */
type Found = {
  path: string;
  /** How to read it, for the ones that are bundles. */
  read: (() => Promise<Uint8Array>) | null;
  /** What it says it is, before it is read. */
  bytes: number;
};

/**
 * A bound, thrown so the first one broken is the one reported.
 *
 * The alternative is every reader returning a union and every caller
 * remembering to check it, which is how a refusal comes to be dropped on the
 * floor halfway up — and the drop is refused *whole*, so there is nothing to
 * carry on with after one.
 */
class Bound extends Error {}

/* ── the bounds, as the sentences they are refused with ───────────────── */
//
// Every one names the figure it broke and then what to do about it, which is
// the bar the server's own refusals are held to.

const tooMany = (limits: PlanLimits) =>
  `An import takes at most ${limits.files} files, and this drop has more. Drop the folder that holds the bundles rather than the tree around it.`;

const tooBig = (path: string, bytes: number, limits: PlanLimits) =>
  `${path} is ${size(bytes)}, and a file in a drop is at most ${size(
    limits.fileBytes,
  )}. Shorten the instructions below the frontmatter, or leave that bundle out.`;

const tooMuch = (bytes: number, limits: PlanLimits) =>
  `This drop is ${size(bytes)} of profiles, and an import takes at most ${size(
    limits.totalBytes,
  )}. Drop fewer folders at once.`;

const tooDeep = (path: string, depth: number, limits: PlanLimits) =>
  `${path} is ${depth} folders deep, and an import reads at most ${limits.depth}. Drop the folder that holds the bundles rather than the repository around it.`;

const archiveTooBig = (path: string, bytes: number, limits: PlanLimits) =>
  `${path} is ${size(bytes)} before it is even unpacked, and an import takes at most ${size(
    limits.totalBytes,
  )}. Unpack it and drop the folder of bundles inside it.`;

const notAnArchive = (path: string) =>
  `${path} could not be opened as a .zip. Unpack it and drop the folder of bundles inside it.`;

const notText = (path: string) =>
  `${path} is not text, so it describes no profile. Save it as UTF-8 and drop the folder again.`;

/* ── reading a drop ──────────────────────────────────────────────────── */

const isBundle = (path: string): boolean => {
  const name = path.split("/").filter(Boolean).pop() ?? "";
  // Case-insensitively, so a `profile.md` reaches the server and is told what
  // is wrong with it. Filtering it out here would make somebody's bundle
  // vanish out of the review without a word.
  return name.toLowerCase() === PROFILE_MD.toLowerCase();
};

/**
 * Everything a drop holds, as the files to plan.
 *
 * The entries have to come off the event synchronously; what they yield is
 * awaited after. A `DataTransferItemList` is indexed and not iterable, so
 * spreading it throws — the same trap `skills.ts` and `drop.ts` both hit.
 */
export function readProfileDrop(dt: DataTransfer | null, limits: PlanLimits): Promise<Dropped> {
  const list = dt?.items;
  if (!list) return Promise.resolve({ files: [], refused: null });
  const roots: (FileSystemEntry | File)[] = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i]?.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
    else {
      const file = list[i]?.getAsFile?.();
      if (file) roots.push(file);
    }
  }
  return read(roots, limits);
}

/** The same, from a file input — which gives `webkitRelativePath` instead. */
export function readProfileFiles(chosen: FileList | null, limits: PlanLimits): Promise<Dropped> {
  return read(Array.from(chosen ?? []), limits);
}

async function read(
  roots: (FileSystemEntry | File)[],
  limits: PlanLimits,
): Promise<Dropped> {
  try {
    const found = await gather(roots, limits);
    return { files: await texts(found, limits), refused: null };
  } catch (e) {
    if (e instanceof Bound) return { files: [], refused: e.message };
    throw e;
  }
}

/** Every file in the drop, with nothing read yet. */
async function gather(
  roots: (FileSystemEntry | File)[],
  limits: PlanLimits,
): Promise<Found[]> {
  const found: Found[] = [];
  const keep = (file: Found) => {
    const depth = file.path.split("/").filter(Boolean).length;
    if (depth > limits.depth) throw new Bound(tooDeep(file.path, depth, limits));
    found.push(file);
    // **One past the bound, and no further.** Counted as the walk goes, so a
    // repository dropped by mistake is refused after reading its table of
    // contents rather than after reading the files in it.
    if (found.length > limits.files) throw new Bound(tooMany(limits));
  };

  for (const root of roots) {
    if (root instanceof File) {
      const path =
        (root as File & { webkitRelativePath?: string }).webkitRelativePath || root.name;
      await take(root, path, keep, limits);
    } else {
      await walk(root, "", keep, limits);
    }
  }
  return found;
}

/** The bundles, read; everything else as a path the plan can name. */
async function texts(found: Found[], limits: PlanLimits): Promise<DroppedFile[]> {
  const files: DroppedFile[] = [];
  let total = 0;
  for (const file of found) {
    if (!file.read) {
      files.push({ path: file.path, text: "" });
      continue;
    }
    if (file.bytes > limits.fileBytes) throw new Bound(tooBig(file.path, file.bytes, limits));
    const bytes = await file.read();
    // Declared, then actual: a declared size is a claim about a file nobody
    // has read yet, and an archive is free to understate one.
    if (bytes.length > limits.fileBytes) {
      throw new Bound(tooBig(file.path, bytes.length, limits));
    }
    total += bytes.length;
    if (total > limits.totalBytes) throw new Bound(tooMuch(total, limits));
    const text = asText(bytes);
    if (text === null) throw new Bound(notText(file.path));
    files.push({ path: file.path, text });
  }
  return files;
}

/** One file of a drop: an archive to open, or a file to keep. */
async function take(
  file: File,
  path: string,
  keep: (found: Found) => void,
  limits: PlanLimits,
): Promise<void> {
  if (SKIP.test(path)) return;
  if (path.toLowerCase().endsWith(".zip")) {
    // **Before `arrayBuffer`.** An archive bigger than a whole drop may be is
    // refused without being read, whatever it would have inflated to.
    if (file.size > limits.totalBytes) {
      throw new Bound(archiveTooBig(path, file.size, limits));
    }
    for (const entry of await openZip(
      new Uint8Array(await file.arrayBuffer()),
      path.replace(/\.zip$/i, ""),
      limits,
    )) {
      keep(entry);
    }
    return;
  }
  keep({
    path,
    read: isBundle(path) ? async () => new Uint8Array(await file.arrayBuffer()) : null,
    bytes: file.size,
  });
}

/** A folder, and everything under it. */
async function walk(
  entry: FileSystemEntry,
  prefix: string,
  keep: (found: Found) => void,
  limits: PlanLimits,
): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (SKIP.test(path)) return;

  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) =>
      (entry as FileSystemFileEntry).file(
        (f) => resolve(f),
        () => resolve(null),
      ),
    );
    if (file) await take(file, path, keep, limits);
    return;
  }

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  /* `readEntries` returns at most a hundred at a time and signals the end
     with an empty batch. Reading once gives a silently truncated folder,
     which only shows up on somebody else's large library. */
  const more = (): Promise<FileSystemEntry[]> =>
    new Promise((resolve) =>
      reader.readEntries(
        (batch) => resolve(batch),
        () => resolve([]),
      ),
    );
  for (;;) {
    const batch = await more();
    if (batch.length === 0) return;
    for (const child of batch) await walk(child, path, keep, limits);
  }
}

/**
 * An archive's bundles, inflating nothing else.
 *
 * `filter` runs over the central directory **before** anything is
 * decompressed, which is what makes a bomb a refusal rather than a hang: an
 * entry that is not a `PROFILE.md`, or that says it will be bigger than a file
 * may be, is never inflated at all. The first bound broken is reported after
 * the scan rather than thrown out of the callback, because a throw inside
 * somebody else's loop leaves it halfway through.
 */
function openZip(bytes: Uint8Array, root: string, limits: PlanLimits): Promise<Found[]> {
  const names: string[] = [];
  let declared = 0;
  let scanned = 0;
  let broke: string | null = null;
  return new Promise((resolve, reject) => {
    const filter = (entry: UnzipFileInfo): boolean => {
      if (broke || entry.name.endsWith("/") || SKIP.test(entry.name)) return false;
      scanned++;
      if (scanned > limits.files) {
        broke = tooMany(limits);
        return false;
      }
      const path = `${root}/${entry.name}`;
      const depth = path.split("/").filter(Boolean).length;
      if (depth > limits.depth) {
        broke = tooDeep(path, depth, limits);
        return false;
      }
      names.push(entry.name);
      if (!isBundle(entry.name)) return false;
      if (entry.originalSize > limits.fileBytes) {
        broke = tooBig(path, entry.originalSize, limits);
        return false;
      }
      declared += entry.originalSize;
      if (declared > limits.totalBytes) {
        broke = tooMuch(declared, limits);
        return false;
      }
      return true;
    };
    unzip(bytes, { filter }, (err, out) => {
      if (broke) return reject(new Bound(broke));
      // A refusal, not an empty drop. `skills.ts` resolves an unreadable
      // archive to `[]`, which reaches the person as "nothing in there is a
      // profile" about a file that could not be opened at all.
      if (err) return reject(new Bound(notAnArchive(`${root}.zip`)));
      resolve(
        names.map((name) => {
          const inflated = out[name];
          return {
            path: `${root}/${name}`,
            read: inflated ? async () => inflated : null,
            bytes: inflated?.length ?? 0,
          };
        }),
      );
    });
  });
}

/** Some bytes as text, or `null` if they are not text at all. */
function asText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes as unknown as ArrayBufferView);
  } catch {
    return null;
  }
}
