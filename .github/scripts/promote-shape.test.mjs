/**
 * What promotion has to keep being true.
 *
 * Promotion is four pointers across three systems with no transaction, made
 * safe by one rule: the channel manifest is written **last**, so until that
 * upload lands nothing has been promoted. Every property below is either that
 * rule or one of the things it depends on, and none of them fails on its own —
 * a run that moved two of three pointers and stopped looks exactly like a run
 * that refused, unless something asks what the readers can see.
 *
 * Two kinds of test here. The shape ones read the workflow as text, which can
 * say that a check is written somewhere; the ones below them run the real
 * scripts against a fake `gh` holding a fake registry, which is the only way
 * to ask the question that matters — after this, what does a reader see?
 *
 * Coarse instruments on purpose: nothing here parses YAML, because adding a
 * dependency to grep four jobs is a poor trade. Each therefore proves it found
 * its subject before believing anything about it. This is `release-shape`'s
 * approach, one level up.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const PROMOTE = read(".github/workflows/promote.yml");
const RELEASE = read(".github/workflows/release.yml");
const IMAGES = read(".github/workflows/images.yml");
const DESKTOP = read(".github/workflows/desktop-release.yml");

/**
 * A block with its comments taken out.
 *
 * These workflows carry most of their reasoning inline — including, in the
 * promotion job, a comment naming the very commands it must never use. An
 * assertion about what a job *does* has to read past what it *says*, or the
 * explanation of the trap would itself trip the check that guards it.
 */
