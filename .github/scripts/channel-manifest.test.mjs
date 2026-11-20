/**
 * The channel manifest's decision, on documents rather than on a network.
 *
 * This document is read by every installation forever and is the commit point
 * of every promotion, so what matters is not that the happy path works but
 * that each way of going wrong is told apart from the others. A read that went
 * wrong must never be allowed to look like "general access is at version
 * zero", and that is a property of this file's refusals rather than of
 * anything a successful run does.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Refused, newer, parseHeld, pin } from "./channel-manifest.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "channel-manifest.mjs");

const NOW = "2026-11-18T12:00:00Z";
const held = (doc) => parseHeld(JSON.stringify(doc));
const one = (doc, spec, now = NOW) => {
  const [pkg, rest] = spec.split(":");
  const [channel, version] = rest.split("=");
  return pin(doc, [{ package: pkg, channel, version }], now);
};
/** The code a call refused with, or `null` if it did not refuse. */
const refusal = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    return { code: e.code, message: e.message };
  }
};

describe("reading what is published", () => {
  it("treats no document at all as the bootstrap, and only that", () => {
    assert.deepEqual(parseHeld(undefined), { schema_version: 1 });
  });

  it("reads a document it wrote", () => {
    const doc = {
      schema_version: 1,
      control_plane: { beta: "0.57.0", general: "0.55.0", general_promoted_at: NOW },
      desktop: { beta: "0.21.0", general: null, general_promoted_at: null },
    };
    assert.deepEqual(held(doc), doc);
  });

  /**
   * The findings this file exists for. Every one of these would, if it fell
   * through to "no pin held", let a promotion write whatever it was asked to
   * write — which is the one thing the never-backwards rule is there to stop.
   */
  it("stops on a document that is not one of ours, and says which way it was wrong", () => {
    const cases = [
      ["<!DOCTYPE html>", /not JSON/],
      ["", /not JSON/],
      ["[]", /not a JSON object/],
      ["null", /not a JSON object/],
      ['{"control_plane":{"beta":"0.57.0"}}', /no schema_version/],
      ['{"schema_version":"1"}', /no schema_version/],
      ['{"schema_version":0}', /no schema_version/],
      ['{"schema_version":2}', /newer release than this one/],
      ['{"schema_version":1,"control_plane":"0.57.0"}', /control_plane is not an object/],
      ['{"schema_version":1,"control_plane":{"beta":57}}', /not a version/],
      ['{"schema_version":1,"desktop":{"general":"v0.21.0"}}', /not a version/],
    ];
    for (const [text, says] of cases) {
      const r = refusal(() => parseHeld(text));
      assert.ok(r, `${text} must not read as a usable document`);
      assert.equal(r.code, 2, `${text}: stopping and refusing are different events`);
      assert.match(r.message, says, text);
      assert.match(r.message, /(not being (rewritten|moved)|nothing is being moved)/i, `${text}: it has to say nothing moved`);
    }
  });

  it("tells a pin that was never set apart from one that is unreadable", () => {
    // Nothing has been promoted yet. A real state, and not an error — the
    // first promotion is exactly this.
    for (const text of ['{"schema_version":1,"control_plane":{"beta":"0.57.0","general":null}}', '{"schema_version":1,"control_plane":{"beta":"0.57.0"}}']) {
      const doc = parseHeld(text);
      assert.equal(one(doc, "control_plane:general=0.57.0").manifest.control_plane.general, "0.57.0");
    }
  });
});

describe("comparing versions", () => {
  it("compares the numbers and not the characters", () => {
    // The one that bites: as strings, "0.9.0" sorts after "0.10.0".
    assert.equal(newer("0.10.0", "0.9.0"), true);
    assert.equal(newer("0.9.0", "0.10.0"), false);
    assert.equal(newer("1.0.0", "0.99.99"), true);
    assert.equal(newer("0.57.0", "0.57.0"), false);
    assert.equal(newer("0.57.1", "0.57.0"), true);
  });
});

