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
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const RELEASE = read(".github/workflows/desktop-release.yml");
const EVERY_PR = read(".github/workflows/desktop.yml");

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
});
