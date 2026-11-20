#!/usr/bin/env node
/**
 * The channel manifest: one document naming the version each channel points
 * at, per package. Written by a release (the `beta` pin) and by a promotion
 * (the `general` pin), and read by every installation forever.
 *
 * This script is the *decision*: given the document that is currently
 * published and a set of pins to write, it produces the document to publish,
 * or it refuses. It does no network at all — the reading and the uploading are
 * `publish-channel-pin.sh`'s, which is where the three outcomes for a failed
 * read live. Split that way because the decision is the part worth unit
 * testing on documents, which is what `channel-manifest.test.mjs` does.
 *
 *   node channel-manifest.mjs pin --out <file> [--held <file>] \
 *        --set control_plane:beta=0.57.0 [--set desktop:general=0.21.0] \
 *        [--now 2026-11-18T12:00:00Z]
 *
 *   node channel-manifest.mjs preflight [--held <file>] --set control_plane:general=0.57.0
 *
 *   node channel-manifest.mjs read --held <file>
 *
 * `preflight` is `pin` without the write: same parser, same refusals, same
 * messages, no document produced. It exists so that a caller can ask "would
 * this be refused?" *before* it moves anything, and get the same answer the
 * commit point will give — rather than a second, looser copy of the rule in
 * shell. A gate that validated differently from the writer would be a gate
 * that passes things the writer then refuses, after the tags have moved.
 *
 * `read` is that same parser with nothing to decide: it prints the pins the
 * held document holds, in `preflight`'s own `held <package>.<channel>=<pin>`
 * lines, and writes nothing. It is here for the caller that does not yet know
 * which version it is asking about — a promotion given no version promotes
 * whatever the package's `beta` pin says, and a caller in that position cannot
 * name a `--set`, so it cannot ask `preflight`. Asking *here* rather than with
 * `jq` is the rule above for the reason above: `jq '// empty'` cannot tell a
 * missing pin from a `false` one, and a caller that is about to *default* to a
 * pin has to be told "this is not a document we understand" rather than handed
 * an empty string to promote.
 *
 * `read` requires `--held`, deliberately. Absence is a question with no answer
 * here: a document that does not exist holds no pins, so what absence means is
 * the caller's to decide before it asks — for a promotion it means the first
 * one, which has to name its version rather than default to nothing.
 *
 * `--held` absent means *there is no document yet* — the bootstrap case, and
 * the only absence that is allowed to be one. A caller that could not tell
 * absence from a failed read must not call this at all.
 *
 * Exit codes are distinct because the caller's log is the only place a person
 * sees them, and "it refused" and "it could not read it" are not the same
 * event:
 *
 *   0  a document was written to --out, or the question asked was answered
 *   2  the held document cannot be used — not JSON, no schema version, a
 *      schema this script does not understand, or a pin that is not a version.
 *      Stop and move nothing.
 *   3  a refusal: the pin would move backwards, or general would overtake
 *      beta. Stop and move nothing.
 *   64 the arguments are wrong.
 */
import { readFileSync, writeFileSync } from "node:fs";

/** The schema this script writes, and the highest one it will rewrite. */
export const SCHEMA_VERSION = 1;

/** The packages that have channels. Mobile is out of scope; see #407. */
export const PACKAGES = ["control_plane", "desktop"];

/** The two channels a pin can name. `edge` and `latest` are not channels. */
export const CHANNELS = ["beta", "general"];

/** A refusal or a bad document, carrying the exit code the caller should use. */
export class Refused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const stop = (message) => new Refused(2, message);
const refuse = (message) => new Refused(3, message);

/** Three numeric parts, which is what release-please cuts. */
const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Is `a` strictly newer than `b`? Numeric, part by part — `sort -V` is what
 * the desktop release's own guard uses and a string compare would read 0.10.0
 * as older than 0.9.0.
 */
export function newer(a, b) {
  const as = a.split(".").map(Number);
  const bs = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (as[i] !== bs[i]) return as[i] > bs[i];
  }
  return false;
}

/** The document for a package that has never had a pin written. */
const emptyPackage = () => ({ beta: null, general: null, general_promoted_at: null });

