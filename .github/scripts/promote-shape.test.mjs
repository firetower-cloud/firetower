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
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
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
  # releases/tags/<tag> — answers with the asset names on it, which is what
  # the reader asks for: it has to tell "no manifest was ever here" from
  # "the manifest that was here is gone".
  tag="\${2##*/}"
  if [ -n "\${API_ERROR:-}" ]; then printf '%s\\n' "$API_ERROR" >&2; exit 1; fi
  if [ ! -d "$REGISTRY/$tag" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
  ls -1 "$REGISTRY/$tag" 2>/dev/null || true
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
"release edit")
  # The notes are what a person reads on the release page to find out what
  # the one-liner is about to install, so they are part of the behaviour and
  # not decoration. Recorded as a dotfile, so the asset listing above keeps
  # seeing only assets.
  tag="$3"
  mkdir -p "$REGISTRY/$tag"
  shift 3
  while [ "$#" -gt 0 ]; do
    case "$1" in --notes) printf '%s' "$2" > "$REGISTRY/$tag/.notes"; shift 2 ;; *) shift ;; esac
  done
  exit 0 ;;
"release upload")
  mkdir -p "$REGISTRY/$3"
  # --clobber deletes before it uploads. The real one does, so this does
  # too: the window between the two is a finding.
  rm -f "$REGISTRY/$3/$(basename "$4")"
  if [ -n "\${FAIL_UPLOAD:-}" ] && [ "$(basename "$4")" = "$FAIL_UPLOAD" ]; then
    echo 'injected upload failure, after the delete' >&2; exit 1
  fi
  cp "$4" "$REGISTRY/$3/"
  # An upload that exits 0 having stored something other than what it was
  # given. Nothing goes red at the call site, which is what makes reading the
  # published copy back the only way to find out.
  if [ -n "\${CORRUPT_UPLOAD:-}" ] && [ "$(basename "$4")" = "$CORRUPT_UPLOAD" ]; then
    printf 'x' >> "$REGISTRY/$3/$(basename "$4")"
  fi
  exit 0 ;;
