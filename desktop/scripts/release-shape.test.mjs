/**
 * What the two desktop workflows have to keep being true.
 *
 * Three of the things this release depends on are invisible in a passing
 * build: a job that holds a secret it has no use for still succeeds, a
 * release with no `.deb` on it looks exactly like one where somebody put the
 * `.deb` back, and a manifest written by two legs at once is only wrong on
 * the occasions when it is. None of them fails on its own, and all three are
 * one plausible edit away.
 *
 * So they are asserted here, from the workflow files themselves. It is a
 * coarse instrument — these read YAML as text rather than parsing it, because
 * nothing in this package parses YAML and adding a dependency to grep four
 * jobs is a poor trade. Each one therefore proves it found the job it is
 * talking about before it believes anything about it: a test that passes
 * because a rename made its subject disappear is worse than no test.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* Line endings normalised, because this suite runs on the Windows leg too and
   that runner's git checks text files out with CRLF — which would leave every
   line here ending in a `\r`, and `job()` below looking for a heading it could
   never match. */
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const RELEASE = read(".github/workflows/desktop-release.yml");
const EVERY_PR = read(".github/workflows/desktop.yml");
const TOOLS = read(".github/scripts/appimage-tools.sh");
const GUARD = read(".github/scripts/appimage-guard.sh");

/** One job's own lines: from `  <name>:` to wherever the next job starts. */
function job(workflow, name) {
  const lines = workflow.split("\n");
  const from = lines.indexOf(`  ${name}:`);
  if (from === -1) throw new Error(`no job called ${name} — this test is reading a file that moved`);
  const to = lines.findIndex((line, i) => i > from && /^ {2}\S/.test(line));
  return lines.slice(from, to === -1 ? undefined : to).join("\n");
}

describe("the Linux leg of a release", () => {
  const linux = job(RELEASE, "linux");

  it("is never given the Apple or Azure signing material", () => {
    // Packaging an AppImage executes a third-party shell script with the
    // AppDir in its hands. A Developer ID certificate and an Azure client
    // secret have no business in the same environment.
    expect(linux).not.toMatch(/APPLE_|AZURE_/);
    // The positive control, so this cannot pass by reading the wrong block:
    // the job that does sign with them says so plainly.
    expect(job(RELEASE, "build")).toMatch(/APPLE_CERTIFICATE/);
    expect(job(RELEASE, "build")).toMatch(/AZURE_CLIENT_SECRET/);
  });

  it("is given the one secret it does need", () => {
    // An unsigned AppImage is one every installed copy refuses to install.
    expect(linux).toMatch(/TAURI_SIGNING_PRIVATE_KEY/);
  });

  it("builds the AppImage and nothing else", () => {
    // The bundle list itself rather than the whole job, which talks about the
    // `.deb` in prose and should carry on doing so. The absence is as much
    // the point as the presence: a released `.deb` cannot update itself, and
    // the first edit to put one back will be `deb,` added to this line.
    expect(linux.match(/^ *args: .*/gm)?.map((line) => line.trim())).toEqual(["args: --bundles appimage"]);
  });

  it("pins its packaging tools and checks the artifact afterwards", () => {
    expect(linux).toMatch(/appimage-tools\.sh/);
    expect(linux).toMatch(/appimage-guard\.sh/);
  });
});

describe("the per-pull-request build", () => {
  it("still builds both Linux packages, which the release does not", () => {
    // Deliberately unchanged: a `.deb` is the easier thing to install on a
    // machine you administer, it costs nothing here, and this is where a
    // branch gets tried.
    expect(EVERY_PR).toMatch(/--bundles deb,appimage/);
  });

  it("pins the same tools and runs the same guard", () => {
    expect(EVERY_PR).toMatch(/appimage-tools\.sh/);
    expect(EVERY_PR).toMatch(/appimage-guard\.sh/);
  });
});

/**
 * The runtime is the sixth download, and the easiest one to lose.
 *
 * Seeding `~/.cache/tauri` stops the five files the bundler fetches itself. It
 * does nothing about `appimagetool`, which the AppImage plugin carries inside
 * it and which fetches the AppImage runtime from a rolling upstream tag unless
 * it is handed one. That runtime is the first code that runs on a user's
 * machine and it is inside what the updater key signs, so an unpinned one is a
 * real signature over code nobody chose.
 *
 * It travels from the pinning script to the bundler as `$LDAI_RUNTIME_FILE`
 * and nothing else, which makes it exactly the kind of thing a tidy-up
 * removes. A build that lost it still succeeds — it just quietly downloads
 * again — so the guard compares the embedded runtime against the pin, and
 * these three assertions are what keep both halves present to be compared.
 */
