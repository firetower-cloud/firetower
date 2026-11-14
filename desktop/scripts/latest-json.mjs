/**
 * `latest.json` — the updater's manifest — assembled once, by one job.
 *
 *   node latest-json.mjs --repo owner/name --tag desktop-v1.2.3 --version 1.2.3 \
 *                        --assets <dir> [--out latest.json]
 *
 * Run with `node` and not a shebang: `pnpm test` imports this file for the
 * functions below, on all three platforms, and the Windows runner's git
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
 * ## Why the signatures say which platforms are in it
 *
 * They are the only evidence that a leg got all the way to the end. An
 * unfinished or failed leg leaves no `.sig` for its platform, so asking the
 * signatures what to write and refusing to write a manifest that is missing
 * one is the same check as "did every platform build" — without anybody
 * having to keep a second list of which platforms are expected up to date.
 *
 * ## Why every signature is then checked against the payload's bytes
 *
 * Because a `.sig` that *names* an artifact is not a signature *of* it. The
 * name inside a signature is a label, and so is the name of the file it was
 * uploaded under; the only thing that establishes which bytes a signature
 * covers is verifying it over those bytes. Two pairings pass every check that
 * can be made from names alone, and both are refused by every installed copy:
 *
 *   * A signature left over from the previous release. `Firetower.app.tar.gz`
 *     is called that in every version, so desktop-v0.29.0's macOS signature
 *     names exactly what desktop-v0.29.1's archive is called. Rebuilding an
 *     existing tag is a supported operation here — `desktop-release.yml` takes
 *     one by `workflow_dispatch` — so this is the ordinary way it happens.
 *   * A signature whose comment was written to name somebody else's payload.
 *     minisign's *untrusted* comment is not covered by anything, so the real
 *     Windows signature with `file:…AppImage` typed into it is still a wholly
 *     valid signature of the Windows installer.
 *
 * Both produce a manifest that looks complete from here and that every copy
 * on the affected platform then rejects: the update is offered, the download
 * runs, the signature check fails, and the person is left on the build they
 * had. That is the same silent outage the single writer above exists to
 * prevent, so the publish job downloads the payloads as well as the
 * signatures, and a pairing this cannot verify is not published.
 *
 * It verifies against the public key out of `tauri.conf.json`, which is the
 * key the installed copy checks against — so a signature made with any other
 * key is caught here too, rather than once per user.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
 * minisign, enough of it to check a signature against bytes.
 *
 * A `.sig` beside a bundle is base64 of minisign's four-line signature file,
 * and `pubkey` in `tauri.conf.json` is base64 of its two-line key file. The
 * second line of each is base64 again, and decodes to a 2-byte algorithm, an
 * 8-byte key id, and then either the 64-byte signature or the 32-byte Ed25519
 * public key. A signature file's fourth line is a second signature, over the
 * third line's trusted comment, which is what makes that comment trusted.
 *
 * `ED` is what Tauri writes: the payload signature covers BLAKE2b-512 of the
 * bytes rather than the bytes. `Ed` is minisign's older form, covering them
 * directly. Both are accepted, because `minisign-verify` in the installed app
 * accepts both and refusing one here would fail a release over a signature
 * every user would have taken.
 *
 * `node:crypto` has Ed25519 and BLAKE2b-512, so this needs no dependency —
 * only the fixed DER prefix that turns a raw 32-byte key into something
 * `createPublicKey` will read.
 */
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/* minisign writes both prefixes with the trailing space, and the global
   signature covers the trusted comment *without* it. One character, and the
   signature of every real artifact fails if it is counted wrongly. */
const UNTRUSTED = "untrusted comment: ";
const TRUSTED = "trusted comment: ";

/** The lines of a boxed minisign file. `Buffer.from` never throws here. */
const unbox = (boxed) => Buffer.from(boxed.trim(), "base64").toString("utf8").split("\n");

/** The 42 bytes of a minisign public key: `Ed`, the key id, then the key. */
export function publicKey(boxed) {
  const raw = Buffer.from(unbox(boxed)[1] ?? "", "base64");
  if (raw.length !== 42) {
    throw new Error(
      `the updater public key is not a minisign public key (${raw.length} bytes, expected 42).\n` +
        "Nothing can be verified against it, so nothing is published. It is read\n" +
        "from `plugins.updater.pubkey` in tauri.conf.json, which is the key every\n" +
        "installed copy checks against — if that has been edited, the edit is the\n" +
        "thing to look at.",
    );
  }
  return { id: raw.subarray(2, 10), key: createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw.subarray(10)]), format: "der", type: "spki" }) };
}

/**
 * The signature, verified over `payload`, or an error naming what went wrong.
 *
 * Nothing in the signature file is read to decide *what* it is a signature of
 * — that is the question the verification answers. The comments are not
 * consulted at all beyond checking that the trusted one carries the global
 * signature minisign requires, because a signature file that fails its own
 * internal check is one the installed updater rejects as well.
 */
