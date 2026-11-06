/**
 * The build's 96 states, photographed — the other half of the reconciliation.
 *
 *   pnpm mock &   pnpm dev &   pnpm shoot:app
 *
 * One entry per state in the prototype's `SHEET`, keyed by the same id
 * `shoot-proto.mjs` writes, so the two directories line up file for file and
 * `reconcile.mjs` can put them side by side.
 *
 * **A state this build cannot reach is the finding.** `skip` records why in
 * the index rather than quietly shooting the nearest screen, because a
 * reconciliation whose gaps are invisible is a reconciliation of the states
 * that happened to work.
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const OUT = process.env.OUT ?? new URL("../../.firetower/reconcile/app", import.meta.url).pathname;
const PROTO = new URL("../../.firetower/reconcile/proto", import.meta.url).pathname;
const APP = process.env.APP ?? "http://localhost:5273";
const HERE = process.env.HERE ?? "http://localhost:4401";
const ONLY = process.env.ONLY ?? "";
mkdirSync(OUT, { recursive: true });

const REGISTRY = JSON.stringify([
  { url: HERE, serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-09-21T09:00:00Z" },
  { url: "http://localhost:4499", serverId: "o_2", org: "Apex", user: "kp", token: "tok", addedAt: "2026-09-22T09:00:00Z" },
]);

const browser = await chromium.launch({ channel: "chrome" });

/** A page per state: `theme.ts` writes the attribute at import, so a theme is a reload. */
async function fresh(theme, { servers = REGISTRY, scene = "default" } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 824 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log("    pageerror:", String(e).slice(0, 160)));
  await page.request.post(`${HERE}/__reset?scene=${scene}`);
  await page.addInitScript(
    ([registry, choice]) => {
      if (registry) window.localStorage.setItem("firetower.servers", registry);
      else window.localStorage.removeItem("firetower.servers");
      window.localStorage.setItem("firetower.current", "o_1");
      window.localStorage.setItem("firetower.theme", choice);
      window.localStorage.removeItem("firetower.panel");
    },
    [servers, theme],
  );
  return page;
}

const at = (page, path, wait = 1100) =>
  page.goto(`${APP}/#${path}`, { waitUntil: "networkidle" }).then(() => page.waitForTimeout(wait));
const byTitle = (page, t) => page.locator(`[title="${t}"]`).first();
const pause = (page, ms = 500) => page.waitForTimeout(ms);

/** The inspector's tabs are buttons in its header strip. */
async function inspectorTab(page, label) {
  await at(page, "/sessions/s_1", 1800);
  await page.getByRole("button", { name: label, exact: true }).first().click();
}

/** Open a file from the inspector's tree, as a preview or kept. */
async function openFile(page, { keep } = {}) {
  await inspectorTab(page, "Files");
  await pause(page, 700);
  const row = page.locator("button", { hasText: "quota.rs" }).first();
  if (keep) await row.dblclick();
  else await row.click();
}