const code = (block) => block.replace(/^\s*#.*$/gm, "");

/** One job's own lines: from `  <name>:` to wherever the next job starts. */
function job(workflow, name) {
  const lines = workflow.split("\n");
  const from = lines.indexOf(`  ${name}:`);
  if (from === -1) throw new Error(`no job called ${name} — this test is reading a file that moved`);
  const to = lines.findIndex((line, i) => i > from && /^ {2}\S/.test(line));
  return lines.slice(from, to === -1 ? undefined : to).join("\n");
}

describe("the tags a release writes", () => {
  it("moves beta on every release and never writes stable", () => {
    const meta = IMAGES.slice(IMAGES.indexOf("id: meta"), IMAGES.indexOf("build-push-action"));
    assert.match(meta, /type=raw,value=beta,enable=\$\{\{ inputs\.version != '' \}\}/);
    // `stable` is general access and is moved by promotion alone. A release
    // writing it would make general access a consequence of merging, which is
    // the whole thing this design exists to separate.
    assert.doesNotMatch(IMAGES, /value=stable/);
    assert.match(job(PROMOTE, "images"), /imagetools create -t "\$IMAGE:stable"/);
  });

  it("keeps publishing latest, which is not a channel", () => {
    // An earlier draft had the release stop tagging `latest`. It does not:
    // `latest` keeps its conventional meaning, the newest build published.
    // That `beta` and `latest` point at the same build is intended, and
    // deleting either as a simplification breaks whichever use it served.
    const meta = IMAGES.slice(IMAGES.indexOf("id: meta"), IMAGES.indexOf("build-push-action"));
    assert.match(meta, /type=raw,value=latest,enable=\$\{\{ inputs\.version != '' \}\}/);
  });
});

describe("the channel manifest on a release", () => {
  it("is written after the artifacts, and only for a package that published", () => {
    const channels = job(RELEASE, "channels");
    assert.match(channels, /needs: \[please, image, desktop\]/);
    // A manifest saying 0.57.0 is on beta when the image never pushed points
    // every beta installation at something that is not in the registry.
    assert.match(channels, /needs\.image\.result == 'success'/);
    assert.match(channels, /needs\.desktop\.result == 'success'/);
    assert.match(channels, /publish-channel-pin\.sh/);
  });

  it("writes beta pins and never a general one", () => {
    const channels = job(RELEASE, "channels");
    assert.match(channels, /control_plane:beta=/);
    assert.match(channels, /desktop:beta=/);
    assert.doesNotMatch(channels, /:general=/);
  });
});

describe("the promotion workflow", () => {
  it("takes a confirmation that has to match, and checks it before anything else", () => {
    // Promotion cannot be undone, and the refusals below are silent on the
    // accident that matters: promoting a *newer* version than intended passes
    // every one of them. A mis-click is what this answers, so it is answered
    // before a single network call.
    assert.match(PROMOTE, /^ {6}confirm:/m);
    const check = job(PROMOTE, "check");
    const confirm = check.indexOf('"$CONFIRM" != "$VERSION"');
    assert.ok(confirm > 0, "the confirmation is compared against the version");
    assert.ok(confirm < check.indexOf("gh release view"), "and before anything is looked up");
    assert.ok(confirm < check.indexOf("read-channel-manifest.sh"));
  });

  it("writes the channel manifest last, in a job of its own", () => {
    // The commit point. Everything before it can fail and leave the world
    // consistent; this is the line that promotes.
    const manifest = job(PROMOTE, "manifest");
    assert.match(manifest, /needs: \[check, images, desktop\]/);
    assert.match(manifest, /publish-channel-pin\.sh "\$PACKAGE:general=\$VERSION"/);
    // And nothing else in the workflow writes it, or "last" would mean
    // nothing.
    const elsewhere = PROMOTE.slice(0, PROMOTE.indexOf("\n  manifest:"));
    assert.doesNotMatch(elsewhere, /publish-channel-pin\.sh/);
    assert.doesNotMatch(elsewhere, /release upload/);
  });

  it("does not write the manifest when a leg that should have run failed", () => {
    const manifest = job(PROMOTE, "manifest");
    assert.match(manifest, /needs\.check\.result == 'success'/);
    assert.match(manifest, /inputs\.package != 'control_plane' \|\| needs\.images\.result == 'success'/);
    assert.match(manifest, /inputs\.package != 'desktop' \|\| needs\.desktop\.result == 'success'/);
  });

  it("moves the image pair together", () => {
    // Built together by `images.yml`, and the control plane checks its API
    // version against the updater's on every call. They cannot be on
    // different channels.
    const images = job(PROMOTE, "images");
    assert.match(images, /name: \[firetower, firetower-updater\]/);
  });

  it("rebuilds no image and re-signs no bundle", () => {
    // The promoted build is the tested build. A `docker build` or a
    // `tauri-action` in here would mean there is a general-access build in
    // which a new bug could appear.
    assert.doesNotMatch(code(PROMOTE), /build-push-action|docker build(?!x)|tauri-action/);
    assert.match(job(PROMOTE, "desktop"), /publish_only: true/);
    // And the legs that build are the ones that check it.
    assert.match(job(DESKTOP, "build"), /if: \$\{\{ !inputs\.publish_only \}\}/);
    assert.match(job(DESKTOP, "linux"), /if: \$\{\{ !inputs\.publish_only \}\}/);
  });

  it("cannot reach the signing material at all", () => {
    // Not just "the signing legs are skipped" — the call does not pass the
    // secrets down, so a promotion could not sign a bundle even if a future
    // edit un-skipped a leg. A release needs `secrets: inherit` for exactly
    // the jobs a promotion does not run.
    const desktop = code(job(PROMOTE, "desktop"));
    assert.doesNotMatch(desktop, /secrets:\s*inherit/);
    // The positive control, so this cannot pass by reading the wrong block:
    // the release that does need them says so.
    assert.match(job(RELEASE, "desktop"), /secrets: inherit/);
    // And nothing anywhere in the promotion names a signing secret.
    assert.doesNotMatch(code(PROMOTE), /APPLE_|AZURE_|TAURI_SIGNING/);
  });

  /**
   * The trap, asserted rather than only commented.
   *
   * `docker pull` + `docker tag` + `docker push` fetches only the runner's own
   * platform and republishes that single manifest in place of the index — and
   * it **exits 0**, reporting the loss as an informational line. The tag
   * moves, the manifest is written, nothing goes red, and the failure does not
   * surface until somebody on the other architecture pulls. A comment cannot
   * stop the next edit; this is the check that catches it.
   */
  it("re-tags the index rather than pulling and pushing it", () => {
    const images = code(job(PROMOTE, "images"));
    assert.match(images, /imagetools create/);
    assert.doesNotMatch(images, /docker push|docker pull|docker tag /);
  });

  it("proves the index came out at the digest it went in at", () => {
    // An unchanged index digest *is* the statement that every platform entry
    // and every attestation survived — there is no way to lose one and keep
    // the hash. It is also the evidence that promotion moves the tested bytes
    // rather than equivalent ones, which is the property the design rests on.
    const images = code(job(PROMOTE, "images"));
    const before = images.indexOf("before=$(docker buildx imagetools inspect");
    const create = images.indexOf("imagetools create");
    const compare = images.indexOf('"$after" != "$before"');
    assert.ok(before > 0 && create > before, "the digest is read before the re-tag");
    assert.ok(compare > create, "and compared after it");
    // The comparison has to fail the job, or it is a log line rather than a
    // check — and it has to fail it *before* the manifest write, which is
    // what the job boundary gives for free.
    assert.match(images.slice(compare), /exit 1/);
  });
});

/**
 * The refusals, run rather than read.
 *
 * Everything above can say that an `exit 1` is written somewhere. It cannot
 * say that a refusal leaves the pointers where they were — and that second
 * half is the requirement, because a run that fails after moving two of three
 * pointers has still refused and has still changed the world.
 *
 * So this takes the `check` job's script as the workflow actually runs it, and
 * runs it against a `gh` that holds a fake registry of releases and assets.
 * Then it asks the only question worth asking: afterwards, what does a reader
 * see?
 *
 * Not on Windows: these are `bash` steps on an Ubuntu runner.
 */
describe("promotion refuses, and moves nothing when it does", { skip: process.platform === "win32" }, () => {
  /** The `check` job's refusal script, dedented to run. */
  function refusals() {
    const check = job(PROMOTE, "check");
    const marker = "        run: |\n";
    const at = check.indexOf(marker);
    if (at === -1) throw new Error("the check job no longer has a `run: |` — this test is reading a file that moved");
    const body = check
      .slice(at + marker.length)
      .split("\n")
      .map((line) => line.replace(/^ {10}/, ""))
      .join("\n");
    const from = body.indexOf("set -euo pipefail");
    if (from === -1) throw new Error("the check script no longer opens with `set -euo pipefail`");
    // To the end of that step only — the telemetry step below it is a
    // separate `run:` and is not part of the gate.
    const to = body.indexOf("\n      - name:");
    return body.slice(from, to === -1 ? undefined : to);
  }

  /**
   * A `gh` standing in for the repository: releases are directories, assets
   * are files in them. Real enough that `read-channel-manifest.sh` and
   * `publish-channel-pin.sh` run unmodified against it, which is the point —
   * the scripts under test are the ones the workflow calls.
   */
  const GH = `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "api repos/"*)
    # releases/tags/<tag>
    tag="\${2##*/}"
    if [ -n "\${API_ERROR:-}" ]; then printf '%s\\n' "$API_ERROR" >&2; exit 1; fi
    if [ ! -d "$REGISTRY/$tag" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
    ls "$REGISTRY/$tag" | grep -c . || true
    exit 0 ;;
  "release view")
    [ -d "$REGISTRY/$3" ] || { echo "release not found (HTTP 404)" >&2; exit 1; }
    exit 0 ;;
  "release create")
    mkdir -p "$REGISTRY/$3"; exit 0 ;;
  "release download")
    tag="$3"
    if [ -n "\${DOWNLOAD_FAILS:-}" ]; then echo "HTTP 500" >&2; exit 1; fi
    out=""; pat=""
    shift 3
    while [ "$#" -gt 0 ]; do
      case "$1" in -D) out="$2"; shift 2 ;; -p) pat="$2"; shift 2 ;; *) shift ;; esac
    done
    [ -f "$REGISTRY/$tag/$pat" ] || { echo "no such asset" >&2; exit 1; }
    mkdir -p "$out"; cp "$REGISTRY/$tag/$pat" "$out/$pat"; exit 0 ;;
  "release upload")
    mkdir -p "$REGISTRY/$3"; cp "$4" "$REGISTRY/$3/"; exit 0 ;;
esac
exit 0
`;

  /**
   * A repository with `firetower-v*` releases and a published manifest, the
   * fake `gh` above on PATH, and the scripts the workflow calls.
   */
  function repository({ manifest, releases = ["firetower-v0.55.0", "firetower-v0.56.0", "firetower-v0.57.0", "firetower-v0.58.0"] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "promote-"));
    const registry = join(dir, "registry");
    for (const tag of releases) mkdirSync(join(registry, tag), { recursive: true });
    if (manifest !== undefined) {
      mkdirSync(join(registry, "channels"), { recursive: true });
      writeFileSync(join(registry, "channels", "channels.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    const gh = join(dir, "gh");
    writeFileSync(gh, GH);
    chmodSync(gh, 0o755);
    writeFileSync(join(dir, "gh.log"), "");
    return { dir, registry };
  }

  /** What a reader of the channel manifest sees right now. */
  const reader = ({ registry }) => {
    const at = join(registry, "channels", "channels.json");
    return existsSync(at) ? JSON.parse(readFileSync(at, "utf8")) : null;
  };

  /** Run the `check` gate for a package and version. */
  function check(repo, { package: pkg = "control_plane", version = "0.57.0", confirm, ...env } = {}) {
    const script = join(repo.dir, "check.sh");
    writeFileSync(script, refusals());
    writeFileSync(join(repo.dir, "outputs"), "");
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${repo.dir}:${process.env.PATH}`,
        GH_LOG: join(repo.dir, "gh.log"),
        REGISTRY: repo.registry,
        RUNNER_TEMP: repo.dir,
        GITHUB_OUTPUT: join(repo.dir, "outputs"),
        GITHUB_REPOSITORY: "firetower-cloud/firetower",
        PACKAGE: pkg,
        VERSION: version,
        CONFIRM: confirm ?? version,
        ...env,
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  /** Run the commit point — the manifest write promotion ends with. */
  function commit(repo, spec, env = {}) {
    const result = spawnSync("bash", [join(ROOT, ".github/scripts/publish-channel-pin.sh"), spec], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${repo.dir}:${process.env.PATH}`,
        GH_LOG: join(repo.dir, "gh.log"),
        REGISTRY: repo.registry,
        RUNNER_TEMP: join(repo.dir, "commit"),
        GITHUB_REPOSITORY: "firetower-cloud/firetower",
        ...env,
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  const published = {
    schema_version: 1,
    control_plane: { beta: "0.58.0", general: "0.55.0", general_promoted_at: "2026-10-01T00:00:00Z" },
    desktop: { beta: "0.21.0", general: "0.20.0", general_promoted_at: "2026-10-01T00:00:00Z" },
  };

  it("promotes a version that is published and on beta", () => {
    // The positive control. Without it every refusal below could pass on a
    // gate that refuses everything.
    const repo = repository({ manifest: published });
    assert.equal(check(repo).status, 0);
    assert.equal(commit(repo, "control_plane:general=0.57.0").status, 0);
    assert.equal(reader(repo).control_plane.general, "0.57.0");
    assert.equal(reader(repo).control_plane.beta, "0.58.0", "beta is left where it is");
  });

  it("refuses a confirmation that does not match, and looks nothing up", () => {
    const repo = repository({ manifest: published });
    const r = check(repo, { version: "0.57.0", confirm: "0.58.0" });
    assert.notEqual(r.status, 0);
    assert.match(r.output, /confirmation says '0\.58\.0' and the version says '0\.57\.0'/);
    assert.equal(reader(repo).control_plane.general, "0.55.0");
    // Nothing was even asked of the repository: the mis-click is answered
    // before the first network call.
    assert.equal(readFileSync(join(repo.dir, "gh.log"), "utf8").trim(), "");
  });

  it("refuses a version that is not three numeric parts", () => {
    // Caught here rather than further down, where it would be caught after the
    // tags had already moved and with an error naming the wrong thing.
    for (const version of ["0.57", "v0.57.0", "0.57.0.1", "latest", "0.57.x"]) {
      const repo = repository({ manifest: published });
      const r = check(repo, { version });
      assert.notEqual(r.status, 0, `${version} must be refused`);
      assert.match(r.output, /not a three-part version/, version);
      assert.equal(readFileSync(join(repo.dir, "gh.log"), "utf8").trim(), "", `${version}: nothing is looked up`);
    }
  });

  it("refuses a version older than general access holds", () => {
    // Published, so it gets past the check above and reaches this one: the
    // two refusals are separate and a test that conflated them would pass on
    // either.
    const repo = repository({ manifest: published, releases: ["firetower-v0.54.0", "firetower-v0.58.0"] });
    const r = check(repo, { version: "0.54.0" });
    assert.notEqual(r.status, 0);
    assert.match(r.output, /never moved backwards/);
    assert.equal(reader(repo).control_plane.general, "0.55.0");
  });

  it("refuses a version that is not published", () => {
    const repo = repository({ manifest: published });
    const r = check(repo, { version: "0.99.0" });
    assert.notEqual(r.status, 0);
    assert.match(r.output, /no firetower-v0\.99\.0 release/);
    assert.equal(reader(repo).control_plane.general, "0.55.0");
  });

  it("refuses a version beta does not have", () => {
    // Beta is continuous, so a version above the beta pin is one no release
    // ever put there. Published but ahead of beta is the case this catches.
    const repo = repository({ manifest: published, releases: ["firetower-v0.59.0"] });
    const r = check(repo, { version: "0.59.0" });
    assert.notEqual(r.status, 0);
    assert.match(r.output, /not a version beta has/);
    assert.equal(reader(repo).control_plane.general, "0.55.0");
  });

  /**
   * The finding `desktop-release.yml` was rewritten for, inherited here: a
   * read that went wrong used to be indistinguishable from "nothing is
   * published", which permitted the one thing the rule exists to prevent.
   */
  it("refuses when the manifest cannot be read, which is not the same as there not being one", () => {
    for (const API_ERROR of [
      "gh: API rate limit exceeded (HTTP 403)",
      "gh: Bad credentials (HTTP 401)",
      "error connecting to api.github.com",
      "gh: Server Error (HTTP 500)",
    ]) {
      const repo = repository({ manifest: published });
      const r = check(repo, { API_ERROR });
      assert.notEqual(r.status, 0, `${API_ERROR} must stop the run`);
      assert.match(r.output, /Could not read the published channel manifest/);
      assert.equal(reader(repo).control_plane.general, "0.55.0", `${API_ERROR} must move nothing`);
      // And the commit point refuses on its own account too, so a refusal
      // here is not the only thing standing between a failed read and a
      // promotion.
      const c = commit(repo, "control_plane:general=0.57.0", { API_ERROR });
      assert.notEqual(c.status, 0, `${API_ERROR} must stop the commit point too`);
      assert.equal(reader(repo).control_plane.general, "0.55.0");
    }
  });

  it("refuses when the manifest will not download", () => {
    const repo = repository({ manifest: published });
    const r = check(repo, { DOWNLOAD_FAILS: "1" });
    assert.notEqual(r.status, 0);
    assert.match(r.output, /would not download/);
    assert.equal(reader(repo).control_plane.general, "0.55.0");
  });

  it("refuses a manifest with nothing it understands in it", () => {
    for (const bad of [{}, { schema_version: 2 }, { schema_version: 1, control_plane: { general: "later" } }]) {
      const repo = repository({ manifest: bad });
      const c = commit(repo, "control_plane:general=0.57.0");
      assert.notEqual(c.status, 0, `${JSON.stringify(bad)} must stop the write`);
      // Unchanged, byte for byte: a document nobody understands is not one to
      // overwrite blind.
      assert.deepEqual(reader(repo), bad);
    }
  });

  /**
   * **The property the whole design rests on.**
   *
   * A promotion that gets as far as moving the tags and then fails has
   * promoted nothing, because the manifest is what every reader consults. And
   * because nothing was half-written, the run is simply repeated.
   */
  it("promotes nothing when it is interrupted before the manifest write, and the re-run succeeds", () => {
    const repo = repository({ manifest: published });

    // The run gets through its checks and through the re-tag, and then the
    // runner dies. Every pointer in the registry has moved; the manifest has
    // not been touched.
    assert.equal(check(repo).status, 0);
    assert.equal(reader(repo).control_plane.general, "0.55.0", "every reader is still on the previous version");
    assert.equal(reader(repo).control_plane.general_promoted_at, "2026-10-01T00:00:00Z");

    // Re-run, all the way through this time.
    assert.equal(check(repo).status, 0);
    const c = commit(repo, "control_plane:general=0.57.0");
    assert.equal(c.status, 0, c.output);
    assert.equal(reader(repo).control_plane.general, "0.57.0");

    // And a *third* run, because an interruption can also happen after the
    // write — the operator cannot tell, so re-running has to be safe either
    // way. The channel did not move again, so when it last moved is unchanged.
    const promotedAt = reader(repo).control_plane.general_promoted_at;
    assert.equal(check(repo).status, 0);
    assert.equal(commit(repo, "control_plane:general=0.57.0").status, 0);
    assert.equal(reader(repo).control_plane.general, "0.57.0");
    assert.equal(reader(repo).control_plane.general_promoted_at, promotedAt);
  });

  it("creates the manifest on a repository that has never had one", () => {
    const repo = repository();
    assert.equal(reader(repo), null);
    assert.equal(check(repo).status, 0, "absence is the bootstrap case, and only absence");
    assert.equal(commit(repo, "control_plane:general=0.57.0").status, 0);
    assert.equal(reader(repo).schema_version, 1);
    assert.equal(reader(repo).control_plane.general, "0.57.0");
  });
});