describe("the AppImage runtime", () => {
  it("is pinned by digest, from an immutable tag", () => {
    const pin = TOOLS.match(/^runtime-x86_64 (\S+) ([0-9a-f]{64})$/m);
    expect(pin).not.toBeNull();
    // Not `continuous`: a digest pinned to a rolling tag breaks on the next
    // upstream push, and the pressure is then to paste the new digest in.
    expect(pin[1]).toMatch(/type2-runtime\/releases\/download\/\d{8}\/runtime-x86_64$/);
  });

  it("is handed to appimagetool rather than left to be fetched", () => {
    // `linuxdeploy-plugin-appimage` turns this into `--runtime-file`, which in
    // appimagetool is an if/else against the download and not a preference.
    expect(TOOLS).toMatch(/LDAI_RUNTIME_FILE=\$runtime" >> "\$GITHUB_ENV/);
  });

  it("is checked in the artifact, before the guard executes it", () => {
    expect(GUARD).toMatch(/LDAI_RUNTIME_FILE/);
    // The order is the point: extracting the AppImage runs the runtime, so
    // the comparison has to come first or it is vouching for code it already
    // ran. Both indexes are real positions in the file, not -1 twice.
    const checked = GUARD.indexOf("digest_md5_at");
    const executed = GUARD.indexOf("--appimage-extract");
    expect(checked).toBeGreaterThan(0);
    expect(executed).toBeGreaterThan(0);
    expect(checked).toBeLessThan(executed);
  });
});

describe("latest.json", () => {
  it("is written by the publish job and by nothing else", () => {
    // `tauri-action`'s own manifest step is read → merge-its-own-platform →
    // delete → re-upload, with no lock. Every leg that does it is a chance
    // for two legs to lose a platform between them — and the action's input
    // **defaults to true**, so a leg added without the line below is a leg
    // that quietly starts doing it again. Hence one `false` per leg rather
    // than "no `true` anywhere".
    const legs = RELEASE.match(/uses: tauri-apps\/tauri-action/g) ?? [];
    const declined = RELEASE.match(/includeUpdaterJson: false/g) ?? [];
    expect(legs.length).toBeGreaterThan(0);
    expect(declined.length).toBe(legs.length);

    const outsidePublish = RELEASE.slice(0, RELEASE.indexOf("\n  publish:"));
    expect(outsidePublish).not.toMatch(/release upload[^\n]*latest\.json/);
    expect(job(RELEASE, "publish")).toMatch(/latest-json\.mjs/);
  });

  it("is not written until every leg has finished", () => {
    const needs = job(RELEASE, "publish").match(/^ *needs: .*/m)?.[0] ?? "";
    expect(needs).toMatch(/\bbuild\b/);
    expect(needs).toMatch(/\blinux\b/);
  });

  /**
   * One run cannot clobber its own entries. Two runs are a separate question,
   * and the answer is in two parts: they are serialised, and the rolling
   * release refuses to go backwards even if they somehow are not.
   */
  it("cannot have two runs in flight at once", () => {
    // One group for the whole workflow rather than one per tag: the point is
    // that no two desktop releases overlap, not that a tag does not race
    // itself. Queued, because a release abandoned halfway through uploading
    // installers is worse than a slow one.
    const concurrency = RELEASE.slice(RELEASE.indexOf("\nconcurrency:")).split("\njobs:")[0];
    expect(concurrency).toMatch(/group: desktop-release\s*$/m);
    expect(concurrency).toMatch(/cancel-in-progress: false/);
  });

  it("does not drop a release that is waiting behind another", () => {
    // `cancel-in-progress: false` protects the run that is *executing*. What
    // happens to the runs waiting is `queue`, and its default holds one: a
    // newer release queued behind a running one is evicted by the next run to
    // arrive, which can be a dispatched rebuild of an older tag. That run
    // then correctly refuses to move `desktop-latest` backwards, and the
    // release it displaced never publishes anything at all.
    const concurrency = RELEASE.slice(RELEASE.indexOf("\nconcurrency:")).split("\njobs:")[0];
    expect(concurrency).toMatch(/queue: max/);
    // The combination is a workflow validation error, so this is also what
    // keeps the two settings from being written the other way round.
    expect(concurrency).not.toMatch(/cancel-in-progress: true/);
  });

  it("is built from the payloads and not from the signatures alone", () => {
    // Naming an artifact is not signing it: the manifest job verifies every
    // signature against the bytes of the asset its entry will point at, and
    // it cannot do that from `.sig` files. A signature left over from the
    // previous build of a rebuilt tag names exactly what this build's
    // artifact is called, so a check made from names accepts it.
    const publish = job(RELEASE, "publish");
    expect(publish).toMatch(/gh release download "\$TAG"[^\n]*-D "\$RUNNER_TEMP\/assets"/);
    expect(publish).not.toMatch(/release download "\$TAG"[^\n]*-p '\*\.sig'/);
    expect(publish).toMatch(/--assets "\$RUNNER_TEMP\/assets"/);
  });

  it("will not advance the rolling release when it cannot read what it holds", () => {
    // A rule that permits the regression it exists to prevent whenever a read
    // fails is not a rule. This used to swallow the error and carry on with an
    // empty `held`, which compared as "nothing newer is there".
    const publish = job(RELEASE, "publish");
    const rolling = publish.slice(publish.indexOf("held="));
    const upload = rolling.indexOf("release upload desktop-latest");
    expect(upload).toBeGreaterThan(0);
    // Every path that failed to read stops before the upload...
    const stops = [...rolling.matchAll(/exit 1/g)].map((m) => m.index);
    expect(stops.length).toBeGreaterThan(1);
    expect(Math.max(...stops)).toBeLessThan(upload);
    // ...and absence is told apart from failure, so a repository with no
    // rolling release yet can still make one.
    expect(rolling).toMatch(/\(HTTP 404\)/);
    // The read's own error is never discarded, which is how it fell open.
    expect(rolling).not.toMatch(/2>\/dev\/null/);
  });

  it("never points the rolling release at an older build than it already holds", () => {
    // `desktop-latest` is the single address every installed copy reads, so a
    // rebuild of an old tag dispatched after a newer release must not win it.
    // Serialising runs orders them in time, not by version.
    const publish = job(RELEASE, "publish");
    const rolling = publish.slice(publish.indexOf("held="));
    expect(rolling).toMatch(/sort -V/);
    // The guard has to sit before the upload it guards, or it guards nothing.
    expect(rolling.indexOf("sort -V")).toBeLessThan(rolling.indexOf("release upload desktop-latest"));
    // The versioned release is uploaded either way: a rebuilt old tag still
    // has to be readable and comparable afterwards.
    const versioned = publish.indexOf('release upload "$TAG" "$RUNNER_TEMP/latest.json"');
    expect(versioned).toBeGreaterThan(0);
    expect(versioned).toBeLessThan(publish.indexOf("held="));
  });
});