function verifiedOrThrow(name, text, payload, expected) {
  const lines = unbox(text);
  const raw = Buffer.from(lines[1] ?? "", "base64");
  if (!lines[0]?.startsWith(UNTRUSTED) || raw.length !== 74 || !lines[2]?.startsWith(TRUSTED)) {
    throw new Error(
      `${name}.sig is not a minisign signature (${text.trim().length} bytes).\n` +
        "Nothing can be published from it: an installed copy would reject the\n" +
        "update, which is the one failure mode that cannot be repaired from\n" +
        "here afterwards. Re-run the leg that produced it.",
    );
  }

  const alg = raw.subarray(0, 2).toString("latin1");
  const id = raw.subarray(2, 10);
  const signature = raw.subarray(10);
  if (!id.equals(expected.id)) {
    throw new Error(
      `${name}.sig was made with key ${[...id].reverse().map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()}, ` +
        `and the app checks against ${[...expected.id].reverse().map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()}.\n\n` +
        "The manifest is not written. A signature made with any other key is one\n" +
        "every installed copy refuses, however good it is — so this is not a\n" +
        "build to re-run but a signing secret to look at: either\n" +
        "`TAURI_SIGNING_PRIVATE_KEY` is not the key this app was built for, or\n" +
        "`plugins.updater.pubkey` in tauri.conf.json has moved and every copy\n" +
        "already out there is still checking against the old one.",
    );
  }
  if (!["ED", "Ed"].includes(alg)) {
    throw new Error(
      `${name}.sig says its algorithm is ${JSON.stringify(alg)}, which is neither of minisign's.\n` +
        "Nothing is published from a signature this cannot check. Re-run the leg\n" +
        "that produced it.",
    );
  }

  /* `ED` signs the digest, `Ed` signs the bytes. This is the whole of the
     pairing: the payload is the asset the entry's URL points at, so a
     signature that verifies here is a signature of what gets downloaded. */
  const signed = alg === "ED" ? createHash("blake2b512").update(payload).digest() : payload;
  if (!verify(null, signed, expected.key, signature)) {
    throw new Error(
      `${name}.sig is not a signature of ${name} (${payload.length} bytes on the release).\n\n` +
        "The manifest is not written. An entry whose signature does not verify\n" +
        "against its own payload is one every installed copy rejects: the update\n" +
        "is offered, the download runs, the signature check fails, and the person\n" +
        "is left on the build they already had with nothing they can do about\n" +
        "it. The usual causes are a signature left over from a previous build of\n" +
        "the same tag and an artifact replaced without its signature, and this\n" +
        "cannot tell which — so re-run the leg that produced the pair rather than\n" +
        "editing a manifest.",
    );
  }

  /* The trusted comment is trusted because of this line and not because of
     what it says. Nothing here reads it; an installed copy checks the same
     thing, so a signature failing it would be refused there too. */
  const trusted = Buffer.from(lines[2].slice(TRUSTED.length), "utf8");
  if (!verify(null, Buffer.concat([signature, trusted]), expected.key, Buffer.from(lines[3] ?? "", "base64"))) {
    throw new Error(
      `${name}.sig verifies over ${name}, and its trusted comment does not verify.\n\n` +
        "The manifest is not written. minisign signs that comment separately and\n" +
        "the updater checks both, so a copy of Firetower would refuse this\n" +
        "update even though the payload signature is good. Something has edited\n" +
        "the signature file after it was written; re-run the leg that produced\n" +
        "it rather than repairing it by hand.",
    );
  }
  return text.trim();
}

/**
 * The `.sig` files a job downloaded off the release, with the bytes they sign.
 *
 * One entry per `.sig`, because the signatures are still what says which
 * platforms finished — but each carries the artifact beside it, which is what
 * the signature then has to verify against. `payload` is a function rather
 * than the bytes: the AppImage alone is about ninety megabytes and there is no
 * reason for four payloads to be in memory at once.
 *
 * A signature whose artifact is not in the directory is refused here rather
 * than at the point of reading it, because the two mean different things — a
 * missing artifact is a release that is short an asset, not a bad signature.
 */
export function readAssets(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sig"))
    .map((f) => {
      const name = f.slice(0, -".sig".length);
      const path = join(dir, name);
      if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(
          `${name}.sig is on the release and ${name} is not.\n\n` +
            "The manifest is not written. A signature cannot be checked against a\n" +
            "payload that is not there, and publishing it unchecked is how an entry\n" +
            "every installed copy rejects gets written. Re-run the leg that\n" +
            "uploads it.",
        );
      }
      return { name, signature: readFileSync(join(dir, f), "utf8"), payload: () => readFileSync(path) };
    });
}

/**
 * The manifest, or an error naming what is missing.
 *
 * `assets` is `[{ name, signature, payload }]` — the artifact's own file name,
 * the contents of the `.sig` beside it, and a function returning the bytes the
 * signature has to verify against. `pubkey` is the boxed minisign public key
 * as `tauri.conf.json` carries it.
 */
export function manifest({ version, repo, tag, assets, pubkey, pubDate = new Date().toISOString() }) {
  const pub = publicKey(pubkey);
  const platforms = {};
  const missing = [];

  for (const want of WANTED) {
    const found = assets.filter((a) => want.matches(a.name));
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
    const [{ name, signature, payload }] = found;
    const entry = {
      signature: verifiedOrThrow(name, signature, payload(), pub),
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

/**
 * The key the app was built with, from the config it was built from.
 *
 * Read here rather than passed in: a manifest verified against some other key
 * is one every installed copy still refuses, so the only key worth checking
 * against is the one in `tauri.conf.json`.
 */
export function updaterPublicKey() {
  const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const pubkey = conf.plugins?.updater?.pubkey;
  if (!pubkey) throw new Error("tauri.conf.json has no plugins.updater.pubkey to verify signatures against.");
  return pubkey;
}

/* Run as a command, not when a test imports it for the functions above. */
const asCommand =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (asCommand) {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      tag: { type: "string" },
      version: { type: "string" },
      assets: { type: "string" },
      out: { type: "string", default: "latest.json" },
    },
  });
  for (const need of ["repo", "tag", "version", "assets"]) {
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
      assets: readAssets(values.assets),
      pubkey: updaterPublicKey(),
    });
  } catch (e) {
    console.error(`\nlatest-json.mjs: ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  }

  writeFileSync(values.out, `${JSON.stringify(written, null, 2)}\n`);
  console.log(`${values.out}: ${Object.keys(written.platforms).join(", ")}`);
}
