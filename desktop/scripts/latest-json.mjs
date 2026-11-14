/**
 * `latest.json` — the updater's manifest — assembled once, by one job.
 *
 *   node latest-json.mjs --repo owner/name --tag desktop-v1.2.3 --version 1.2.3 \
 *                        --signatures <dir> [--out latest.json]
 *
 * Run with `node` and not a shebang: `pnpm test` imports this file for the
 * two functions below, on all three platforms, and the Windows runner's git
 * checks text files out with CRLF — where the bundler strips `#!…` and leaves
 * the carriage return behind, which is a syntax error in a file that is
 * otherwise fine everywhere else.
 *
 * Every installed copy of Firetower reads one fixed address for this file and
 * finds, under its own platform key, the archive to download and the minisign
 * signature it must check against the public key the app was built with. A
 * platform that is not in here is a platform that is never offered the
 * update: the check succeeds, says there is nothing newer, and the copy on
 * somebody's desk stays where it is. Nothing fails and nobody is told.
 *
 * ## Why this is not `tauri-action`'s `uploadVersionJSON`
 *
 * Because that has no single writer. Each matrix leg reads the manifest off
 * the release, merges **its own platform** into it, deletes the asset and
 * re-uploads — with no locking anywhere (read at the commit this repository
 * pins, 84b9d35b). Two legs that finish within a few seconds of each other
 * both read the same file, and whichever uploads second wins: the other
 * platform is simply not in the manifest that survives. That is not a Linux
 * problem — it has been live for as long as there have been two platforms,
 * and Linux is a third chance for it to fire.
 *
 * So no leg writes it. Each uploads its bundle and the `.sig` beside it, and
 * this runs once afterwards and builds the whole manifest from what is
 * actually on the release. Legs finishing together cannot clobber each other
 * because none of them is holding the pen.
 *
 * ## Why the signatures are the input
 *
 * They are the only evidence that a leg got all the way to the end. An
 * unfinished or failed leg leaves no `.sig` for its platform, so asking the
 * signatures what to write and refusing to write a manifest that is missing
 * one is the same check as "did every platform build" — without anybody
 * having to keep a second list of which platforms are expected up to date.
 */
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/**
 * Every key this manifest has to carry, and which artifact fills it.
 *
 * The suffixed keys — `-app`, `-nsis`, `-msi`, `-appimage` — are aliases the
 * CLI writes beside the plain `{os}-{arch}` one, so that a build can ask the
 * updater for a particular installer. The updater reads the plain key unless
 * it was told otherwise. **They are reproduced exactly as the CLI wrote them**
 * rather than trimmed to what we believe is read: this file replaces a
 * generated one, and a key quietly dropped from it is an update that stops
 * being offered to whoever is configured to ask for it.
 *
 * macOS is one universal archive under both architectures' keys, which is
 * what `--target universal-apple-darwin` means. Windows's plain key is the
 * NSIS installer because that is what `updaterJsonPreferNsis` chose and an
 * installed copy already asks for it; the `.msi` keeps its alias. Linux is
 * the AppImage, which is the only Linux artifact that can update itself — the
 * updater overwrites the file named by `$APPIMAGE`, in place.
 */
export const WANTED = [
  {
    what: "the macOS app",
    matches: (name) => name.endsWith(".app.tar.gz"),
    keys: ["darwin-aarch64", "darwin-x86_64", "darwin-aarch64-app", "darwin-x86_64-app"],
  },
  {
    what: "the Windows installer",
    matches: (name) => name.endsWith("-setup.exe"),
    keys: ["windows-x86_64", "windows-x86_64-nsis"],
  },
  {
    what: "the Windows .msi",
    matches: (name) => name.endsWith(".msi"),
    keys: ["windows-x86_64-msi"],
  },
  {
    what: "the Linux AppImage",
    // `.AppImage.tar.gz` as well as `.AppImage`, because which one the bundler
    // signs depends on `createUpdaterArtifacts`: `true` signs the AppImage
    // itself, `"v1Compatible"` wraps it first. This repository is on the
    // former, so the plain one is what should appear — but a release is a poor
    // place to find out that a config key moved, and if both ever turned up
    // the two-candidates check below refuses rather than guessing.
    matches: (name) => name.endsWith(".AppImage") || name.endsWith(".AppImage.tar.gz"),
    keys: ["linux-x86_64", "linux-x86_64-appimage"],
  },
];