/** The first-run flow: type an address and press Connect. */
async function address(page, typed, settle) {
  await page.goto(`${APP}/#/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  const box = page.getByPlaceholder("ft-e1.tail9c2b.ts.net");
  await box.fill(typed);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(settle);
}

/* ── The table ────────────────────────────────────────────────────────────
   id: the prototype's own, from `shoot-proto.mjs`.
   go: drives a fresh page into the state. scene/servers set up the mock.   */
const SHOTS = [
  /* Starting work */
  { id: "starting-work__dashboard-two-waiting", scene: "waiting", go: (p) => at(p, "/") },
  { id: "starting-work__dashboard-nothing-waiting", scene: "calm", go: (p) => at(p, "/") },
  { id: "starting-work__dashboard-nothing-yet", scene: "empty", go: (p) => at(p, "/") },
  { id: "starting-work__tasks-has-work", go: (p) => at(p, "/tasks") },
  { id: "starting-work__tasks-nothing-open", scene: "no-tasks", go: (p) => at(p, "/tasks") },
  { id: "starting-work__tasks-not-connected", scene: "no-trackers", go: (p) => at(p, "/tasks") },
  {
    id: "starting-work__agent-model-effort",
    go: async (p) => {
      await at(p, "/");
      await p.locator(".composer .control").first().click();
      await pause(p);
    },
  },
  {
    id: "starting-work__which-repository",
    go: async (p) => {
      await at(p, "/");
      await byTitle(p, "Which repositories this workspace checks out").click();
      await pause(p);
    },
  },
  {
    id: "starting-work__which-machine",
    go: async (p) => {
      await at(p, "/");
      await byTitle(p, "Where it runs").click();
      await pause(p);
    },
  },
  {
    id: "starting-work__which-profile",
    go: async (p) => {
      await at(p, "/");
      await byTitle(p, "Which profile the agent wears").click();
      await pause(p);
    },
  },

  /* In a workspace */
  /* The `team` scene, because the Overview's team rail is half of what this
     screen is and every other scene leaves the workspace solo. */
  { id: "in-a-workspace__conversation", scene: "team", go: (p) => at(p, "/sessions/s_1", 2200) },
  {
    id: "in-a-workspace__a-file",
    go: async (p) => {
      await openFile(p, { keep: true });
      await pause(p, 1200);
    },
  },
  {
    id: "in-a-workspace__a-diff",
    go: async (p) => {
      await at(p, "/sessions/s_1", 1800);
      await inspectorTab(p, "Diff");
      await pause(p, 1200);
    },
  },
  { id: "in-a-workspace__preview", skip: "the preview tab needs a forwarded port, which the mock does not run" },
  { id: "in-a-workspace__a-picture", skip: "no image in the mock tree" },
  { id: "in-a-workspace__noting-code", skip: "a text selection needs a real drag; see annotate-place.test.ts" },
  { id: "in-a-workspace__notes-kept", skip: "a kept note needs the selection above" },
  {
    id: "in-a-workspace__terminal",
    go: async (p) => {
      await at(p, "/sessions/s_1", 1800);
      await p.keyboard.press("Meta+j");
      await pause(p, 900);
    },
  },
  {
    id: "in-a-workspace__find-in-the-conversation",
    go: async (p) => {
      await at(p, "/sessions/s_1", 1800);
      await p.keyboard.press("Meta+f");
      await pause(p, 700);
    },
  },
  {
    id: "in-a-workspace__right-click-a-file",
    go: async (p) => {
      await at(p, "/sessions/s_1", 1800);
      await inspectorTab(p, "Files");
      await p.locator('[data-file], .scroll-slim button', { hasText: "quota.rs" }).first().click({ button: "right" });
      await pause(p, 600);
    },
  },
  {
    id: "in-a-workspace__another-agent-here",
    go: async (p) => {
      await at(p, "/sessions/s_1", 1800);
      await byTitle(p, "Add an agent to this workspace").click();
      await pause(p, 700);
    },
  },
  {
    id: "in-a-workspace__repositories-here",
    go: async (p) => {
      await at(p, "/sessions/s_1", 1800);
      await byTitle(p, "Repositories in this workspace").click();
      await pause(p, 700);
    },
  },
  {
    id: "in-a-workspace__ship-uncommitted",
    go: async (p) => {
      await at(p, "/sessions/s_1", 1800);
      await inspectorTab(p, "Commit");
      await pause(p, 900);
    },
  },
  { id: "in-a-workspace__ship-two-repositories", skip: "needs a second checkout; the mock workspace has one" },
  { id: "in-a-workspace__ship-merged", skip: "needs a merged pull request on the mock checkout" },
  {
    id: "in-a-workspace__which-skills",
    go: async (p) => {
      await at(p, "/sessions/s_1", 1800);
      await byTitle(p, "Which skills this agent is reading").click();
      await pause(p, 700);
    },
  },

  /* Artifacts and skills */
  { id: "artifacts-and-skills__artifacts-the-library", go: (p) => at(p, "/artifacts", 1600) },
  {
    id: "artifacts-and-skills__reading-one",
    go: async (p) => {
      await at(p, "/artifacts", 1600);
      await p.locator(".art").first().click();
      await pause(p, 1400);
    },
  },
  { id: "artifacts-and-skills__writing-a-note-on-one", skip: "annotating an artifact needs a selection inside the viewer frame" },
  { id: "artifacts-and-skills__notes-kept", skip: "as above — the kept note follows the selection" },
  { id: "artifacts-and-skills__skills", go: (p) => at(p, "/configuration/skills", 1400) },
  {
    id: "artifacts-and-skills__one-skill",
    go: async (p) => {
      await at(p, "/configuration/skills", 1400);
      await p.locator(".sk").first().click();
      await pause(p, 1100);
    },
  },
  {
    id: "artifacts-and-skills__a-new-version",
    go: async (p) => {
      await at(p, "/configuration/skills", 1400);
      await p.locator(".sk").first().click();
      await pause(p, 900);
      await p.getByText("Versions", { exact: true }).first().click();
      await pause(p, 900);
    },
  },
  {
    id: "artifacts-and-skills__create-with-ai",
    go: async (p) => {
      await at(p, "/configuration/skills", 1400);
      await p.getByRole("button", { name: "Add a skill" }).click();
      await pause(p, 400);
      await p.getByText("Create with AI").click();
      await pause(p, 1100);
    },
  },
  {
    id: "artifacts-and-skills__held-for-review",
    go: async (p) => {
      /* The build lands a held skill on the gallery rather than at the end of
         a create flow — criterion 43's "both create flows land in the
         held-for-review state". This is that card. */
      await at(p, "/configuration/skills", 1400);
      await p.locator(".review").first().scrollIntoViewIfNeeded().catch(() => {});
      await pause(p, 400);
    },
  },
  {
    id: "artifacts-and-skills__upload-a-folder",
    go: async (p) => {
      await at(p, "/configuration/skills", 1400);
      await p.getByRole("button", { name: "Add a skill" }).click();
      await pause(p, 400);
      await p.getByText("Upload a folder").click();
      await pause(p, 900);
    },
  },

  /* Agent profiles and agents */
  { id: "agent-profiles-and-agents__profiles", go: (p) => at(p, "/configuration/roles", 1400) },
  {
    id: "agent-profiles-and-agents__one-profile",
    go: async (p) => {
      await at(p, "/configuration/roles", 1400);
      await p.getByText("Reviewer", { exact: true }).first().click();
      await pause(p, 900);
    },
  },
  {
    id: "agent-profiles-and-agents__new-profile",
    go: async (p) => {
      await at(p, "/configuration/roles", 1400);
      await p.getByRole("button", { name: "New profile" }).click();
      await pause(p, 400);
      await p.getByText("Write it myself").click();
      await pause(p, 900);
    },
  },
  {
    id: "agent-profiles-and-agents__read-only-profile",
    go: async (p) => {
      /* `Triager` is the one in a directory this person may read and not
         write — criterion 39's case. */
      await at(p, "/configuration/roles", 1400);
      await p.getByText("Triager", { exact: true }).first().click();
      await pause(p, 900);
    },
  },
  { id: "agent-profiles-and-agents__what-it-may-reach", skip: "the scope sheet opens from a profile being edited; the mock's roles are read-only to this user" },
  { id: "agent-profiles-and-agents__agents", go: (p) => at(p, "/configuration/agents", 1400) },

  /* Sources */
  { id: "sources__repositories", go: (p) => at(p, "/configuration/repositories", 1400) },
  { id: "sources__git-hosts", go: (p) => at(p, "/configuration/git-hosts", 1400) },
  {
    id: "sources__connect-choose-a-way",
    go: async (p) => {
      await at(p, "/configuration/git-hosts", 1400);
      await p.getByRole("button", { name: "Add a host" }).click();
      await pause(p, 700);
    },
  },
  { id: "sources__connect-device-code", skip: "the device-code page needs a real GitHub app; the mock cannot hand back a user code" },
  { id: "sources__connect-paste-a-token", skip: "reached after probing a real address; see the finding on AddHost" },
  { id: "sources__connect-connected", skip: "the connected confirmation follows a token the mock cannot verify" },
  { id: "sources__machines", go: (p) => at(p, "/configuration/machines", 1400) },
  {
    id: "sources__add-a-machine",
    go: async (p) => {
      await at(p, "/configuration/machines", 1400);
      await p.getByRole("button", { name: "Add a machine" }).click();
      await pause(p, 700);
    },
  },
  { id: "sources__add-a-machine-probing", skip: "the probe is a POST the mock answers instantly; the in-flight frame cannot be held" },
  { id: "sources__add-a-machine-no-answer", skip: "needs an ssh probe that fails; the mock does not run one" },
  { id: "sources__add-a-machine-reached-it", skip: "needs a successful ssh probe; the mock does not run one" },
  { id: "sources__trackers", go: (p) => at(p, "/configuration/trackers", 1400) },

  /* Settings */
  { id: "settings__people", go: (p) => at(p, "/configuration/people", 1400) },
  { id: "settings__teams", go: (p) => at(p, "/configuration/teams", 1400) },
  { id: "settings__directories", go: (p) => at(p, "/configuration/directories", 1400) },
  { id: "settings__vault", go: (p) => at(p, "/configuration/vault", 1400) },
  { id: "settings__this-firetower", go: (p) => at(p, "/configuration/server", 1400) },
  {
    id: "settings__who-can-access",
    go: async (p) => {
      await at(p, "/configuration/directories", 1400);
      await p.locator("button", { hasText: "Platform" }).first().click();
      await pause(p, 900);
    },
  },
  { id: "settings__where-it-lives", skip: "the \u201cwhere it lives\u201d sheet is opened from a skill or a secret being filed, not from Directories" },
  {
    id: "settings__new-directory",
    go: async (p) => {
      await at(p, "/configuration/directories", 1400);
      await p.getByRole("button", { name: /new directory|add a directory/i }).first().click();
      await pause(p, 700);
    },
  },
  { id: "settings__account", go: (p) => at(p, "/account", 1400) },
  { id: "settings__account-password-held", scene: "locked", go: (p) => at(p, "/account", 1400) },
  { id: "settings__updates-what-is-running", go: (p) => at(p, "/updates", 1600) },
  {
    id: "settings__updates-what-it-will-write",
    go: async (p) => {
      await at(p, "/updates", 1600);
      await p.getByRole("button", { name: /^Upgrade to/ }).first().click();
      await pause(p, 1200);
    },
  },
  { id: "settings__updates-upgrading", scene: "upgrading", go: (p) => at(p, "/updates", 1800) },

  /* Every list, in all five states */
  { id: "every-list-in-all-five-states__has-things", go: (p) => at(p, "/configuration/repositories", 1400) },
  { id: "every-list-in-all-five-states__empty", scene: "no-repos", go: (p) => at(p, "/configuration/repositories", 1400) },
  {
    id: "every-list-in-all-five-states__slow",
    scene: "slow-repos",
    go: async (p) => {
      /* `networkidle` never settles while the list is hanging, which is the
         point of the state. */
      await p.goto(`${APP}/#/configuration/repositories`, { waitUntil: "domcontentloaded" });
      await pause(p, 2600);
    },
  },
  { id: "every-list-in-all-five-states__refused", scene: "repos-error", go: (p) => at(p, "/configuration/repositories", 1400) },
  { id: "every-list-in-all-five-states__not-allowed", scene: "repos-denied", go: (p) => at(p, "/configuration/repositories", 1400) },
  {
    id: "every-list-in-all-five-states__server-dark",
    servers: JSON.stringify([{ url: "http://localhost:4499", serverId: "o_1", org: "Acme", user: "kevin", token: "tok", addedAt: "2026-09-21T09:00:00Z" }]),
    go: (p) => at(p, "/configuration/repositories", 2200),
  },

  /* Getting in, and being held at the door */
  { id: "getting-in-and-being-held-at-the-door__the-address", servers: "", go: (p) => at(p, "/", 900) },
  {
    id: "getting-in-and-being-held-at-the-door__looking-for-it",
    servers: "",
    /* An address that neither answers nor refuses, so the looking frame holds. */
    go: (p) => address(p, "10.255.255.1", 900),
  },
  { id: "getting-in-and-being-held-at-the-door__no-answer", servers: "", go: (p) => address(p, "localhost:4499", 4000) },
  { id: "getting-in-and-being-held-at-the-door__not-a-firetower", servers: "", go: (p) => address(p, APP.replace(/^https?:\/\//, ""), 4000) },
  { id: "getting-in-and-being-held-at-the-door__who-are-you-here", servers: "", go: (p) => address(p, HERE.replace(/^https?:\/\//, ""), 3000) },
  {
    id: "getting-in-and-being-held-at-the-door__replace-this-password",
    servers: "",
    scene: "locked",
    go: async (p) => {
      await address(p, HERE.replace(/^https?:\/\//, ""), 3000);
      await p.getByPlaceholder("Username").fill("kevin");
      await p.getByPlaceholder("Password").fill("temporary");
      await p.keyboard.press("Enter");
      await pause(p, 2200);
    },
  },
  { id: "getting-in-and-being-held-at-the-door__name-this-firetower", scene: "needs-setup", go: (p) => at(p, "/setup", 1400) },
  { id: "getting-in-and-being-held-at-the-door__set-up", scene: "setup-done", go: (p) => at(p, "/setup", 1400) },
  { id: "getting-in-and-being-held-at-the-door__held-password-reset", scene: "locked", go: (p) => at(p, "/", 1400) },
  { id: "getting-in-and-being-held-at-the-door__held-mid-setup", scene: "needs-setup", go: (p) => at(p, "/", 1400) },

  /* Over any screen */
  {
    id: "over-any-screen__k-the-palette",
    go: async (p) => {
      await at(p, "/");
      await p.keyboard.press("Meta+k");
      await pause(p, 700);
    },
  },
  {
    id: "over-any-screen__p-go-to-a-file",
    go: async (p) => {
      await at(p, "/sessions/s_1", 1800);
      await p.keyboard.press("Meta+p");
      await pause(p, 800);
    },
  },
  {
    id: "over-any-screen__before-something-is-undone",
    go: async (p) => {
      await at(p, "/configuration/skills", 1400);
      await p.locator(".sk").first().click();
      await pause(p, 900);
      await p.getByRole("button", { name: /discard|delete|remove/i }).first().click();
      await pause(p, 700);
    },
  },
  { id: "over-any-screen__a-usage-limit-is-reached", skip: "the limit banner needs a session whose account reports a limit; the mock reports none" },
  {
    id: "over-any-screen__what-happens-on-a-limit",
    go: async (p) => {
      await at(p, "/sessions/s_1", 1800);
      await p.getByText("on limit", { exact: false }).first().click();
      await pause(p, 700);
    },
  },
  { id: "over-any-screen__a-screen-that-threw", skip: "Boundary is driven by boundary.test; nothing in the mock throws on purpose" },
  {
    id: "over-any-screen__switch-firetower",
    go: async (p) => {
      await at(p, "/");
      await p.getByRole("button", { name: "You, and which Firetower you are in" }).click();
      await pause(p, 400);
      await p.getByText("Switch Firetower").first().click();
      await pause(p, 500);
    },
  },
  {
    id: "over-any-screen__the-profile-menu",
    go: async (p) => {
      await at(p, "/");
      await p.getByRole("button", { name: "You, and which Firetower you are in" }).click();
      await pause(p, 500);
    },
  },
  { id: "over-any-screen__dictation-blocked", skip: "dictation state needs a microphone permission answer Chrome will not fake" },
  { id: "over-any-screen__dictation-key-refused", skip: "needs a voice key the mock cannot refuse" },
  { id: "over-any-screen__dictation-no-key", skip: "needs the voice endpoints; the mock answers neither" },
  { id: "over-any-screen__dictation-server-too-old", skip: "needs a server under the voice minimum" },
  { id: "over-any-screen__dictation-set-the-key", skip: "needs the voice endpoints; the mock answers neither" },
];

/* Every prototype state is in the table, exactly once. */
const want = JSON.parse(readFileSync(`${PROTO}/index.json`, "utf8")).map((s) => s.id);
const have = SHOTS.map((s) => s.id);
const missing = want.filter((id) => !have.includes(id));
const extra = have.filter((id) => !want.includes(id));
if (missing.length || extra.length) {
  console.error("  table does not match the prototype's:", { missing, extra });
  process.exit(1);
}

const log = [];
let shot = 0,
  skipped = 0,
  broke = 0;
for (const s of SHOTS) {
  if (ONLY && !s.id.includes(ONLY)) continue;
  if (s.skip) {
    log.push({ id: s.id, state: "skipped", why: s.skip });
    skipped++;
    continue;
  }
  for (const theme of ["light", "dark"]) {
    const page = await fresh(theme, { servers: s.servers ?? REGISTRY, scene: s.scene ?? "default" });
    try {
      await s.go(page);
      await page.screenshot({ path: `${OUT}/${s.id}-${theme}.png` });
      if (theme === "dark") {
        log.push({ id: s.id, state: "shot" });
        shot++;
      }
    } catch (e) {
      console.log(`\n  ✗ ${s.id} (${theme}): ${String(e).split("\n")[0].slice(0, 160)}`);
      if (theme === "dark") {
        log.push({ id: s.id, state: "broke", why: String(e).split("\n")[0].slice(0, 200) });
        broke++;
      }
    }
    await page.close();
  }
  process.stdout.write(`\r  ${shot + broke}/${SHOTS.length - skipped}  ${s.id}`.padEnd(78));
}

writeFileSync(`${OUT}/index.json`, JSON.stringify(log, null, 2));
await browser.close();
console.log(`\n  ${shot} shot · ${skipped} not reachable yet · ${broke} failed → ${OUT}`);