esac
exit 0
`;

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

  /**
   * **Each package's last write is the one its own readers consult.**
   *
   * There is no single commit point across both packages. The control plane's
   * readers consult the channel manifest, so it goes last. The desktop's
   * readers consult `desktop-stable` and `desktop-latest` — Tauri installs
   * whatever is there if the version is greater, with no second opinion — so
   * for the desktop the manifest goes *first* and the addresses last.
   *
   * Getting the desktop the other way round was a real defect: an interruption
   * in between left every general-access copy upgrading on its next check
   * while the document said they had not been promoted, and **re-running
   * completed the promotion but could not repair it**, because the installs
   * had already happened.
   */
  it("writes the control plane's pin after its images", () => {
    const pin = job(PROMOTE, "pin_last");
    assert.match(pin, /needs: \[check, images\]/);
    assert.match(pin, /inputs\.package == 'control_plane'/);
    assert.match(pin, /publish-channel-pin\.sh "\$PACKAGE:general=\$VERSION"/);
  });

  it("writes the desktop's pin before its live addresses", () => {
    const pin = job(PROMOTE, "pin_first");
    assert.match(pin, /needs: check/);
    assert.match(pin, /inputs\.package == 'desktop'/);
    assert.match(pin, /publish-channel-pin\.sh "\$PACKAGE:general=\$VERSION"/);
    // And the job that writes those addresses waits for it.
    assert.match(job(PROMOTE, "desktop"), /needs: \[check, pin_first\]/);
  });

  it("has exactly two writers of the channel manifest, one per package", () => {
    // Two jobs, mutually exclusive by package, so "last" and "first" each mean
    // something. A third would make both claims false.
    const writers = [...PROMOTE.matchAll(/publish-channel-pin\.sh/g)];
    assert.equal(writers.length, 2, "one writer per package and no more");
    assert.match(job(PROMOTE, "pin_first"), /if: inputs\.package == 'desktop'/);
    assert.match(job(PROMOTE, "pin_last"), /if: inputs\.package == 'control_plane'/);
  });

  /**
   * **The rolling worker release, which is the hand-run install's pointer.**
   *
   * `usefiretower.com/worker.sh` redirects to `worker-latest`, so that release
   * decides what `curl -fsSL … | sh` installs — the recommended line in the
   * install documentation. It was moved by every release, which meant "the
   * newest build": true while there was one channel, and false from the moment
   * the channels diverged, when it would start handing a *beta* worker to
   * somebody on a general-access control plane, which refuses it. #459, and the
   * same defect as #454 in a second place.
   *
   * So it follows general access and only a promotion moves it. The two things
   * that have to stay true are that a release does not touch it, and that it is
   * written after the pin rather than before — ahead of the pin it hands out a
   * worker the control plane refuses; behind it, one the control plane replaces
   * over the connection it already holds.
   */
  it("moves the rolling worker release, which a release no longer does", () => {
    const worker = job(PROMOTE, "worker");
    assert.match(worker, /inputs\.package == 'control_plane'/);
    assert.match(worker, /publish-worker-rolling\.sh "\$VERSION"/);
    // And a release has nothing to say about it any more. Scoped to the job
    // that used to write it, so the test names the thing it is about.
    const published = code(job(RELEASE, "worker-release"));
    assert.doesNotMatch(published, /worker-latest/, "a release must not move the rolling release");
    assert.equal([...code(RELEASE).matchAll(/worker-latest/g)].length, 0);
  });

  it("writes the rolling worker release after the pin, never before it", () => {
    // Not tidiness, and worth asserting for that reason: the two orderings look
    // equally arbitrary to a reader who has not thought about which way the
    // window fails. After the pin, an interruption leaves the rolling release
    // *behind* general access — a hand-run install gets an older worker and the
    // control plane upgrades it on the first connection. Before the pin, the
    // window inverts into the refusal this whole change exists to prevent.
    const worker = job(PROMOTE, "worker");
    assert.match(worker, /needs: \[check, pin_last\]/);
    // And the script refuses on its own account if the pin is not already
    // there, so a rerun of this job alone cannot get ahead either.
    const script = read(".github/scripts/publish-worker-rolling.sh");
    assert.match(script, /read-channel-manifest\.sh/);
    assert.match(script, /channel-manifest\.mjs" preflight/);
  });

  it("ends by running the published one-liner, unpinned", () => {
    // `release.yml` has ended this way since before channels existed — the
    // whole chain, before anybody is told the release exists. It moved here
    // with the release it resolves to, because a check that passes
    // `--version` would prove the versioned release works and say nothing
    // about what the unpinned line gets, which is the entire defect. #388's
    // pattern: a check that passes without exercising what it claims.
    const worker = job(PROMOTE, "worker");
    const at = worker.indexOf("the published one-liner installs the promoted worker");
    assert.ok(at > 0, "promotion installs from the published script");
    const step = code(worker.slice(at));
    assert.match(step, /releases\/download\/worker-latest\/worker\.sh/);
    assert.match(step, /\| sh -s -- --skip-packages/);
    assert.doesNotMatch(step, /--version "?\$VERSION/, "pinning it would test the wrong path");
    // It is an assertion and not a smoke run: the binary has to report the
    // version that was just promoted.
    assert.match(step, /firetower-worker" --version/);
    assert.match(step, /\*"\$VERSION"\*/);
    // And after the release it is asserting about, or it would be asserting
    // about the previous one.
    assert.ok(at > worker.indexOf("publish-worker-rolling.sh"));
  });

  it("keeps a release proving its own published install path", () => {
    // Moving the rolling release's check here must not leave a release with
    // no end-to-end check at all. It still installs from a published script on
    // a published release and runs the binary — the pinned path now, which is
    // the one the control plane's authorize command uses.
    const published = code(job(RELEASE, "worker-release"));
    assert.match(published, /releases\/download\/\$TAG\/worker\.sh/);
    assert.match(published, /--version "\$VERSION" --skip-packages/);
    assert.match(published, /firetower-worker" --version/);
    assert.match(published, /releases\/download\/\$TAG\/install\.sh/);
    assert.match(published, /firetower --version/);
  });

  it("reports success only when this package's whole order finished", () => {
    const done = job(PROMOTE, "promoted");
    assert.match(done, /needs\.check\.result == 'success'/);
    assert.match(done, /needs\.images\.result == 'success' && needs\.pin_last\.result == 'success'/);
    // Including the rolling worker release: a promotion whose one-liner is
    // stale is not one to report as finished.
    assert.match(done, /needs\.worker\.result == 'success'/);
    assert.match(done, /needs\.pin_first\.result == 'success' && needs\.desktop\.result == 'success'/);
    // Hyphens in a job id would be read as subtraction in these expressions.
    assert.doesNotMatch(code(PROMOTE), /needs\.[a-z_]+-[a-z]/);
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

  it("is the only route to the desktop's general-access addresses", () => {
    // Dispatching `desktop-release.yml` with channel=general published
    // `desktop-stable` and `desktop-latest` — the two addresses every copy on
    // general access reads — with no typed confirmation, no check that the
    // version is on beta, and no channel-manifest write. Reproduced: it
    // published 0.60.0 to both while the manifest said beta 0.59.0.
    const dispatch = DESKTOP.slice(DESKTOP.indexOf("workflow_dispatch:"), DESKTOP.indexOf("\npermissions:"));
    assert.match(dispatch, /options: \[beta\]/, "general access is not offered as a dispatch option");

    // The option list is a courtesy; the event check is the rule, because
    // dispatch and call share one `inputs` context.
    const publish = job(DESKTOP, "publish");
    assert.match(publish, /github\.event_name \}\}" != workflow_call/);
    // And signing is never the same run as general access.
    assert.match(publish, /PUBLISH_ONLY" != true/);
    // The guard runs before anything is downloaded or written.
    assert.ok(
      publish.indexOf("comes from promotion and from nowhere else") < publish.indexOf("gh release download"),
      "the guard is before the first thing the job does",
    );
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

  it("checks a staging tag and only then writes :stable, by digest", () => {
    // The checks used to run *after* `:stable` had been written, so a
    // flattening left the one tag every general-access installation pulls as a
    // single-architecture index, and the job failed with an error that never
    // said the live pointer was now broken. Asserting after the fact is a
    // post-mortem, not a guard.
    const images = code(job(PROMOTE, "images"));
    const stage = images.indexOf('imagetools create -t "$IMAGE:$STAGING"');
    const checkDigest = images.indexOf('"$staged" != "$before"');
    const checkPlatforms = images.indexOf("for want in linux/amd64 linux/arm64");
    const writeStable = images.indexOf('imagetools create -t "$IMAGE:stable"');

    assert.ok(stage > 0, "the index is written to a staging tag first");
    assert.ok(writeStable > 0, "and then to :stable");
    assert.ok(checkDigest > stage && checkDigest < writeStable, "the digest is checked in between");
    assert.ok(checkPlatforms > stage && checkPlatforms < writeStable, "and so are the platforms");
    // By digest, so nothing can have moved under it between the check and the
    // write. A tag could; a digest cannot.
    assert.match(images.slice(writeStable, writeStable + 120), /\$IMAGE@\$DIGEST/);
    // And the staging tag is not a channel, or it would be read by somebody.
    assert.doesNotMatch(code(read("deploy/firetower.yml")), /promote-/);
  });

  it("names both architectures rather than counting entries", () => {
    // Counting would pass an index that had somehow acquired two of the same
    // platform, and it is the two names the installations actually need.
    const images = code(job(PROMOTE, "images"));
    assert.match(images, /for want in linux\/amd64 linux\/arm64/);
    assert.doesNotMatch(images, /tr -cd ,/);
  });

  it("says where the staged index is when it refuses", () => {
    // Evidence that exists and is not named is the same failure as recovery
    // that exists and is not named.
    const images = code(job(PROMOTE, "images"));
    for (const refusal of images.split("::error::").slice(1)) {
      assert.match(refusal, /\$STAGING|\$DIGEST/, `a refusal that names neither: ${refusal.slice(0, 120)}`);
    }
  });

  it("never deletes anything from the registry", () => {
    // GHCR has no delete-a-tag call. The only deletable thing is the package
    // version, which is the index `:stable` and `:$VERSION` now point at —
    // so tidying the staging tag away would delete the release's image out
    // from under general access.
    assert.doesNotMatch(code(PROMOTE), /-X DELETE|--delete|docker rmi/);
  });

  it("re-reads the manifest immediately before it moves anything", () => {
    // `needs: check` does not re-run `check`. Rerunning only this job from an
    // older run replays a gate that passed an hour ago, which moved `stable`
    // back while the manifest stayed newer.
    const images = code(job(PROMOTE, "images"));
    const reread = images.indexOf("read-channel-manifest.sh");
    const stage = images.indexOf('imagetools create -t "$IMAGE:$STAGING"');
    assert.ok(reread > 0, "the manifest is read again in this job");
    assert.ok(reread < stage, "before anything is written");
    // Through the shared reader and the shared validator, not an inline
    // `gh api` with a looser rule — an "anything else" falling through to
    // "nothing newer, carry on" is the bug this branch has caught three times.
    assert.match(images, /channel-manifest\.mjs preflight/);
    assert.doesNotMatch(images, /gh api .*releases/);
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
   * **What this does and does not establish.**
   *
   * It runs the gate, asserts the published manifest is untouched, and then
   * runs the commit point twice. So it establishes that the manifest is only
   * written by the writer, that an interruption before it leaves the document
   * exactly as it was, and that re-running converges.
   *
   * It does **not** establish that every reader therefore still sees the
   * previous version, and the PR should not claim it does. Nothing here moves
   * a registry tag or a desktop address. For the control plane that gap is
   * narrow — the updater refuses an image whose stamped version is not the one
   * it was told to fetch, before it writes a file or recreates anything, so an
   * installation in the window is frozen rather than damaged. For the desktop
   * it is not narrow at all: `desktop-stable` and `desktop-latest` are written
   * by the publish job *before* this runs, and Tauri installs whatever the
   * manifest at that address says if the version is greater. For desktop
   * readers the publish job is the commit point, not this. That contradiction
   * is the specification's to resolve and is routed there.
   */
  it("leaves the published manifest untouched when interrupted before the write, and the re-run converges", () => {
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

  /**
   * The four reproductions from the security review, each asserted at the
   * level it was found. Every one of them exited zero before this, which is
   * why they are here as behaviour rather than as shape.
   */
  it("does not let an overlapping writer undo a promotion", () => {
    // Reproduced: a release read general 0.55.0, a promotion committed
    // 0.57.0, the release finished and put 0.55.0 back. Both exited zero.
    //
    // The writer now reads back what landed, and if it is not what it wrote it
    // goes round again on top of the other writer's document. Simulated here
    // by letting a promotion land in between: the release's second attempt
    // reads the promoted document and re-applies only its own pin.
    const repo = repository({ manifest: published });

    // The promotion lands first.
    assert.equal(commit(repo, "control_plane:general=0.57.0").status, 0);
    assert.equal(reader(repo).control_plane.general, "0.57.0");

    // Now the release writes its beta pin, from a document that already has
    // the promotion in it. Both pins have to survive.
    const r = commit(repo, "control_plane:beta=0.59.0");
    assert.equal(r.status, 0, r.output);
    assert.equal(reader(repo).control_plane.beta, "0.59.0", "the release's pin landed");
    assert.equal(reader(repo).control_plane.general, "0.57.0", "and the promotion was not undone");
  });

  it("re-reads and re-applies rather than failing when it is raced", () => {
    // The loop's own behaviour: the read-back is what notices, so it has to be
    // there and it has to lead somewhere other than an exit.
    const script = readFileSync(join(ROOT, ".github/scripts/publish-channel-pin.sh"), "utf8");
    assert.match(script, /landed\.json/);
    assert.match(script, /cmp -s/);
    assert.match(script, /attempt=\$\(\(attempt \+ 1\)\)/);
    // And a bound, so a pathological registry cannot spin forever.
    assert.match(script, /ATTEMPTS=\d+/);
  });

  it("does not read a destroyed manifest as a repository that never promoted", () => {
    // `--clobber` deletes before it uploads, so an upload that fails in
    // between leaves no manifest at all. Absence is the bootstrap case, which
    // accepted a version *older* than the pin that had just been destroyed —
    // reproduced, and it wrote general 0.54.0 over a lost 0.55.0.
    const repo = repository({ manifest: published });

    // A write whose manifest upload fails after the delete.
    const broken = commit(repo, "control_plane:general=0.57.0", { FAIL_UPLOAD: "channels.json" });
    assert.notEqual(broken.status, 0);
    assert.equal(reader(repo), null, "the manifest really is gone — this is the hazard");

    // The previous document is still on the release, which is what makes the
    // absence legible.
    assert.ok(existsSync(join(repo.registry, "channels", "channels.previous.json")));

    // So the next run stops instead of bootstrapping, and a backwards version
    // is not accepted.
    const after = commit(repo, "control_plane:general=0.54.0");
    assert.notEqual(after.status, 0, "a destroyed manifest is not a bootstrap");
    assert.match(after.output, /destroyed\s+manifest/);
    assert.match(after.output, /To recover/, "and it says how to recover");
    assert.equal(reader(repo), null, "and it wrote nothing");

    // The gate refuses on the same grounds, before anything moves. A version
    // that *is* published, so it is the destroyed manifest stopping it and not
    // the release check one line above.
    const gate = check(repo, { version: "0.57.0" });
    assert.notEqual(gate.status, 0);
    assert.match(gate.output, /destroyed\s+manifest/);
  });

  it("refuses a malformed document at the gate, not only at the commit point", () => {
    // Reproduced: `{}`, `{"schema_version":2}` and `false` pins all passed the
    // gate and failed only at the writer — after the images had moved. The
    // gate used `jq '// empty'`, which cannot tell a missing field from a
    // `false` one. It now asks the writer's own parser.
    for (const bad of [{}, { schema_version: 2 }, { schema_version: 1, control_plane: { general: false, beta: false } }]) {
      const repo = repository({ manifest: bad });
      const gate = check(repo, { version: "0.57.0" });
      assert.notEqual(gate.status, 0, `${JSON.stringify(bad)} must be refused by the gate`);
      assert.deepEqual(reader(repo), bad, "and nothing touched");
    }
  });

  it("refuses a backwards move even if the comparison itself fails", () => {
    // Reproduced: the gate compared versions with `sort -V` inside an `if`,
    // where a command substitution is exempt from `set -e`. An injected sort
    // failure let a backwards 0.54.0 through a gate holding 0.55.0. There is
    // now no `sort` in the gate at all — the comparison is the writer's.
    const gate = code(job(PROMOTE, "check"));
    assert.doesNotMatch(gate, /sort -V/);
    assert.doesNotMatch(gate, /jq -r --arg/);
    // And the behaviour, with the comparison intact.
    const repo = repository({ manifest: published, releases: ["firetower-v0.54.0", "firetower-v0.58.0"] });
    const r = check(repo, { version: "0.54.0" });
    assert.notEqual(r.status, 0);
    assert.match(r.output, /never moved backwards/);
  });

  /**
   * The staging step, run against a fake `docker` rather than read.
   *
   * QA's finding: the platform floor could be deleted and the suite stayed
   * green, because everything asserting on it matched text. A shape test
   * cannot tell a check that runs from a check that is written down. These
   * run the step's own shell with a `docker` that answers as a flattened or
   * rewritten index would, and ask the only question worth asking: did it
   * refuse, and did it say where the evidence is?
   */
  function stagingStep() {
    const images = job(PROMOTE, "images");
    const at = images.indexOf("id: stage");
    assert.ok(at > 0, "no `id: stage` step — this test is reading a file that moved");
    const marker = "        run: |\n";
    const from = images.indexOf(marker, at) + marker.length;
    // To the next step, found *before* dedenting — a step opens at six spaces
    // and the script body at ten, so the boundary is only visible while the
    // indentation is still there. Reading past it pulled the next two steps in
    // and the harness ran them.
    const rest = images.slice(from);
    const end = rest.search(/\n {6}- /);
    assert.ok(end > 0, "the staging step is no longer followed by another step — this test is reading a file that moved");
    return rest
      .slice(0, end)
      .split("\n")
      .map((line) => line.replace(/^ {10}/, ""))
      .join("\n");
  }

  /** A `docker` whose `imagetools` answers are whatever the case needs. */
  const DOCKER = `#!/usr/bin/env bash