/**
 * The one rename an artifact undergoes between being signed and being uploaded.
 *
 * `tauri-action`'s `getAssetName` (read at 84b9d35b, the commit this
 * repository pins) hands back `basename(path)` for everything **except**
 * macOS's `.app.tar.gz`, which gets `_<arch>` appended to its stem so that two
 * architectures' archives can sit on one release. `--target
 * universal-apple-darwin` makes that `_universal`, which is why the asset is
 * `Firetower_universal.app.tar.gz` while the archive the signature was made
 * over is plain `Firetower.app.tar.gz`.
 *
 * So every other platform's signature names its asset exactly, and this is the
 * only gap that is allowed to exist. It is written as the specific rename
 * rather than as "near enough" on purpose: a looser rule — a shared prefix, a
 * matching extension — is one that also accepts the pairing it exists to
 * reject.
 */
const MAC_ARCHIVE = ".app.tar.gz";

function paired(asset, signed) {
  if (asset === signed) return true;
  if (!asset.endsWith(MAC_ARCHIVE) || !signed.endsWith(MAC_ARCHIVE)) return false;
  const stem = signed.slice(0, -MAC_ARCHIVE.length);
  const renamed = asset.slice(0, -MAC_ARCHIVE.length);
  /* Exactly one `_<arch>` appended, and nothing else moved. */
  return renamed.startsWith(`${stem}_`) && /^[A-Za-z0-9]+$/.test(renamed.slice(stem.length + 1));
}

/**
 * What a `.sig` has to look like, and what it has to be a signature *of*,
 * before it is copied into the manifest.
 *
 * The contents of the file, verbatim, are what the updater checks. Two things
 * are worth checking here, and they fail differently:
 *
 *   * It has to be a signature at all — not an empty file, a truncated
 *     upload, or an error page saved under the right name.
 *   * It has to be a signature over **the payload this entry points at**.
 *     minisign's trusted comment is covered by the signature's own global
 *     signature, so the `file:` Tauri writes into it is not a label anybody
 *     can change after the fact: altering it invalidates the signature an
 *     installed copy checks. That makes it the evidence of which artifact was
 *     signed, and comparing it to the asset the URL names is what stops a
 *     manifest pairing, say, a Windows signature with a Linux download.
 *
 * Selecting signatures by file name alone could not see that: a manifest with
 * every key present and a signature against the wrong payload looks complete
 * from here, and the installed updater correctly refuses the update. Nothing
 * is compromised — the key still means what it means — but every copy on that
 * platform is offered an update it then rejects, which is the same silent
 * outage the single writer below exists to prevent.
 *
 * What it still cannot tell is a signature made with the wrong *key*; only an
 * installed copy can, and by then the update has already been offered.
 */