/**
 * The held document, checked.
 *
 * Inherited from the desktop release's rolling manifest, and binding on
 * everything that touches this document: no document yet is absence; a
 * document that reads is the answer; **anything else stops and moves
 * nothing.** A read that went wrong must never be allowed to look like
 * "general access is at version zero".
 *
 * `undefined` in, bootstrap out. Anything else in that is not a document this
 * script could have written throws, because the alternative is overwriting a
 * document whose contents nobody understands.
 */
export function parseHeld(text) {
  if (text === undefined) return { schema_version: SCHEMA_VERSION };

  let held;
  try {
    held = JSON.parse(text);
  } catch (e) {
    throw stop(`the published channel manifest is not JSON (${e.message}), so it is not being rewritten`);
  }
  if (held === null || typeof held !== "object" || Array.isArray(held)) {
    throw stop("the published channel manifest is not a JSON object, so it is not being rewritten");
  }
  // The one field whose omission cannot be corrected afterwards, which is why
  // it is in the minimum. A document without it is not one of ours.
  if (!Number.isInteger(held.schema_version) || held.schema_version < 1) {
    throw stop("the published channel manifest has no schema_version in it, so it is not being rewritten");
  }
  if (held.schema_version > SCHEMA_VERSION) {
    throw stop(
      `the published channel manifest is schema_version ${held.schema_version} and this workflow understands ${SCHEMA_VERSION}. ` +
        "It was written by a newer release than this one; nothing is being moved.",
    );
  }
  for (const pkg of PACKAGES) {
    if (!(pkg in held)) continue;
    const entry = held[pkg];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw stop(`the published channel manifest's ${pkg} is not an object, so it is not being rewritten`);
    }
    for (const channel of CHANNELS) {
      const pin = entry[channel];
      // Absent and null both mean "never set", which is a real state: nothing
      // has been promoted yet. A pin that is *present* and not a version is a
      // document nobody should overwrite blind.
      if (pin === undefined || pin === null) continue;
      if (typeof pin !== "string" || !VERSION.test(pin)) {
        throw stop(
          `the published channel manifest says ${pkg}.${channel} is ${JSON.stringify(pin)}, which is not a version. Nothing is being moved.`,
        );
      }
    }
  }
  return held;
}

/**
 * The held document with `pins` written into it, or a refusal.
 *
 * Everything not named by a pin is preserved verbatim, including keys this
 * script has never heard of: a document read by every installation forever is
 * one a later release may have added a field to, and dropping it here would
 * un-publish that field for everybody.
 */
export function pin(held, pins, now) {
  const next = structuredClone(held);
  next.schema_version = SCHEMA_VERSION;
  const moved = [];

  for (const { package: pkg, channel, version } of pins) {
    if (!PACKAGES.includes(pkg)) throw new Refused(64, `${pkg} is not a package with channels (${PACKAGES.join(", ")})`);
    if (!CHANNELS.includes(channel)) throw new Refused(64, `${channel} is not a channel (${CHANNELS.join(", ")})`);
    if (!VERSION.test(version)) throw new Refused(64, `${version} is not a three-part version`);

    const entry = { ...emptyPackage(), ...(next[pkg] ?? {}) };
    const was = entry[channel] ?? null;

    // Never backwards, **per channel**. It has to be per channel: beta is
    // legitimately and permanently ahead of general access, so a guard
    // spanning both would read every promotion as a downgrade and refuse
    // forever. Within one channel the rule is the desktop release's, for the
    // same reason — this document is the one address every installation
    // reads, and moving a pin back is a silent downgrade of all of them.
    if (was !== null && newer(was, version)) {
      throw refuse(
        `${pkg} is on ${was} on ${channel}, which is newer than ${version}. ` +
          "A channel pin is never moved backwards; nothing has been changed.",
      );
    }

    // General access can only point at something beta has. Beta is continuous
    // — every released version is on it — so a general pin ahead of the beta
    // pin means the version is not released at all, which is the
    // "not published, or not on beta" refusal expressed against the document
    // rather than against the registry.
    if (channel === "general") {
      const beta = entry.beta ?? null;
      if (beta !== null && newer(version, beta)) {
        throw refuse(
          `${pkg} is on ${beta} on beta, so ${version} is not a version beta has. ` +
            "General access cannot be moved ahead of beta; nothing has been changed.",
        );
      }
    }

    if (was === version) {
      // A re-run after a partial failure. Idempotent on purpose, timestamp
      // included: the channel did not move, so when it last moved has not
      // changed either.
      next[pkg] = entry;
      continue;
    }

    entry[channel] = version;
    if (channel === "general") entry.general_promoted_at = now;
    next[pkg] = entry;
    moved.push(`${pkg} ${channel}: ${was ?? "nothing"} → ${version}`);
  }

  return { manifest: next, moved };
}