case "$*" in
  *"imagetools inspect"*"--format"*)
    case "$*" in
      *":$STAGING"*) printf '%s\\n' "\${STAGED_DIGEST:-sha256:aaa}" ;;
      *) printf '%s\\n' "\${SOURCE_DIGEST:-sha256:aaa}" ;;
    esac ;;
  *"imagetools inspect"*"--raw"*)
    printf '%s' "$RAW" ;;
  *"imagetools create"*) : ;;
esac
exit 0
`;

  /** A healthy two-platform index, as `imagetools inspect --raw` prints one. */
  const BOTH = JSON.stringify({
    manifests: [
      { platform: { os: "linux", architecture: "amd64" } },
      { platform: { os: "linux", architecture: "arm64" } },
      { platform: { os: "unknown", architecture: "unknown" } },
    ],
  });

  function stage(env = {}) {
    const dir = mkdtempSync(join(tmpdir(), "stage-"));
    writeFileSync(join(dir, "step.sh"), stagingStep());
    writeFileSync(join(dir, "docker"), DOCKER);
    chmodSync(join(dir, "docker"), 0o755);
    writeFileSync(join(dir, "out"), "");
    const r = spawnSync("bash", [join(dir, "step.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        IMAGE: "ghcr.io/firetower-cloud/firetower",
        VERSION: "0.57.0",
        STAGING: "promote-1-1",
        GITHUB_OUTPUT: join(dir, "out"),
        RAW: BOTH,
        ...env,
      },
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  }

  it("stages a good index without complaint", () => {
    // The positive control. Without it every refusal below could pass on a
    // step that refuses everything.
    const r = stage();
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /linux\/amd64 linux\/arm64/);
  });

  it("refuses a flattened index, and says :stable was not touched", () => {
    // One platform, and the digest unchanged — which is exactly what an index
    // that was rewritten to a single platform in place looks like. The digest
    // check cannot catch this one; the floor is the only thing that does.
    const r = stage({
      RAW: '{"manifests":[{"platform":{"os":"linux","architecture":"arm64"}}]}',
    });
    assert.notEqual(r.status, 0, "a single-platform index must be refused");
    assert.match(r.output, /does not name linux\/amd64/);
    assert.match(r.output, /has NOT been touched/);
    assert.match(r.output, /promote-1-1/, "and it says where the staged index is");
  });

  it("refuses an index whose digest changed under it", () => {
    const r = stage({ SOURCE_DIGEST: "sha256:aaa", STAGED_DIGEST: "sha256:bbb" });
    assert.notEqual(r.status, 0);
    assert.match(r.output, /something rewrote it/);
    assert.match(r.output, /has NOT been touched/);
  });

  it("refuses an index that names only attestations", () => {
    const r = stage({ RAW: '{"manifests":[{"platform":{"os":"unknown","architecture":"unknown"}}]}' });
    assert.notEqual(r.status, 0);
    assert.match(r.output, /does not name linux\//);
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

/**
 * **The rolling worker release, and what a person hand-running the one-liner
 * actually gets.**
 *
 * `usefiretower.com/worker.sh` redirects to `worker-latest`, so that release is
 * what `curl -fsSL … | sh` installs — the recommended line in the install
 * documentation. It used to be moved by every release, which meant "the newest
 * build": correct while there was one channel, and from the moment the channels
 * diverged it would hand a **beta** worker to somebody on a general-access
 * control plane, which refuses one newer than itself. #459.
 *
 * Shape tests above say the workflow calls the right script in the right order.
 * These run that script against the fake `gh` and then ask the only question
 * that matters: afterwards, what does the installer get? The last one runs the
 * **published** `worker.sh` — the copy that landed on the rolling release, not
 * the one in the working tree — against a `file://` view of it, so the whole
 * hand-run chain is exercised: the script, the asset it names, the checksum it
 * verifies, and the binary answering.
 *
 * Not on Windows: `bash`, `tar` and a POSIX `sh` script.
 */