/**
 * The rolling release's no-backwards rule, run rather than read.
 *
 * Everything above reads the workflow as text, which can say that an `exit 1`
 * is written somewhere in the gate. It cannot say that there is no path to the
 * upload without one — and that is the whole of the rule, which was advisory
 * until it was made to fail closed: a read that went wrong left `held` empty,
 * which compared as "nothing newer is there" and advanced `desktop-latest`
 * anyway.
 *
 * So this takes the shell the publish step actually runs, from the gate to the
 * end of it, and runs it against a `gh` that fails in each way that matters.
 * Then it asks the only question worth asking: did `desktop-latest` move?
 *
 * Not on Windows: the step is `bash` on an Ubuntu runner, and the suite runs
 * on the Windows leg too. The macOS and Linux legs cover it.
 */
describe.skipIf(process.platform === "win32")("the rolling release only moves forward", () => {
  /** The publish step's script, from the gate onwards, dedented to run. */
  function gate() {
    const publish = job(RELEASE, "publish");
    const marker = "        run: |\n";
    const body = publish
      .slice(publish.indexOf(marker) + marker.length)
      .split("\n")
      .map((line) => line.replace(/^ {10}/, ""))
      .join("\n");
    const from = body.indexOf('held=""');
    if (from === -1) throw new Error("the gate no longer opens with `held=\"\"` — this test is reading a file that moved");
    return body.slice(from);
  }

  /* A `gh` that logs what it was asked to do and answers as the case needs. */
  const GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
case "$*" in
  *"releases/tags/desktop-latest"*)
    if [ -n "\${API_ERROR:-}" ]; then printf '%s\\n' "$API_ERROR" >&2; exit 1; fi
    printf '%s\\n' "\${API_ASSETS:-1}" ;;
  *"release download desktop-latest"*)
    if [ -n "\${DOWNLOAD_FAILS:-}" ]; then echo "HTTP 500" >&2; exit 1; fi
    mkdir -p "$RUNNER_TEMP/held"
    printf '%s' "\${HELD_JSON:-}" > "$RUNNER_TEMP/held/latest.json" ;;