/**
 * What is published, as the shared parser read it — not as `jq` guessed it.
 * `jq '// empty'` cannot tell a missing pin from a `false` one, and a caller
 * that cannot tell those apart treats a document it does not understand as
 * "nothing is pinned yet".
 *
 * One line per channel, including the ones that hold nothing, so a caller can
 * tell "this package has no beta pin" from "this package is not in the
 * document" without a second question.
 */
function sayHeld(held) {
  for (const pkg of PACKAGES) {
    const entry = held[pkg];
    if (!entry) continue;
    for (const channel of CHANNELS) {
      console.log(`held ${pkg}.${channel}=${entry[channel] ?? ""}`);
    }
  }
}

/** `control_plane:beta=0.57.0` */
function parseSet(text) {
  const match = /^([a-z_]+):([a-z]+)=(.+)$/.exec(text);
  if (!match) throw new Refused(64, `--set wants <package>:<channel>=<version>, not ${JSON.stringify(text)}`);
  return { package: match[1], channel: match[2], version: match[3] };
}

function main(argv) {
  const command = argv[0];
  if (command !== "pin" && command !== "preflight" && command !== "read") {
    throw new Refused(64, "the commands are `pin`, `preflight` and `read`");
  }
  const args = argv.slice(1);
  const pins = [];
  let out;
  let heldPath;
  let now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  for (let i = 0; i < args.length; i += 1) {
    const value = args[i + 1];
    switch (args[i]) {
      case "--set":
        pins.push(parseSet(value));
        i += 1;
        break;
      case "--out":
        out = value;
        i += 1;
        break;
      case "--held":
        heldPath = value;
        i += 1;
        break;
      case "--now":
        now = value;
        i += 1;
        break;
      default:
        throw new Refused(64, `unknown argument ${args[i]}`);
    }
  }
  if (command === "pin" && !out) throw new Refused(64, "--out is required");
  if (command === "read") {
    // Nothing is decided here, so there is nothing to decide it from: a
    // `--set` would be a pin nobody asked to write, and the caller is asking
    // what is held precisely because it does not have a version yet.
    if (pins.length > 0) throw new Refused(64, "`read` answers what is held and writes nothing, so it takes no --set");
    if (heldPath === undefined) throw new Refused(64, "--held is required: a document that does not exist holds no pins");
    sayHeld(parseHeld(readFileSync(heldPath, "utf8")));
    return;
  }
  if (pins.length === 0) throw new Refused(64, "at least one --set is required");

  const held = parseHeld(heldPath === undefined ? undefined : readFileSync(heldPath, "utf8"));
  const { manifest, moved } = pin(held, pins, now);

  if (command === "preflight") {
    // The same lines `read` prints, from the same parser — one format, so a
    // caller that asks both questions parses one answer.
    sayHeld(held);
    for (const line of moved) console.log(`would move ${line}`);
    if (moved.length === 0) console.log("would move nothing; it is already where it was asked to be");
    return;
  }

  // A trailing newline, so the asset is a well-formed text file and a diff of
  // two downloaded copies reads cleanly.
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const line of moved) console.log(`  ${line}`);
  if (moved.length === 0) console.log("  already where it was asked to be; the document is unchanged");
}

// Not when imported by the tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Refused ? e.message : `${e}`);
    process.exit(e instanceof Refused ? e.code : 1);
  }
}