describe("putting a released version on beta", () => {
  it("writes the beta pin and leaves general access alone", () => {
    const doc = held({
      schema_version: 1,
      control_plane: { beta: "0.56.0", general: "0.55.0", general_promoted_at: "2026-10-01T00:00:00Z" },
    });
    const { manifest } = one(doc, "control_plane:beta=0.57.0");
    assert.equal(manifest.control_plane.beta, "0.57.0");
    // The whole of the design in one assertion: a release reaches beta and
    // nothing else, and general access moves only when somebody promotes.
    assert.equal(manifest.control_plane.general, "0.55.0");
    assert.equal(manifest.control_plane.general_promoted_at, "2026-10-01T00:00:00Z");
  });

  it("introduces a package it has never seen without disturbing the other", () => {
    const doc = held({ schema_version: 1, control_plane: { beta: "0.57.0", general: "0.55.0", general_promoted_at: NOW } });
    const { manifest } = one(doc, "desktop:beta=0.21.0");
    assert.deepEqual(manifest.desktop, { beta: "0.21.0", general: null, general_promoted_at: null });
    assert.equal(manifest.control_plane.general, "0.55.0");
  });

  it("writes both packages in one document when both released", () => {
    const { manifest, moved } = pin(
      parseHeld(undefined),
      [
        { package: "control_plane", channel: "beta", version: "0.57.0" },
        { package: "desktop", channel: "beta", version: "0.21.0" },
      ],
      NOW,
    );
    assert.equal(manifest.control_plane.beta, "0.57.0");
    assert.equal(manifest.desktop.beta, "0.21.0");
    assert.equal(manifest.schema_version, 1);
    assert.equal(moved.length, 2);
  });

  it("keeps a field a later release added that this one knows nothing about", () => {
    // Every installation reads this document forever, including ones newer
    // than whatever wrote it last. Dropping an unknown key here would
    // un-publish it for all of them.
    const doc = held({
      schema_version: 1,
      control_plane: { beta: "0.56.0", general: "0.55.0", general_promoted_at: NOW, minimum_cli: "0.9.0" },
      mobile: { beta: "0.4.0" },
    });
    const { manifest } = one(doc, "control_plane:beta=0.57.0");
    assert.equal(manifest.control_plane.minimum_cli, "0.9.0");
    assert.deepEqual(manifest.mobile, { beta: "0.4.0" });
  });
});

describe("promoting", () => {
  const published = held({
    schema_version: 1,
    control_plane: { beta: "0.58.0", general: "0.55.0", general_promoted_at: "2026-10-01T00:00:00Z" },
    desktop: { beta: "0.21.0", general: "0.20.0", general_promoted_at: "2026-10-01T00:00:00Z" },
  });

  it("moves the general pin and records when it moved", () => {
    const { manifest, moved } = one(published, "control_plane:general=0.57.0");
    assert.equal(manifest.control_plane.general, "0.57.0");
    assert.equal(manifest.control_plane.general_promoted_at, NOW);
    // Beta is untouched: it is permanently ahead and that is not a problem to
    // be corrected.
    assert.equal(manifest.control_plane.beta, "0.58.0");
    assert.deepEqual(moved, ["control_plane general: 0.55.0 → 0.57.0"]);
  });

  it("skips versions, because general access routinely does", () => {
    // 0.56.0 and 0.57.0 are never promoted. That is normal rather than
    // exceptional, which is why promotion names a version instead of stepping.
    const { manifest } = one(published, "control_plane:general=0.58.0");
    assert.equal(manifest.control_plane.general, "0.58.0");
  });

  it("promotes one package without naming a version for the other", () => {
    // The packages release separately, so a desktop-only release has no
    // control-plane version to promote. A single pin could not say that.
    const { manifest } = one(published, "desktop:general=0.21.0");
    assert.equal(manifest.desktop.general, "0.21.0");
    assert.equal(manifest.control_plane.general, "0.55.0");
    assert.equal(manifest.control_plane.general_promoted_at, "2026-10-01T00:00:00Z");
  });

  it("refuses a version older than the channel holds, and moves nothing", () => {
    const r = refusal(() => one(published, "control_plane:general=0.54.0"));
    assert.equal(r.code, 3);
    assert.match(r.message, /on 0\.55\.0 on general, which is newer than 0\.54\.0/);
    assert.match(r.message, /nothing has been changed/i);
    // The document it was given is untouched — `pin` never mutates its input,
    // which is what makes "it refused" and "it moved nothing" the same event.
    assert.equal(published.control_plane.general, "0.55.0");
  });

  it("refuses a version beta does not have", () => {
    // Beta is continuous, so a version above the beta pin is one that is not
    // released at all. This is the "not published, or not on beta" refusal,
    // asked of the document rather than of the registry.
    const r = refusal(() => one(published, "control_plane:general=0.59.0"));
    assert.equal(r.code, 3);
    assert.match(r.message, /0\.58\.0 on beta, so 0\.59\.0 is not a version beta has/);
  });

  it("is a no-op when general access is already there, timestamp included", () => {
    // The re-run of a promotion that was interrupted after the tags moved and
    // before the manifest write. It has to succeed, and it has to leave the
    // record of when the channel actually moved alone: it did not move again.
    const after = one(published, "control_plane:general=0.55.0", "2027-01-01T00:00:00Z");
    assert.equal(after.manifest.control_plane.general, "0.55.0");
    assert.equal(after.manifest.control_plane.general_promoted_at, "2026-10-01T00:00:00Z");
    assert.deepEqual(after.moved, []);
  });

  it("never moves beta backwards either", () => {
    // Not a case a release produces on its own, but a re-dispatched build of
    // an older tag would — and beta is an address operators pin.
    const r = refusal(() => one(published, "control_plane:beta=0.57.0"));
    assert.equal(r.code, 3);
    assert.match(r.message, /0\.58\.0 on beta, which is newer than 0\.57\.0/);
  });

  it("refuses a package, channel or version it does not recognise", () => {
    for (const spec of ["mobile:general=0.4.0", "control_plane:stable=0.57.0", "control_plane:latest=0.57.0", "control_plane:general=v0.57.0", "control_plane:general=0.57"]) {
      const r = refusal(() => one(published, spec));
      assert.ok(r, `${spec} must be refused`);
      assert.equal(r.code, 64, spec);
    }
  });
});