describe("the rolling worker release follows general access", { skip: process.platform === "win32" }, () => {
  const SHAPES = [
    "firetower-worker-darwin-arm64.tar.gz",
    "firetower-worker-darwin-x86_64.tar.gz",
    "firetower-worker-linux-arm64.tar.gz",
    "firetower-worker-linux-x86_64.tar.gz",
  ];

  /** `sha256sum`'s own format: the digest, two spaces, the name. */
  const sums = (dir, names) =>
    `${names.map((n) => `${createHash("sha256").update(readFileSync(join(dir, n))).digest("hex")}  ${n}`).join("\n")}\n`;

  /**
   * A versioned release carrying what `release.yml` puts on one: a worker
   * tarball per shape, the two scripts, and the checksum file over all of them.
   *
   * The tarballs are real, and the binary inside is a script that reports the
   * version — which is what the hand-run test reads back at the far end of the
   * chain. The scripts are the repository's own, because the published
   * `worker.sh` being the thing that works is half the claim.
   */
  function versioned(registry, version, { shapes = SHAPES } = {}) {
    const tag = `firetower-v${version}`;
    const dir = join(registry, tag);
    // Beside the registry, not in it: a directory inside it would answer to
    // `gh release view` as a release nobody created.
    const staging = join(registry, "..", `build-${version}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(staging, { recursive: true });

    writeFileSync(
      join(staging, "firetower-worker"),
      `#!/bin/sh\ncase "$1" in\n  --version) echo "firetower-worker ${version}" ;;\n  doctor) echo "doctor: nothing to report" ;;\nesac\nexit 0\n`,
    );
    chmodSync(join(staging, "firetower-worker"), 0o755);
    for (const asset of shapes) {
      const r = spawnSync("tar", ["-czf", join(dir, asset), "-C", staging, "firetower-worker"], { encoding: "utf8" });
      assert.equal(r.status, 0, `packing ${asset}: ${r.stderr}`);
    }
    cpSync(join(ROOT, "install/worker.sh"), join(dir, "worker.sh"));
    cpSync(join(ROOT, "install/install.sh"), join(dir, "install.sh"));

    writeFileSync(join(dir, "SHA256SUMS"), sums(dir, [...shapes, "worker.sh", "install.sh"]));
    return dir;
  }

  const MANIFEST = (general, beta = "0.58.0") => ({
    schema_version: 1,
    control_plane: { beta, general, general_promoted_at: "2026-11-01T00:00:00Z" },
    desktop: { beta: "0.21.0", general: "0.20.0", general_promoted_at: "2026-10-01T00:00:00Z" },
  });

  /** A repository whose `channels` manifest and releases are what they say. */
  function repository({ general = "0.57.0", versions = ["0.57.0"], rolling, ...options } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "rolling-"));
    const registry = join(dir, "registry");
    mkdirSync(registry, { recursive: true });
    for (const v of versions) versioned(registry, v, options);
    if (general !== null) {
      mkdirSync(join(registry, "channels"), { recursive: true });
      writeFileSync(join(registry, "channels", "channels.json"), `${JSON.stringify(MANIFEST(general), null, 2)}\n`);
    }
    // A rolling release already holding something, when the case needs one.
    if (rolling) cpSync(join(registry, `firetower-v${rolling}`), join(registry, "worker-latest"), { recursive: true });

    const gh = join(dir, "gh");
    writeFileSync(gh, GH);
    chmodSync(gh, 0o755);
    writeFileSync(join(dir, "gh.log"), "");
    return { dir, registry };
  }

  /** The promotion step: move the rolling release onto a version. */
  function move(repo, version, env = {}) {
    const r = spawnSync("bash", [join(ROOT, ".github/scripts/publish-worker-rolling.sh"), version], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${repo.dir}:${process.env.PATH}`,
        GH_LOG: join(repo.dir, "gh.log"),
        REGISTRY: repo.registry,
        RUNNER_TEMP: join(repo.dir, "run"),
        GITHUB_REPOSITORY: "firetower-cloud/firetower",
        GITHUB_STEP_SUMMARY: "",
        ...env,
      },
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  }

  /** What is on the rolling release right now, as a reader would find it. */
  const rolling = ({ registry }, name) => {
    const at = join(registry, "worker-latest", name);
    return existsSync(at) ? readFileSync(at) : null;
  };
  const notes = ({ registry }) => {
    const at = join(registry, "worker-latest", ".notes");
    return existsSync(at) ? readFileSync(at, "utf8") : null;
  };

  /**
   * The hand-run install, as a person runs it.
   *
   * The **published** script — the copy that landed on the rolling release —
   * fetched over `file://` from a tree laid out the way the release host lays
   * one out, with no `--version`. So this is the real resolution: unpinned, the
   * script takes `worker-latest`, and whatever that holds is what ends up in
   * `bin/firetower-worker`.
   */
  function handRun(repo) {
    const host = join(repo.dir, "host");
    mkdirSync(join(host, "download"), { recursive: true });
    const link = join(host, "download", "worker-latest");
    if (!existsSync(link)) symlinkSync(join(repo.registry, "worker-latest"), link);
    const root = mkdtempSync(join(tmpdir(), "worker-root-"));
    const r = spawnSync("sh", [join(repo.registry, "worker-latest", "worker.sh"), "--skip-packages"], {
      encoding: "utf8",
      env: {
        ...process.env,
        FIRETOWER_RELEASES: `file://${host}`,
        FIRETOWER_WORKER_ROOT: root,
        // **The locale a Linux control plane forwards over ssh.** `ssh` sends
        // `LC_*` and a Linux control plane sends `C.UTF-8`, which bash 3.2 on
        // a Mac does not recognise — and in that state it read the first byte
        // of a multibyte character following `$ARCH` as part of the variable
        // name, so `set -u` killed the install with `ARCH?: unbound
        // variable`. Found exactly here, by this test, before the rest of it
        // could run. Set rather than inherited so the run does not depend on
        // whose terminal it is: it only bites on bash 3.2, so a Linux runner
        // passes it either way and the Mac in front of somebody is what
        // catches a regression.
        LC_CTYPE: "C.UTF-8",
      },
    });
    const binary = join(root, "bin", "firetower-worker");
    const said = existsSync(binary) ? spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim() : null;
    // The script's own error, not an opaque `null` three assertions later.
    assert.equal(r.status, 0, `the published installer failed:\n${r.stdout}${r.stderr}`);
    assert.ok(said, `nothing was installed:\n${r.stdout}${r.stderr}`);
    return { status: r.status, output: `${r.stdout}${r.stderr}`, said };
  }

  it("copies the promoted version's own files onto the rolling release", () => {
    // The positive control, and the invariant: the two releases hold the same
    // bytes, so the script on one can never name a tarball the other does not
    // have. Without this every refusal below could pass on a script that
    // refuses everything.
    const repo = repository({ general: "0.57.0" });
    const r = move(repo, "0.57.0");
    assert.equal(r.status, 0, r.output);
    for (const name of [...SHAPES, "worker.sh", "install.sh", "SHA256SUMS"]) {
      assert.deepEqual(
        rolling(repo, name),
        readFileSync(join(repo.registry, "firetower-v0.57.0", name)),
        `${name} on the rolling release is not the one on the versioned release`,
      );
    }
  });

  it("gives a hand-run install the general-access worker, first time", () => {
    // The acceptance criterion, run rather than reasoned about: published
    // script, published asset, published checksum, and the binary answering.
    const repo = repository({ general: "0.57.0", versions: ["0.57.0", "0.58.0"] });
    assert.equal(move(repo, "0.57.0").status, 0);

    const install = handRun(repo);
    assert.equal(install.status, 0, install.output);
    assert.match(install.said, /0\.57\.0/, "an unpinned install must get general access");
    // And it says which, rather than "the newest release" — the wording was
    // part of the false claim.
    assert.match(install.output, /general access/);
    // The checksum file was found and used: an install that silently skipped
    // verification would pass the version assertion just the same.
    assert.doesNotMatch(install.output, /without verifying/);

    // 0.58.0 is published and on beta. Nothing moved the rolling release to
    // it, and that is the whole fix: before #459 a release did exactly that.
    assert.doesNotMatch(install.said, /0\.58\.0/);
  });

  it("follows a later promotion, and only a promotion", () => {
    const repo = repository({ general: "0.57.0", versions: ["0.57.0", "0.58.0"] });
    assert.equal(move(repo, "0.57.0").status, 0);
    assert.match(handRun(repo).said, /0\.57\.0/);

    // 0.58.0 is promoted: the pin moves first, then this.
    writeFileSync(join(repo.registry, "channels", "channels.json"), `${JSON.stringify(MANIFEST("0.58.0"), null, 2)}\n`);
    assert.equal(move(repo, "0.58.0").status, 0);
    assert.match(handRun(repo).said, /0\.58\.0/);
  });

  it("refuses to drag the rolling release back behind a newer promotion", () => {
    // `needs:` does not re-run a job, so rerunning this one from an older
    // promotion would otherwise move the rolling release backwards with
    // nothing to notice. The manifest is read again here for that reason, and
    // the refusal is the manifest writer's own — one copy of the rule.
    const repo = repository({ general: "0.58.0", versions: ["0.57.0", "0.58.0"], rolling: "0.58.0" });
    const r = move(repo, "0.57.0");
    assert.notEqual(r.status, 0);
    assert.match(r.output, /never moved backwards/);
    assert.match(handRun(repo).said, /0\.58\.0/, "the reader is still on what was promoted");
  });

  it("refuses a version general access has not reached yet", () => {
    // The other direction, which the backwards guard is silent on: the pin was
    // never written, or a run reached here with the manifest write skipped. The
    // rolling release is a general-access pointer, so pointing it at a version
    // nothing has been told to want is exactly the failure #459 is about — it
    // would be *ahead* of every installation.
    const repo = repository({ general: "0.55.0", versions: ["0.55.0", "0.57.0"], rolling: "0.55.0" });
    const r = move(repo, "0.57.0");
    assert.notEqual(r.status, 0);
    assert.match(r.output, /general access is '0\.55\.0', not 0\.57\.0/);
    assert.match(r.output, /has NOT been touched/);
    assert.match(handRun(repo).said, /0\.55\.0/, "the reader is still on general access");
  });

  it("refuses when there is no channel manifest at all", () => {
    // Absence is the bootstrap case for the *manifest*, and it is not one
    // here: this release is a general-access pointer, so with nothing saying
    // what general access is there is nothing to point it at.
    const repo = repository({ general: null });
    const r = move(repo, "0.57.0");
    assert.notEqual(r.status, 0);
    assert.match(r.output, /no published channel manifest/);
    assert.equal(rolling(repo, "SHA256SUMS"), null);
  });

  it("refuses when the manifest cannot be read, which is not the same as there not being one", () => {
    for (const API_ERROR of ["gh: API rate limit exceeded (HTTP 403)", "gh: Server Error (HTTP 500)"]) {
      const repo = repository({ general: "0.57.0", rolling: "0.57.0" });
      const r = move(repo, "0.58.0", { API_ERROR });
      assert.notEqual(r.status, 0, `${API_ERROR} must stop it`);
      assert.match(r.output, /Could not read the published channel manifest/);
    }
  });

  it("refuses a release whose checksum file does not list every shape", () => {
    // The floor, by name. The set is taken from `SHA256SUMS` so the two
    // releases cannot disagree — but a checksum file listing only the macOS
    // tarballs is self-consistent and would publish a rolling release that
    // silently cannot serve Linux. Counting would not catch it either.
    for (const missing of SHAPES) {
      const repo = repository({ general: "0.57.0", shapes: SHAPES.filter((s) => s !== missing) });
      const r = move(repo, "0.57.0");
      assert.notEqual(r.status, 0, `a release with no ${missing} must be refused`);
      assert.match(r.output, new RegExp(`does not list ${missing.replace(/\./g, "\\.")}`));
      assert.equal(rolling(repo, "SHA256SUMS"), null, "and nothing published");
    }
  });

  it("refuses a release whose files do not match its own checksum file", () => {
    // The installer verifies against this document on somebody's machine. A
    // set that fails it here is a set that would fail there instead.
    const repo = repository({ general: "0.57.0" });
    writeFileSync(join(repo.registry, "firetower-v0.57.0", "worker.sh"), "#!/bin/sh\n# tampered\n");
    const r = move(repo, "0.57.0");
    assert.notEqual(r.status, 0);
    assert.equal(rolling(repo, "SHA256SUMS"), null);
  });

  it("refuses when what landed is not what it uploaded", () => {
    // The uploads are not one transaction, so the only statement worth making
    // is about what is published afterwards. An upload that exits 0 having
    // stored something else is silent everywhere except here.
    const repo = repository({ general: "0.57.0" });
    const r = move(repo, "0.57.0", { CORRUPT_UPLOAD: "worker.sh" });
    assert.notEqual(r.status, 0);
    assert.match(r.output, /worker\.sh is not the worker\.sh on firetower-v0\.57\.0/);
  });

  it("creates the rolling release on a repository that has never had one", () => {
    const repo = repository({ general: "0.57.0" });
    assert.equal(existsSync(join(repo.registry, "worker-latest")), false);
    assert.equal(move(repo, "0.57.0").status, 0);
    assert.match(handRun(repo).said, /0\.57\.0/);
  });

  it("is idempotent, so an interrupted promotion is finished by re-running it", () => {
    const repo = repository({ general: "0.57.0" });
    assert.equal(move(repo, "0.57.0").status, 0);
    const first = rolling(repo, "SHA256SUMS");
    assert.equal(move(repo, "0.57.0").status, 0);
    assert.deepEqual(rolling(repo, "SHA256SUMS"), first);
  });

  it("says on the release what it holds and what moves it", () => {
    // The published notes are the documentation somebody actually reads before
    // running the line, and "Moved on every release" is the claim #459 was
    // opened for. The behaviour and the words have to agree.
    const repo = repository({ general: "0.57.0" });
    assert.equal(move(repo, "0.57.0").status, 0);
    const said = notes(repo);
    assert.match(said, /general-access worker \(0\.57\.0\)/);
    assert.match(said, /promote\.yml/);
    assert.doesNotMatch(said, /Moved on every release/);
    assert.doesNotMatch(said, /newest/);
    // And it names the versioned release holding the same files, which is what
    // somebody checks when the two are suspected of disagreeing.
    assert.match(said, /firetower-v0\.57\.0 holds the same files/);
  });
});
