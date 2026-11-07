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
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

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
  await page.getByRole("tab", { name: new RegExp(`^${label}`) }).first().click();
}

/** Open a file from the inspector's tree, as a preview or kept. */
async function openFile(page, { keep, named = "quota.rs", under = "src" } = {}) {
  await inspectorTab(page, "Files");
  await pause(page, 900);
  /* The tree is lazy: a folder has to be opened before its files exist. */
  await page.locator("aside button", { hasText: under }).first().click();
  await pause(page, 700);
  const row = page.locator("aside button", { hasText: named }).first();
  if (keep) await row.dblclick();
  else await row.click();
  await pause(page, 1200);
}

/** Add a machine, type an address, and probe it. */
async function probeMachine(page, settle) {
  await at(page, "/configuration/machines", 1400);
  await page.getByRole("button", { name: /Add a machine/ }).first().click();
  await pause(page, 500);
  await page.getByPlaceholder("192.0.2.10").fill("10.4.0.22");
  await page.getByRole("button", { name: /Add it|Reaching it/ }).first().click();
  await pause(page, settle);
}

/** Press the microphone in a workspace. */
async function dictate(page) {
  await at(page, "/sessions/s_1", 1800);
  await page.locator('[title^="Dictate"]').first().click();
  await pause(page, 1000);
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
  { id: "in-a-workspace__a-file", go: (p) => openFile(p, { keep: true }) },
  {
    id: "in-a-workspace__a-diff",
    go: async (p) => {
      await at(p, "/sessions/s_1", 1800);
      await inspectorTab(p, "Diff");
      await pause(p, 1200);
    },
  },
  {
    id: "in-a-workspace__preview",
    go: async (p) => {
      await at(p, "/sessions/s_1", 1800);
      await byTitle(p, "Preview a port").click();
      await pause(p, 600);
      /* The suggestions come off the conversation; the field is always there
         and defaults to 3000, which is what the drawing previews. */
      await p.getByRole("button", { name: "Open" }).first().click();
      await pause(p, 1800);
    },
  },
  { id: "in-a-workspace__a-picture", go: (p) => openFile(p, { keep: true, named: "shot.png", under: "docs" }) },
  {
    id: "in-a-workspace__noting-code",
    go: async (p) => {
      await openFile(p, { keep: true });
      /* Headless Chromium produces no selection from a synthetic drag, so the
         range is made programmatically and the `mouseup` React's delegated
         listener hears is dispatched by hand. */
      await p.evaluate(() => {
        const cells = document.querySelectorAll("table td:last-child");
        const line = cells[Math.min(12, cells.length - 1)];
        if (!line) return;
        const r = document.createRange();
        r.selectNodeContents(line);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
      });
      await p.locator("table").first().dispatchEvent("mouseup");
      await pause(p, 900);
    },
  },
  { id: "in-a-workspace__notes-kept", skip: "a kept note follows sending the note above, which posts a turn to the agent" },
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
      await openFile(p, { keep: true });
      await p.locator("aside button", { hasText: "quota.rs" }).first().click({ button: "right" });
      await pause(p, 600);
    },
  },
  {
    id: "in-a-workspace__another-agent-here",
    go: async (p) => {
      await at(p, "/sessions/s_1", 1800);
      await byTitle(p, "Another agent here").click();
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
    /* One checkout, which is what the drawing's single-repository Ship is. */
    scene: "one-repo",
    go: async (p) => {
      await inspectorTab(p, "Ship");
      await pause(p, 900);
    },
  },
  {
    id: "in-a-workspace__ship-two-repositories",
    go: async (p) => {
      await inspectorTab(p, "Ship");
      await pause(p, 900);
    },
  },
  {
    id: "in-a-workspace__ship-merged",
    scene: "merged",
    go: async (p) => {
      await inspectorTab(p, "Ship");
      await pause(p, 900);
    },
  },
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
      await p.locator(".sk", { hasText: "pr-screenshots" }).first().click();
      await pause(p, 900);
      await p.locator(".sk-tabs button", { hasText: "Versions" }).click();
      await pause(p, 900);
    },
  },
  {
    id: "artifacts-and-skills__create-with-ai",
    go: async (p) => {
      await at(p, "/configuration/skills", 1400);
      await p.getByRole("button", { name: /Add a skill/ }).first().click();
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
      /* The held skill, opened — what an agent wrote and is waiting on. */
      await at(p, "/configuration/skills", 1400);
      await p.locator(".sk", { hasText: "deploy-runbook" }).first().click();
      await pause(p, 1100);
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
      await p.getByRole("button", { name: /New profile/ }).first().click();
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
      await p.getByRole("button", { name: /Add a host/ }).first().click();
      await pause(p, 700);
    },
  },
  {
    id: "sources__connect-device-code",
    go: async (p) => {
      await at(p, "/configuration/git-hosts", 1400);
      await p.getByRole("button", { name: /^Connect$/ }).first().click();
      await pause(p, 1200);
    },
  },
  {
    id: "sources__connect-paste-a-token",
    go: async (p) => {
      await at(p, "/configuration/git-hosts", 1400);
      await p.getByRole("button", { name: /^Connect$/ }).first().click();
      await pause(p, 900);
      await p.getByRole("button", { name: /token|paste/i }).first().click();
      await pause(p, 900);
    },
  },
  { id: "sources__connect-connected", scene: "host-connected", go: (p) => at(p, "/configuration/git-hosts", 1600) },
  { id: "sources__machines", go: (p) => at(p, "/configuration/machines", 1400) },
  {
    id: "sources__add-a-machine",
    go: async (p) => {
      await at(p, "/configuration/machines", 1400);
      await p.getByRole("button", { name: /Add a machine/ }).first().click();
      await pause(p, 700);
    },
  },
  { id: "sources__add-a-machine-probing", scene: "probe-slow", go: (p) => probeMachine(p, 1200) },
  { id: "sources__add-a-machine-no-answer", scene: "probe-fails", go: (p) => probeMachine(p, 2500) },
  { id: "sources__add-a-machine-reached-it", go: (p) => probeMachine(p, 2500) },
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
      await p.getByRole("button", { name: /New directory/ }).first().click();
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
      /* Any confirmation draws the same dialog; the vault's remove is the
         one this mock can reach without a workspace somebody may end. */
      await at(p, "/configuration/vault", 1400);
      await p.locator(".r").first().hover();
      await pause(p, 200);
      await p.getByRole("button", { name: "Remove" }).first().click();
      await pause(p, 700);
    },
  },
  { id: "over-any-screen__a-usage-limit-is-reached", scene: "limit-hit", go: (p) => at(p, "/sessions/s_1", 2000) },
  {
    id: "over-any-screen__what-happens-on-a-limit",
    go: async (p) => {
      await at(p, "/sessions/s_1", 1800);
      await p.getByText("on limit", { exact: false }).first().click();
      await pause(p, 700);
    },
  },
  { id: "over-any-screen__a-screen-that-threw", scene: "throws", go: (p) => at(p, "/configuration/skills", 1600) },
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
  { id: "over-any-screen__dictation-blocked", skip: "a microphone permission answer Chrome will not fake in a headless context" },
  { id: "over-any-screen__dictation-key-refused", scene: "voice-rejected", go: (p) => dictate(p) },
  { id: "over-any-screen__dictation-no-key", scene: "voice-unset", go: (p) => dictate(p) },
  { id: "over-any-screen__dictation-server-too-old", skip: "needs a server under the voice minimum; the mock is at MIN_SERVER by design" },
  {
    id: "over-any-screen__dictation-set-the-key",
    scene: "voice-unset",
    go: async (p) => {
      await dictate(p);
      await p.getByRole("button", { name: /add|set|key/i }).first().click().catch(() => {});
      await pause(p, 700);
    },
  },
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

/* Merged, not overwritten: `ONLY=settings` used to leave the index holding
   twelve rows and `reconcile.mjs` reporting the other eighty-four as "not in
   the app's table", which is the one thing this file exists not to do. */
const before = existsSync(`${OUT}/index.json`) ? JSON.parse(readFileSync(`${OUT}/index.json`, "utf8")) : [];
const log = ONLY ? before.filter((r) => !r.id.includes(ONLY)) : [];
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

/* Back into the prototype's order, so the file reads as the sheet reads. */
log.sort((a, b) => want.indexOf(a.id) - want.indexOf(b.id));
writeFileSync(`${OUT}/index.json`, JSON.stringify(log, null, 2));
await browser.close();
console.log(`\n  ${shot} shot · ${skipped} not reachable yet · ${broke} failed → ${OUT}`);