/**
 * **`read`, which is the command a caller with no version yet has to use.**
 *
 * A promotion dispatched without a version promotes whatever the package is on
 * beta, which means something has to hand it that pin. These run the command
 * line rather than the function, because the contract the workflow depends on
 * is the command line: the exact `held <package>.<channel>=<pin>` lines it
 * prints, and the exit codes it prints them instead of.
 *
 * The refusals are the point. A caller that is about to *default* to a pin has
 * to be told "this document is not one we understand" — handed an empty string
 * instead, it would promote nothing while the run it belongs to acted as
 * though it had promoted something.
 */
describe("reading the pins out of what is published", () => {
  /** The command line, against a document written to a file. */
  function cli(args, document) {
    const dir = mkdtempSync(join(tmpdir(), "channels-"));
    const at = join(dir, "held.json");
    if (document !== undefined) writeFileSync(at, typeof document === "string" ? document : `${JSON.stringify(document)}\n`);
    const r = spawnSync("node", [SCRIPT, ...args.map((a) => (a === "@held" ? at : a))], { encoding: "utf8" });
    return { status: r.status, out: r.stdout, err: r.stderr };
  }

  const published = {
    schema_version: 1,
    control_plane: { beta: "0.58.0", general: "0.55.0", general_promoted_at: NOW },
    desktop: { beta: "0.21.0", general: null, general_promoted_at: null },
  };

  it("prints one line per channel, for every package in the document", () => {
    const r = cli(["read", "--held", "@held"], published);
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.out.trimEnd().split("\n"), [
      "held control_plane.beta=0.58.0",
      "held control_plane.general=0.55.0",
      "held desktop.beta=0.21.0",
      // A pin that was never set is an empty value rather than a missing
      // line, so "this package has no beta pin" is answerable without a
      // second question — which is the case a first promotion of one package
      // on a document the other package wrote is in.
      "held desktop.general=",
    ]);
  });

  it("prints the same lines preflight does, so one format is parsed", () => {
    const read = cli(["read", "--held", "@held"], published);
    const preflight = cli(["preflight", "--held", "@held", "--set", "control_plane:general=0.57.0"], published);
    assert.equal(preflight.status, 0, preflight.err);
    const held = preflight.out.split("\n").filter((line) => line.startsWith("held "));
    assert.deepEqual(read.out.trimEnd().split("\n"), held);
  });

  it("stops on a document it does not understand, rather than printing nothing", () => {
    // Every one of these read as "nothing is pinned yet" to the `jq` this
    // replaced, which is the state a promotion is allowed to write anything
    // from. Exit 2, so the caller's log says it could not be used rather than
    // that it was refused.
    for (const bad of ["{}", '{"schema_version":2}', '{"schema_version":1,"control_plane":{"beta":false}}', "<!DOCTYPE html>", ""]) {
      const r = cli(["read", "--held", "@held"], bad);
      assert.equal(r.status, 2, `${bad} must stop the caller: ${r.out}${r.err}`);
      assert.equal(r.out, "", `${bad} must print no pins`);
      assert.match(r.err, /(not being (rewritten|moved)|nothing is being moved)/i, bad);
    }
  });

  it("refuses to be asked about a document that does not exist", () => {
    // Absence is a question with no answer here: there is no pin in a
    // document that was never published, so what absence means is the
    // caller's to decide before it asks. For a promotion it means the first
    // one, which has to name its version.
    const r = cli(["read"], undefined);
    assert.equal(r.status, 64);
    assert.match(r.err, /--held is required/);
  });

  it("refuses a --set, because it decides nothing and writes nothing", () => {
    const r = cli(["read", "--held", "@held", "--set", "control_plane:general=0.57.0"], published);
    assert.equal(r.status, 64);
    assert.match(r.err, /takes no --set/);
  });

  it("still says what the commands are when it is given something else", () => {
    const r = cli(["peek", "--held", "@held"], published);
    assert.equal(r.status, 64);
    assert.match(r.err, /`pin`, `preflight` and `read`/);
  });
});