esac
exit 0
`;

  /** Runs the gate for version 0.29.1 and reports what `gh` was asked to do. */
  function run(env = {}) {
    const dir = mkdtempSync(join(tmpdir(), "rolling-"));
    writeFileSync(join(dir, "gate.sh"), gate());
    const gh = join(dir, "gh");
    writeFileSync(gh, GH);
    chmodSync(gh, 0o755);
    const log = join(dir, "gh.log");
    writeFileSync(log, "");
    writeFileSync(join(dir, "latest.json"), '{"version":"0.29.1"}');

    const result = spawnSync("bash", ["-e", join(dir, "gate.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_LOG: log,
        RUNNER_TEMP: dir,
        GITHUB_REPOSITORY: "firetower-cloud/firetower",
        TAG: "desktop-v0.29.1",
        VERSION: "0.29.1",
        ...env,
      },
    });
    const asked = readFileSync(log, "utf8");
    return {
      status: result.status,
      moved: /release upload desktop-latest/.test(asked),
      output: `${result.stdout}${result.stderr}`,
    };
  }

  it("moves when it holds an older build, and when it holds this one", () => {
    // The positive controls. Without these the rest could pass on a gate that
    // never uploads anything at all.
    expect(run({ HELD_JSON: '{"version":"0.29.0"}' })).toMatchObject({ status: 0, moved: true });
    expect(run({ HELD_JSON: '{"version":"0.29.1"}' })).toMatchObject({ status: 0, moved: true });
  });

  it("does not move when it holds a newer build", () => {
    // A rebuild of an old tag, dispatched by hand after a newer release went
    // out. Not a failure: the versioned release keeps its own manifest.
    const r = run({ HELD_JSON: '{"version":"0.30.0"}' });
    expect(r).toMatchObject({ status: 0, moved: false });
    expect(r.output).toMatch(/0\.30\.0/);
  });

  it("does not move when there is no rolling release yet", () => {
    // The one absence that is allowed: nothing to go backwards past, so this
    // release is the one that creates it.
    expect(run({ API_ERROR: "gh: Not Found (HTTP 404)" })).toMatchObject({ status: 0, moved: true });
    // Same for a rolling release that exists with no manifest on it.
    expect(run({ API_ASSETS: "0" })).toMatchObject({ status: 0, moved: true });
  });

  /**
   * The findings. Each of these used to end with `desktop-latest` advanced to
   * whatever this run built, because the read's failure left `held` empty and
   * an empty `held` skipped the comparison.
   */
  it("does not move when the release cannot be read", () => {
    for (const API_ERROR of [
      "gh: API rate limit exceeded (HTTP 403)",
      "gh: Bad credentials (HTTP 401)",
      "error connecting to api.github.com",
      "gh: Server Error (HTTP 500)",
    ]) {
      const r = run({ API_ERROR });
      expect(r.moved, `${API_ERROR} must not advance desktop-latest`).toBe(false);
      expect(r.status, `${API_ERROR} must fail the job`).not.toBe(0);
    }
  });

  it("does not move when the manifest it holds will not download", () => {
    const r = run({ DOWNLOAD_FAILS: "1" });
    expect(r.moved).toBe(false);
    expect(r.status).not.toBe(0);
    // Named as the download that failed, and not as a manifest with no
    // version in it. The check below would stop this one too, so the only
    // thing this branch buys is a log that says which thing went wrong —
    // which is the entire reason it is there.
    expect(r.output).toMatch(/would not download/);
  });

  it("does not move when the manifest it holds has no version in it", () => {
    // An empty file, a manifest without the key, and something that is not
    // JSON at all: there is nothing to compare against in any of them, which
    // is not the same as there being nothing newer.
    for (const HELD_JSON of ["", "{}", '{"platforms":{}}', "<!DOCTYPE html>"]) {
      const r = run({ HELD_JSON });
      expect(r.moved, `held=${JSON.stringify(HELD_JSON)} must not advance desktop-latest`).toBe(false);
      expect(r.status, `held=${JSON.stringify(HELD_JSON)} must fail the job`).not.toBe(0);
    }
  });
});