function signatureOrThrow(name, text) {
  const trimmed = text.trim();
  let inside = "";
  try {
    inside = Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    /* Reported below, with the same message as every other shape of rubbish. */
  }
  if (!trimmed || !inside.startsWith("untrusted comment:") || !inside.includes("file:")) {
    throw new Error(
      `${name}.sig is not a minisign signature (${trimmed.length} bytes).\n` +
        "Nothing can be published from it: an installed copy would reject the\n" +
        "update, which is the one failure mode that cannot be repaired from\n" +
        "here afterwards. Re-run the leg that produced it.",
    );
  }

  /* `timestamp:<unix>\tfile:<name>` is what Tauri writes; the tab guard is
     there because minisign itself allows more fields after the file name. */
  const signed = inside.match(/\bfile:(.+)/)?.[1].split("\t")[0].trim() ?? "";
  if (!paired(name, signed)) {
    throw new Error(
      `${name}.sig is a signature over ${signed || "a file it does not name"}, not over ${name}.\n\n` +
        "The manifest is not written. An entry whose signature belongs to a\n" +
        "different payload is one every installed copy rejects: the update is\n" +
        "offered, the download runs, the signature check fails, and the person\n" +
        "is left on the build they already had with nothing they can do about\n" +
        "it. Nothing here can tell which of the two is the wrong one, so re-run\n" +
        "the leg that produced this pair rather than editing a manifest.",
    );
  }
  return trimmed;
}

/** The `.sig` files a job downloaded off the release, by the artifact they sign. */
export function readSignatures(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sig"))
    .map((f) => ({ name: f.slice(0, -".sig".length), signature: readFileSync(join(dir, f), "utf8") }));
}

/**
 * The manifest, or an error naming what is missing.
 *
 * `signatures` is `[{ name, signature }]` — the artifact's own file name and
 * the contents of the `.sig` beside it.
 */
export function manifest({ version, repo, tag, signatures, pubDate = new Date().toISOString() }) {
  const platforms = {};
  const missing = [];

  for (const want of WANTED) {
    const found = signatures.filter((s) => want.matches(s.name));
    if (found.length === 0) {
      missing.push(want.what);
      continue;
    }
    /* Two of the same artifact is not something to pick between: the names
       carry the version, so it means two versions' assets are on one release
       and the manifest could be built pointing at either. */
    if (found.length > 1) {
      throw new Error(
        `${found.length} candidates for ${want.what} on ${tag}: ${found.map((f) => f.name).join(", ")}.\n` +
          "Which one an installed copy should download is not this script's to\n" +
          "guess. Remove the assets that do not belong to this release.",
      );
    }
    const [{ name, signature }] = found;
    const entry = {
      signature: signatureOrThrow(name, signature),
      // `encodeURIComponent` and not the raw name: a product name with a space
      // in it is a legal bundle and an illegal URL.
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`,
    };
    for (const key of want.keys) platforms[key] = entry;
  }

  if (missing.length > 0) {
    throw new Error(
      `${tag} has no signature for ${missing.join(", ")}.\n\n` +
        "The manifest is not written. Publishing one that is missing a platform\n" +
        "is worse than publishing nothing: every copy of Firetower on that\n" +
        "platform asks for an update, is told there is none, and stays where it\n" +
        "is — with nothing on fire and nobody told. Re-run the leg that builds\n" +
        "it, then run this job again.",
    );
  }

  // `notes` is empty and the release's own body carries the changelog, which
  // is what the CLI wrote here too — the Updates screen links to the release
  // rather than rendering this.
  return { version, notes: "", pub_date: pubDate, platforms };
}

/* Run as a command, not when a test imports it for the two functions above. */
const asCommand =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (asCommand) {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      tag: { type: "string" },
      version: { type: "string" },
      signatures: { type: "string" },
      out: { type: "string", default: "latest.json" },
    },
  });
  for (const need of ["repo", "tag", "version", "signatures"]) {
    if (!values[need]) {
      console.error(`latest-json.mjs: --${need} is required`);
      process.exit(2);
    }
  }

  /* The message and not the stack: this runs in the last job of a release and
     somebody is reading the log to find out what to do next. */
  let written;
  try {
    written = manifest({
      version: values.version,
      repo: values.repo,
      tag: values.tag,
      signatures: readSignatures(values.signatures),
    });
  } catch (e) {
    console.error(`\nlatest-json.mjs: ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  }

  writeFileSync(values.out, `${JSON.stringify(written, null, 2)}\n`);
  console.log(`${values.out}: ${Object.keys(written.platforms).join(", ")}`);
}
