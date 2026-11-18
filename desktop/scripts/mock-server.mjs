/**
 * A stand-in control plane, for looking at the client.
 *
 * Not a test double and not part of any build — it exists so the desktop app
 * can be driven in a browser without a Postgres, a worker and a real machine
 * with repositories on it. It answers the handful of reads a workspace makes
 * and takes `POST /sessions/{id}/repos` slowly, because a clone is slow and
 * the screen that hides that is the screen that lies.
 *
 *   node scripts/mock-server.mjs [port]
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const PORT = Number(process.argv[2] ?? 4401);

const ORG = { id: "o_1", name: "Acme" };
/* `slug` is what every path is keyed on — `u/kevin/…` — and it was missing,
   so `isPersonal` answered false for every session this person owns and the
   panel filed a whole fleet under "Shared with you". */
const USER = { id: "u_1", orgId: "o_1", username: "kevin", slug: "kevin", email: "kevin@acme.co", role: "admin", mustChangePassword: false };

/* `path` is required on `Repo` and was on none of these, so `where()`
   answered the empty string and `mayMove` answered false for every
   repository here — the filing chip was blank and *Move* was never
   offered. Two of them are a directory's, which is the distinction the
   chip exists to draw. */
const REPOS = [
  { id: "r_web", slug: "acme/web", path: "u/kevin", remote: "git@github.com:acme/web.git", defaultBranch: "main", env: [] },
  { id: "r_api", slug: "acme/api", path: "u/kevin", remote: "git@github.com:acme/api.git", defaultBranch: "main", env: [] },
  { id: "r_infra", slug: "acme/infra", path: "d/platform", remote: "git@github.com:acme/infra.git", defaultBranch: "main", env: [] },
  { id: "r_ds", slug: "acme/design-system", path: "d/design", remote: "git@github.com:acme/design-system.git", defaultBranch: "main", env: [] },
  { id: "r_docs", slug: "acme/docs", path: "u/kevin", remote: "git@github.com:acme/docs.git", defaultBranch: "trunk", env: [] },
  { id: "r_mobile", slug: "acme/mobile", path: "u/kevin", remote: "git@github.com:acme/mobile.git", defaultBranch: "main", env: [] },
  { id: "r_jobs", slug: "acme/jobs", path: "u/kevin", remote: "git@github.com:acme/jobs.git", defaultBranch: "main", env: [] },
];

const BRANCH = "agent/auth-refactor";

/** An ISO timestamp this many minutes ago, so ages read as ages. */
const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

/** What the workspace came up with. `POST /__reset` puts it back to this. */
const START = () => {
  const web = { slug: "acme/web", repoId: "r_web", base: "main", branch: BRANCH, path: "web", trouble: null, pullRequest: null, pullState: null };
  /* **One checkout, or three.** Ship draws a section per repository the moment
     there is more than one, and the drawing has both — so the scene decides
     which of the two is on screen rather than the fixture always being three. */
  if (scene === "one-repo") return [web];
  if (scene === "merged") return [{ ...web, pullRequest: "https://example.invalid/acme/web/pull/482", pullState: "merged" }];
  return [
    web,
    { slug: "acme/api", repoId: "r_api", base: "main", branch: BRANCH, path: "api", trouble: null, pullRequest: null, pullState: null },
    { slug: "acme/infra", repoId: "r_infra", base: "main", branch: BRANCH, path: "infra", trouble: "github.com did not answer — nothing was cloned", pullRequest: null, pullState: null },
  ];
};

/* `scene` is assigned below, so the first call reads `undefined` and gets the
   default three — which is what a fresh process should have. */
let checkouts = [];

const work = () =>
  checkouts.map((c) => ({
    slug: c.slug,
    path: c.path,
    branch: c.branch,
    base: c.base,
    uncommitted: c.trouble ? null : c.slug === "acme/web" ? 4 : 0,
    commits: c.trouble ? null : c.slug === "acme/api" ? 2 : 0,
    ahead: 0,
    pushed: false,
    pullRequest: null,
    pullState: null,
    trouble: c.trouble,
  }));

const session = () => ({
  id: "s_1",
  owner: "u_1",
  number: 3,
  name: "auth refactor",
  title: "Move session tokens onto the new signing key",
  prompt: "Move session tokens onto the new signing key",
  size: "Medium",
  status: scene.endsWith("-done") ? "HandedBack" : "Working",
  agent: scene.startsWith("codex") ? "Codex" : "ClaudeCode",
  hostId: "h_1",
  workspaceId: "w_1",
  createdAt: "2026-09-21T09:12:00Z",
  updatedAt: "2026-09-21T11:48:00Z",
  share: "equal",
  base: "main",
  branch: BRANCH,
  repo: checkouts[0]?.slug ?? null,
  checkouts,
  path: "u/kevin",
  steps: ["Fetch", "Worktree", "Workspace", "Setup", "Launch"],
  /* All four of `WorkspaceUsage`, not the two a meter happens to draw
     first: `memoryPeakMb` is the number that goes beside a ceiling, and
     `oomKills` is the one that says a workspace was killed rather than
     merely busy. Both were missing, so neither could be drawn here. */
  usage: { cpu: 1.4, memoryMb: 940, memoryPeakMb: 1180, memoryMaxMb: 4096, oomKills: 0 },
  note: null,
  pullRequest: null,
  proposedTitle: null,
  proposedBody: null,
  taskKey: null,
  taskUrl: null,
  forgottenAt: null,
});

const HOSTS = [
  /* **The control plane's own container.** `accounts.rs` still calls
     `ensure_host("localhost", ...)`, so `listHosts` really does return this —
     which is the thing the client assumed it would not. Without it in the
     fixture the bug cannot be reproduced here at all. */
  {
    id: "localhost",
    name: "localhost",
    state: "Online",
    /* `path` is required on `Host`; these two are required on the
       `HostTarget` the Updates screen maps every host into, and this row
       was the only one without them — so `/api/v1/updates` answered a
       shape the Updates screen was not generated against. */
    path: "u/kevin",
    drained: false,
    reconnecting: false,
    compute: { type: "Local" },
    cpus: 8,
    memoryMb: 16384,
    workerVersion: "0.34.1",
    agents: [],
  },
  {
    id: "h_1",
    name: "this Mac",
    state: "Online",
    /* A directory's machine, which is what the items list below files it
       as — and what makes the filing chip say something other than
       "yours" on at least one row. */
    path: "d/platform",
    /* **A machine somebody added, over ssh**, which is the only kind there
       is now. It was `Local` here, so after the retirement every picker read
       the fixture's one real machine as a retired one — which would have
       masked the bug this fixture exists to show. */
    compute: { type: "Server", host: "10.4.0.21", user: "ubuntu", port: 22 },
    cpus: 10,
    memoryMb: 32768,
    docker: { status: "Running", detail: "28.1.1" },
    drained: false,
    reconnecting: false,
    workerVersion: "0.34.1",
  },
];

/* **A machine named the way people actually name machines.** Every host in
   the fixture above is called something short — `localhost`, `this Mac` —
   and `machineLabel` turned the longest of them into `this Mac ·
   ubuntu@10.4.0.21`, which fits the composer's shelf with room to spare. So
   the shelf was photographed ninety-odd times and never once with a label
   that did not fit, and the chip overflowing its band was invisible to the
   whole harness. This is the reported one: a name with spaces in it, a real
   account and a tailnet address. It is first in the list because the
   composer falls back to `all[0]`, so the state needs no interaction to
   reach. */
const LONG_HOSTS = [
  {
    id: "h_long",
    name: "Mac mini office",
    state: "Online",
    path: "u/kevin",
    compute: { type: "Server", host: "100.113.135.95", user: "kevinpiacentini", port: 22 },
    cpus: 10,
    memoryMb: 32768,
    docker: { status: "Running", detail: "28.1.1" },
    drained: false,
    reconnecting: false,
    workerVersion: "0.34.1",
  },
  ...HOSTS,
];

/* `latestVersion` and `behind` are the published-against-installed pair the
   control plane now works out for itself — see `updates::agents`. The numbers
   here are the ones a real check produced: Claude Code 2.1.273 installed
   against 2.1.285 published, which is a host that has quietly been behind
   since the day it was added. Codex is left current, so both states can be
   looked at on one screen. */
/* `signsInWithACode` is required by `AgentView` and was on none of these.
   `ConnectAccount` reads it as the whole condition for offering a browser
   sign-in — `const device = agent.signsInWithACode` — so against this
   fixture every agent offered the paste-a-token form and nothing else, on
   the three that have no token command at all. It is
   `Codex | KimiCode | CursorAgent` and nothing else
   (`ft_core::Agent::signs_in_with_a_code`). */
const AGENTS = [
  {
    kind: "ClaudeCode",
    label: "Claude Code",
    enabled: true,
    supported: true,
    needsCredential: true,
    credentialSet: true,
    signsInWithACode: false,
    latestVersion: "2.1.285",
    hosts: [{ hostId: "h_1", hostName: "this Mac", installed: true, coveredByToken: true, loggedIn: true, account: "kevin@acme.com", version: "2.1.273 (Claude Code)", behind: true, mayUpdate: true }],
  },
  {
    kind: "Codex",
    label: "Codex",
    enabled: true,
    supported: true,
    needsCredential: true,
    credentialSet: true,
    signsInWithACode: true,
    latestVersion: "0.159.2",
    hosts: [{ hostId: "h_1", hostName: "this Mac", installed: true, coveredByToken: true, loggedIn: true, account: "kevin@acme.com", version: "0.159.2", behind: false, mayUpdate: true }],
  },
  /* The other two Firetower drives. Here because a profile can pin any of
     them, and because the Skills section's note about the machine's own
     `~/.claude/skills` is agent-dependent: Claude Code reads it as well,
     these three read only what Firetower writes. Without them the states
     where that note becomes a reassurance cannot be driven at all. */
  {
    kind: "KimiCode",
    label: "Kimi Code",
    enabled: true,
    supported: true,
    needsCredential: true,
    credentialSet: true,
    signsInWithACode: true,
    latestVersion: "1.4.0",
    hosts: [{ hostId: "h_1", hostName: "this Mac", installed: true, coveredByToken: true, loggedIn: true, account: "kevin@acme.com", version: "1.4.0", behind: false, mayUpdate: true }],
  },
  {
    kind: "CursorAgent",
    label: "Cursor Agent",
    enabled: true,
    supported: true,
    needsCredential: true,
    credentialSet: true,
    signsInWithACode: true,
    latestVersion: "0.8.1",
    hosts: [{ hostId: "h_1", hostName: "this Mac", installed: true, coveredByToken: true, loggedIn: true, account: "kevin@acme.com", version: "0.8.1", behind: false, mayUpdate: true }],
  },
];

/* What a Claude Code session's pickers hold. The agent lists none of this —
   it is told rather than asked — so the choices are Firetower's own and the
   current value is the model it reported, mapped back onto the choice it
   answers to by `controls::claude_choice_for`. Before that mapping the picker
   matched nothing and drew the word "Model" over a running session. */
const CLAUDE_CONTROLS = [
  {
    kind: "model",
    fallback: "Model",
    current: "opus[1m]",
    choices: [
      { label: "Opus", value: "opus[1m]", note: "The flagship, long context" },
      { label: "Fable", value: "fable[1m]", note: "More capable, more expensive" },
      { label: "Sonnet", value: "sonnet[1m]", note: "Quicker, cheaper" },
      { label: "Haiku", value: "haiku", note: "Fastest, for small things" },
      { label: "Opus plan", value: "opusplan", note: "Plans with Opus, works with Sonnet" },
    ],
  },
  {
    kind: "mode",
    fallback: "Permissions",
    current: "auto",
    choices: [
      { label: "Auto", value: "auto", note: "Approves the ordinary, asks about the rest" },
      { label: "Ask everything", value: "default", note: "Nothing runs unasked" },
      { label: "Plan", value: "plan", note: "Explores and proposes, changes nothing" },
      { label: "Accept edits", value: "acceptEdits", note: "Writes files without asking. Commands still ask", caution: "grants" },
      { label: "Never ask", value: "dontAsk", note: "Refuses anything not already allowed, rather than asking", caution: "neverAsks" },
    ],
  },
  {
    kind: "effort",
    fallback: "Effort",
    choices: [
      { label: "Low", value: "low", note: "Quick, for small things" },
      { label: "Medium", value: "medium" },
      { label: "High", value: "high" },
      { label: "Extra high", value: "xhigh", note: "The usual, for work like this" },
      { label: "Max", value: "max", note: "Slow, and as good as it gets" },
    ],
  },
];

/**
 * What the library answers, for the `@` list in the composer.
 *
 * One was made by this very session, so "this workspace" and the path that
 * copies nothing are both on screen; one is a page with assets beside it, so
 * the zip answer is too; two are shared through a directory; one has no
 * poster yet. The posters are drawings served below — the shape of a page,
 * not a page.
 */
/** What `poster` draws for each, and how many files it is; off the wire. */
const LOOKS = {};
const FILES_IN = {};
const ARTIFACTS = [
  art("a_checkout", "checkout-flow", "Checkout flow", 1, { fromSessionId: "s_1", fromWorkspaceName: "auth refactor", minutes: 12, look: "checkout" }),
  art("a_pricing", "pricing", "Pricing, three tiers", 3, { fromWorkspaceName: "pricing rework", minutes: 120, look: "pricing" }),
  art("a_funnel", "q3-funnel", "Q3 funnel", 2, { mine: false, path: "d/growth/q3-funnel", minutes: 60 * 24, look: "funnel", files: 3 }),
  art("a_onboarding", "onboarding", "Onboarding, five screens", 4, { fromWorkspaceName: "auth cleanup", minutes: 60 * 72, look: "onboarding" }),
  art("a_arch", "firetower-architecture", "Firetower architecture", 5, { fromWorkspaceName: "docs pass", minutes: 60 * 24 * 7, look: "architecture", hasPoster: false }),
  art("a_ledger", "ledger-import", "Ledger import report", 1, { fromWorkspaceName: "ledger import", minutes: 60 * 24 * 14, look: "ledger" }),
  art("a_dashboard", "dashboard", "Dashboard, inbox first", 2, { mine: false, path: "d/design/dashboard", minutes: 60 * 24 * 21, look: "dashboard" }),
];
function art(id, slug, title, version, { minutes = 0, look = "pricing", files = 1, ...over }) {
  LOOKS[id] = look;
  FILES_IN[id] = files;
  return {
    id,
    slug,
    title,
    version,
    versionId: `v_${id}_${version}`,
    bytes: 42_000,
    hasPoster: true,
    mayShare: true,
    mine: true,
    path: `u/kevin/${slug}`,
    fromSessionId: null,
    fromWorkspaceName: null,
    firstSeenLine: null,
    updatedAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    url: `http://localhost:${PORT}/__artifact/${id}`,
    posterUrl: `/api/v1/artifacts/${id}/poster?v=${version}`,
    ...over,
  };
}

/**
 * A poster: the shape of a page in a white 640×400, enough to tell one
 * artifact from the next in a 36px thumbnail — which is all a list asks of
 * it. SVG so there is no image library and no binary in the tree.
 */
function poster(look) {
  const r = (x, y, w, h, fill = "#edeef1", extra = "") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" ${extra}/>`;
  const body = {
    pricing: r(48, 40, 300, 36, "#1c1c1f") + r(48, 96, 440, 18) + [0, 1, 2].map((i) => r(48 + i * 190, 150, 164, 210, i === 1 ? "#fafafb" : "#fff", `stroke="${i === 1 ? "#1c1c1f" : "#e3e3e8"}" stroke-width="3"`)).join(""),
    checkout: r(48, 40, 240, 36, "#1c1c1f") + [0, 1, 2, 3].map((i) => r(48, 100 + i * 52, i % 2 ? 540 : 360, 28)).join("") + r(48, 320, 220, 44, "#1c1c1f"),
    funnel: r(48, 40, 180, 36, "#1c1c1f") + [0.92, 0.7, 0.46, 0.24].map((k, i) => r(48, 110 + i * 64, 544 * k, 40, "#7d95b0")).join(""),
    onboarding: [0, 1, 2, 3, 4].map((i) => r(44 + i * 114, 60, 96, 280, "#fff", 'stroke="#d9d9de" stroke-width="3"')).join(""),
    architecture: r(48, 40, 300, 36, "#1c1c1f") + [0, 1, 2].map((i) => r(60 + i * 200, 170, 150, 80, "#fff", 'stroke="#1c1c1f" stroke-width="3"')).join("") + '<path d="M210 210h50M410 210h50" stroke="#1c1c1f" stroke-width="3"/>',
    ledger: r(48, 40, 260, 36, "#1c1c1f") + [0, 1, 2, 3, 4, 5].map((i) => r(48, 100 + i * 44, i % 2 ? 544 : 460, 24)).join(""),
    dashboard: [0, 1, 2, 3].map((i) => r(48 + (i % 2) * 280, 40 + Math.floor(i / 2) * 170, 264, 150, "#fff", 'stroke="#e3e3e8" stroke-width="3"')).join(""),
  }[look];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#fff"/>${body}</svg>`;
}

/**
 * The subscriptions a session can be started on.
 *
 * **`connected`, and nothing else will do.** Both of these said `"ready"`,
 * which is a word no part of this product uses: `agent_accounts.state` is
 * `pending` while a credential is being taken and `connected` once it is
 * (`crates/ft-server/src/api/accounts.rs`), and `usable()` — byte-identical
 * in `mobile/src/api/accounts.ts` and `desktop/src/api/accounts.ts` — is
 * `enabled && state === "connected" && credentialSet`. So every account the
 * mock served was unusable, and the composer correctly refused to start
 * anything: on the phone, on the desk, and in the old New workspace dialog
 * at once. The desk's own fixture in `account-switch.test.tsx` has said
 * `connected` all along, which is how the two drifted apart unseen.
 *
 * `mode` is `Subscription`, capitalised, because the column holds the
 * variant name — `format!("{:?}", req.mode)` — and `AccountSwitcher` asks
 * `a.mode === "Subscription"` before it recommends one. Lower-cased, the
 * recommendation never fired and the sheet offered nothing in bold.
 *
 * `path` is required by the contract and was absent, which is the quieter
 * half of the same row: `mayMove` splits a path to decide whether to offer
 * *Move* at all, so every account read as something nobody may file.
 */
const ACCOUNTS = [
  { id: "a_1", kind: "ClaudeCode", name: "Acme · Max", mode: "Subscription", isDefault: true, enabled: true, state: "connected", revision: 1, credentialSet: true, identity: "kevin@acme.com", path: "u/kevin", limits: [] },
  { id: "a_2", kind: "Codex", name: "Acme · Plus", mode: "Subscription", isDefault: true, enabled: true, state: "connected", revision: 1, credentialSet: true, identity: "kevin@acme.com", path: "u/kevin", limits: [] },
];

/** A window that has gone, as the agent reports one: see the `limit-hit` scene. */
const SPENT = {
  scope: "seven_day",
  status: "rejected",
  usedPercent: 100,
  observedAt: minutesAgo(4),
  resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600,
};

/* **`AssistantText` and `UserText`, which are two of the five `StreamKind`
   has.** Both of these said `"Content"`, a value no agent reports and no
   client names: `conversation.ts` asks whether a delta is `ToolOutput` or
   `ToolInput` and treats everything else as the item's text, so this
   rendered by falling off the end of a chain rather than by matching it.
   The desk's own `conversation.test.ts` has used `AssistantText` and
   `UserText` since it was written. */
const say = (item, text) => [
  { lineNo: 0, type: "ItemStarted", item, kind: "AssistantMessage", title: null, task: null },
  { lineNo: 0, type: "ContentDelta", item, stream: "AssistantText", delta: text },
  { lineNo: 0, type: "ItemCompleted", item, status: "Completed" },
];
const asked = (item, text) => [
  { lineNo: 0, type: "ItemStarted", item, kind: "UserMessage", title: null, task: null },
  { lineNo: 0, type: "ContentDelta", item, stream: "UserText", delta: text },
  { lineNo: 0, type: "ItemCompleted", item, status: "Completed" },
];

/**
 * Which scene the mock is playing, set by `/__scene`.
 *
 * `subagent` is the state a backgrounded subagent leaves behind: the turn has
 * ended, and the thing it handed work to has not reported. The session is
 * still working, and the transcript has to say so — see `Delegated`.
 */
let scene = "default";

/** A tool call a subagent made, which belongs on its rail and not the main one. */
const delegated = (item, kind, title, task) => [
  { lineNo: 0, type: "ItemStarted", item, kind, title, task },
  { lineNo: 0, type: "ItemCompleted", item, status: "Completed" },
];

/**
 * A turn that handed work to a subagent and ended before it came back.
 *
 * Three delegated commands on purpose: enough to fold into a "ran 3 commands"
 * group, which is exactly how the leak used to show up on the main rail.
 */
const subagent = (reported) => [
  { lineNo: 0, type: "SessionConfigured", model: "claude-opus-5", mode: "acceptEdits", tools: [], commands: [] },
  { lineNo: 1, type: "TurnStarted", turn: "t_1" },
  ...asked("i_1", "Audit every UI surface that shows session status, across desktop and mobile."),
  ...say("i_2", "That is a wide sweep across two clients, so I'll hand it to a subagent and carry on here."),
  {
    lineNo: 10,
    type: "ItemStarted",
    item: "call_1",
    kind: "SubagentCall",
    title: "sent",
    task: null,
  },
  { lineNo: 11, type: "ItemUpdated", item: "call_1", data: { description: "Audit subagent UI surfaces" } },
  {
    lineNo: 12,
    type: "TaskStarted",
    task: "task_1",
    item: "call_1",
    description: "Audit subagent UI surfaces",
    agent: "Explore",
  },
  ...delegated("d_1", "CommandExecution", "ran ls desktop/src/ui mobile/src/ui", "task_1"),
  ...delegated("d_2", "CommandExecution", "ran grep -rn SessionStatus desktop/src", "task_1"),
  ...delegated("d_3", "CommandExecution", "ran grep -rn BEAT_TONE mobile/src", "task_1"),
  ...delegated("d_4", "FileRead", "read desktop/src/api/view.ts", "task_1"),
  { lineNo: 20, type: "TaskProgress", task: "task_1", detail: "Reading desktop/src/api/view.ts" },
  // The turn ends here. The subagent does not.
  { lineNo: 40, type: "TurnCompleted", turn: "t_1", status: "Completed", usage: null },
  ...(reported
    ? [
        {
          lineNo: 41,
          type: "TaskCompleted",
          task: "task_1",
          status: "Completed",
          summary:
            "Seven surfaces read `SessionStatus`. Two of them — `Signal` and `Blocks` — draw the resting tick, and neither consults in-flight tasks.",
        },
        { lineNo: 42, type: "ItemCompleted", item: "call_1", status: "Completed" },
      ]
    : []),
];

/**
 * A transcript several screens tall, in the three states its scroller behaves
 * differently in.
 *
 * `pinned.mjs` measures what happens to `scrollTop` when somebody scrolls up,
 * and the measurement needs three things no other scene here has: a body far
 * taller than the viewport, a turn that is still open, and a question nobody
 * has answered. `how` picks which:
 *
 *   `scroll-idle`     the turn finished — nothing in `Chat.tsx` is watching
 *   `scroll-working`  the turn is open, so the per-frame pin is running
 *   `scroll-asking`   the turn is open *and* a question is on screen, which is
 *                     the state the report is about: `UserInputRequested`
 *                     never clears `working`, so the pin runs for as long as
 *                     the question goes unanswered rather than for the
 *                     seconds of a stream
 *
 * Twenty exchanges of real-length prose, because what is being measured is a
 * scroll offset and a transcript that fits on one screen has none.
 */
const TALK = [
  ["The signing key rotated. Move session tokens onto the new one, in the web app and the API both.",
   "I've read `web/src/auth/session.ts` and `api/src/tokens.rs`. They share the key id but not the code that reads it, so this is two changes that have to land together.\n\nStarting with the API, since the web app follows whatever it accepts."],
  ["Does the old key have to keep working?",
   "For as long as the longest-lived token signed with it, yes. The refresh window is fourteen days, so the verifier has to accept both key ids until the last of those expires and only the signer moves immediately.\n\nThat is the whole shape of the change: one signer, two verifiers."],
  ["Fine. Do that.",
   "Done in `api/src/tokens.rs`. `verify` now walks a list of keys oldest-last and returns which one matched, so a token signed with the retired key is still good and the metric can say how many of those are left.\n\nThe signer takes the first entry and nothing else."],
  ["What does the web app have to do?",
   "Less than I expected. It never reads the key — it reads the key *id* out of the token header to decide which cached public key to check against, and that lookup is already a map.\n\nSo the only change there is the fetch that fills the map: it asked for one key and now asks for the set."],
  ["Is the key set cached anywhere that will go stale?",
   "Two places. The service worker holds a copy for offline verification and the edge config holds another for the redirect check. The service worker's expires in an hour, which is fine. The edge config does not expire at all, which is not.\n\nI'll make the edge read go through the same fetch rather than hold its own copy."],
  ["Go on.",
   "That removed the second copy entirely. `edge/verify.ts` now imports the same `keys()` the app uses and the config entry is gone, so there is one fetch, one cache and one expiry rather than three of each.\n\nThe redirect check got about forty lines shorter as a result."],
  ["Any tests covering the two-verifier case?",
   "None, which is why I wrote four. A token signed with the retired key verifies; one signed with a key that was never in the set does not; the signer never picks a retired key however the list is ordered; and the fourteen-day boundary is checked from both sides.\n\nThe fourth is the one that would have caught the bug this change is for."],
  ["What was the bug?",
   "The original rotation dropped the old key the moment the new one landed, so every session older than that deploy was signed with a key nothing would accept any more. Everybody was signed out at once and the only way back in was a fresh login.\n\nThat is what the fourteen-day overlap is for."],
  ["Does anything else read tokens?",
   "The worker transport does, and it was the one I nearly missed: it verifies the token it was handed before it opens a shell, and it had its own copy of the verify code rather than calling into the crate.\n\nTwo copies of a verifier is how a rotation half-lands."],
  ["Fix that too.",
   "`crates/ft-worker/src/auth.rs` now calls `ft_core::tokens::verify` and its local copy is gone. The signatures differed slightly — the worker's returned a bool and the crate's returns which key matched — so three call sites moved with it."],
  ["Is there anything that signs tokens outside the API?",
   "The install script does, for the first-run bootstrap token, and it shells out to `openssl` rather than using the crate at all. It will keep working because it reads the key file the signer reads, but it hardcodes the key id.\n\nI have left it alone and written the line down; changing the installer in the same change as the verifier is how both get reverted together."],
  ["Agreed, leave it. What is left?",
   "The metric and the runbook. `tokens_verified_total` wants a `key_id` label so somebody can actually watch the old key drain, and the rotation runbook still says *replace the key* where it now has to say *prepend the key*.\n\nBoth are small and neither is code anybody calls."],
  ["Do the metric, skip the runbook — I'll write that.",
   "The label is in. It is the key id and not the key, and it is the *matched* id rather than the requested one, so the graph answers how many sessions are still on the retired key rather than how many asked about it."],
  ["Show me what the graph would say today.",
   "Against the fixture set, 0.4% of verifies match the retired key and all of them are refresh calls rather than API calls — which is what you would expect four days in, because an active session re-signs on every refresh and only an idle one still carries the old signature.\n\nIt should reach zero on day fourteen rather than tapering."],
  ["Why not tapering?",
   "Because nothing re-signs an idle session. It sits on the old key until somebody opens the tab, at which point it either refreshes or it has expired. So the curve is flat and then it falls off the end.\n\nIf it tapers at all, something is re-signing without a request, and that would be worth knowing."],
  ["Right. Is the deploy order sensitive?",
   "Verifier first, signer second, and there is a window between them where it does not matter — a verifier that accepts both keys is safe against a signer that only uses the old one. The other order is not: a signer on the new key against a verifier that has never heard of it signs tokens nothing accepts.\n\nSo: API verify, then edge, then signer."],
  ["Is that written down anywhere a deploy would read?",
   "Only in the commit message, which is the wrong place. I have put it at the top of the runbook section you said you would write, as three lines and nothing else, so that it is in the file even if the prose around it changes."],
  ["Good. Run the suite.",
   "`just test` is green — 1,284 tests, 41 seconds. The four new ones are in `api/src/tokens.rs` and the three that moved with the worker's verifier pass unchanged.\n\n`just gen-check` is clean too; nothing in this change touched a handler signature."],
  ["Anything you are unsure about?",
   "One thing. The service worker's hour-long cache means a client can hold a key set that predates a rotation for up to an hour, and during that hour a token signed with the newest key will fail *offline* verification and fall back to the network.\n\nThat is the correct behaviour and it is also invisible, so if somebody reports a slow first load after a rotation, that is what it is."],
  ["Note it and we're done.",
   "Noted in `web/src/auth/session.ts` next to the cache, where somebody debugging that will be reading.\n\nThat is the change: one signer, a verifier that accepts the set, one cache instead of three, and a label that says when the old key is finally unused."],
];

const QUESTIONS = [
  {
    header: "Retire the key",
    question: "When should the retired key stop being accepted?",
    multiSelect: false,
    options: [
      { label: "Day fourteen, on a timer", description: "The refresh window closes and the key goes, whether or not anything is still using it." },
      { label: "When the metric reads zero", description: "Watch `tokens_verified_total{key_id}` and remove it by hand once nothing matches." },
      { label: "Leave it in", description: "Keep accepting it indefinitely. Costs one extra verify on a miss and nothing else." },
    ],
  },
];

const scrolling = (how) => [
  { lineNo: 0, type: "SessionConfigured", model: "claude-opus-5", mode: "acceptEdits", tools: [], commands: [] },
  { lineNo: 1, type: "TurnStarted", turn: "t_1" },
  ...TALK.flatMap(([mine, theirs], i) => [...asked(`u_${i}`, mine), ...say(`a_${i}`, theirs)]),
  /* The turn only ends in the idle state. Left open, `working` stays true —
     which is the whole point of the other two. */
  ...(how === "idle" ? [{ lineNo: 900, type: "TurnCompleted", turn: "t_1", status: "Completed", usage: null }] : []),
  /* Requested and never resolved: the card stays on screen. */
  ...(how === "asking" ? [{ lineNo: 901, type: "UserInputRequested", req: "req_1", questions: QUESTIONS }] : []),
];

/**
 * The Codex scenes, normalised by the real thing.
 *
 * Not written by hand: `crates/ft-core/tests/streams/codex_subagent.ndjson` is
 * app-server output checked against the installed binary's own schema, and
 * these are what `CodexNormaliser` makes of it. So this photographs the actual
 * Codex path rather than a drawing of it.
 */
const CODEX = JSON.parse(readFileSync(new URL("./codex-events.json", import.meta.url), "utf8"));
const CODEX_DONE = JSON.parse(
  readFileSync(new URL("./codex-events-done.json", import.meta.url), "utf8"),
);

/* `firstLine` and `hasMore` are required beside `lastLine` and were both
   absent — the pair a client reads to decide whether there is more
   transcript above, which against this fixture was `undefined` and drew as
   "no". */
const conversation = () => ({
  lastLine: 42,
  firstLine: 0,
  hasMore: false,
  events:
    /* `scroll-idle`, `scroll-working`, `scroll-asking` — see `scrolling`. */
    scene.startsWith("scroll-")
      ? scrolling(scene.slice("scroll-".length))
    : scene === "subagent"
      ? subagent(false)
      : scene === "subagent-done"
        ? subagent(true)
        : scene === "codex"
          ? CODEX
          : scene === "codex-done"
            ? CODEX_DONE
            : [
    { lineNo: 0, type: "SessionConfigured", model: "claude-opus-5", mode: "acceptEdits", tools: [], commands: [] },
    { lineNo: 1, type: "TurnStarted", turn: "t_1" },
    ...asked("i_1", "The signing key rotated. Move session tokens onto the new one, in the web app and the API both."),
    ...say(
      "i_2",
      "I've read `web/src/auth/session.ts` and `api/src/tokens.rs`. They share the key id but not the code that reads it, so this is two changes that have to land together.\n\nStarting with the API, since the web app follows whatever it accepts.",
    ),
    { lineNo: 40, type: "TurnCompleted", turn: "t_1", status: "Completed", usage: null },
              ],
});

/**
 * A diff the size of a real day's work, for looking at what the inspector
 * costs to draw.
 *
 * `FT_MOCK_DIFF=<files>x<lines>` — so `FT_MOCK_DIFF=12x900` is twelve files of
 * nine hundred changed lines each. Off unless asked for, because every other
 * scene here wants the empty sheet.
 */
const BIG = (() => {
  const asked = process.env.FT_MOCK_DIFF;
  if (!asked) return null;
  const [files, lines] = asked.split("x").map(Number);
  return { files: files || 12, lines: lines || 900 };
})();

/* An agent that is still working changes the diff under the poll, which is the
   state the app was reported slow in. `FT_MOCK_DIFF_CHURN=1` moves one line
   every answer, so no two responses are equal. */
let churn = 0;

/** What `ft_core::MOST_OF_A_PATCH` cuts a single file's patch to. */
const MOST_OF_A_PATCH = 256 * 1024;

const bigDiff = (namesOnly = false) => {
  if (!BIG) return [];
  if (process.env.FT_MOCK_DIFF_CHURN) churn++;
  const out = [];
  for (let f = 0; f < BIG.files; f++) {
    const path = `web/src/auth/module-${String(f).padStart(2, "0")}.ts`;
    const body = [`diff --git a/${path} b/${path}`, `index 1111111..2222222 100644`, `--- a/${path}`, `+++ b/${path}`];
    let added = 0;
    let removed = 0;
    // Hunks of forty, the way a rewrite of a file actually prints.
    for (let h = 0; h * 40 < BIG.lines; h++) {
      const at = h * 44 + 1;
      body.push(`@@ -${at},42 +${at},42 @@ export function signingKey(id: string) {`);
      for (let i = 0; i < 40 && h * 40 + i < BIG.lines; i++) {
        const n = h * 40 + i;
        if (n % 5 === 0) {
          body.push(`-  const legacy = keyring.lookup(id, { generation: ${n} });`);
          removed++;
        }
        body.push(`+  const key = await keyring.current(id, { generation: ${n + churn}, rotateAfter: 30 });`);
        added++;
        body.push(`   return sign(payload, key, { alg: "EdDSA", kid: id, line: ${n} });`);
      }
    }
    // `namesOnly` is what the file tree asks for: the counts and whether the
    // file is new, and not one byte of hunk. Everything else is cut the way
    // the control plane cuts it, on a line boundary, so the client's own
    // "there is more of this" state is reachable here.
    const whole = `${body.join("\n")}\n`;
    const cut = whole.length > MOST_OF_A_PATCH;
    const patch = cut ? whole.slice(0, whole.lastIndexOf("\n", MOST_OF_A_PATCH) + 1) : whole;
    out.push({
      path,
      patch: namesOnly ? "" : patch,
      added,
      removed,
      fresh: f % 2 === 1,
      truncated: namesOnly ? false : cut,
    });
  }
  return out;
};

const json = (res, body, status = 200) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
  });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  if (req.method === "OPTIONS") return json(res, {});

  // Back to a workspace that has just come up, so a second scene can be
  // photographed without restarting the process.
  if (path === "/__reset") {
    scene = url.searchParams.get("scene") ?? "default";
    checkouts = START();
    return json(res, { detail: `back to three, playing ${scene}` });
  }

  /**
   * The five states every list has, driven on the repositories list.
   *
   * Criterion 49 asks for empty, loading, error, refused and server-dark on
   * every pane, and until now the mock could produce exactly one of them.
   * Empty is a scene on the route itself; dark is simply an address nothing
   * answers on; these are the other three.
   */
  if (path === "/api/v1/repos") {
    if (scene === "slow-repos") await new Promise((r) => setTimeout(r, 30_000));
    if (scene === "repos-error") {
      return json(res, { code: "ActionFailed", message: "the control plane refused: upstream timed out" }, 500);
    }
    if (scene === "repos-denied") {
      return json(res, { code: "Forbidden", message: "you may not read this organisation's repositories" }, 403);
    }
  }

  if (req.method === "POST" && path === "/api/v1/updates/plan") return json(res, PLAN);

  /* Signing in, so the first-run flow can be walked end to end rather than
     stopping at the password field. `locked` hands back the temporary
     password case, which is the one `Gate` and `ReplacePassword` exist for. */
  if (req.method === "POST" && path === "/api/v1/auth/login") {
    return json(res, { token: "tok", user: { ...USER, mustChangePassword: scene === "locked" } });
  }
  if (req.method === "POST" && (path === "/api/v1/setup/organization" || path === "/api/v1/setup/complete")) {
    if (path.endsWith("organization")) scene = "setup-done";
    return json(res, { detail: "done" });
  }

  const members_of = /^\/api\/v1\/teams\/([^/]+)\/members$/.exec(path);
  if (members_of) return json(res, TEAM_MEMBERS[members_of[1]] ?? []);

  const grants_of = /^\/api\/v1\/directories\/([^/]+)\/grants$/.exec(path);
  if (grants_of) return json(res, GRANTS[grants_of[1]] ?? []);

  const items_of = /^\/api\/v1\/directories\/([^/]+)\/items$/.exec(path);
  if (items_of) {
    /* `machine`, not `host`: `FiledKind` is
       `workspace | machine | agentAccount | secret | skill | artifact |
       role | repository`, and a row whose kind is outside it draws no mark
       and no second line. `path` is required on every one of them and was
       on none. */
    return json(res, [
      { kind: "skill", id: "sk_6", name: "skill-creator", path: "d/firetower", detail: "built in", ownerName: null },
      { kind: "secret", id: "se_3", name: "STAGING_DEPLOY_TOKEN", path: "d/platform", detail: "d/platform", ownerName: "kevin" },
      { kind: "machine", id: "h_1", name: "this Mac", path: "d/platform", detail: "ubuntu@10.4.0.21", ownerName: null },
    ]);
  }

  /* A mention, answered the way the control plane answers it: the page lands
     beside the attachments under the slug and the version, a page with assets
     lands as a zip, and what this very session made is named where it is. As
     slow as a real attach, so the chip's waiting state is on screen. */
  if (req.method === "POST" && /^\/api\/v1\/sessions\/[^/]+\/mention$/.test(path)) {
    const body = await new Promise((done) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => done(raw ? JSON.parse(raw) : {}));
    });
    const found = ARTIFACTS.find((a) => a.id === body.artifactId);
    await new Promise((r) => setTimeout(r, 600));
    if (!found || scene === "no-artifacts") return json(res, { code: "NotFound", message: "no such artifact" }, 404);
    const at =
      found.fromSessionId === "s_1"
        ? `.firetower/artifacts/${found.slug}/index.html`
        : `.firetower/attachments/${found.slug}-v${found.version}.${FILES_IN[found.id] > 1 ? "zip" : "html"}`;
    return json(res, { path: at, slug: found.slug, title: found.title, version: found.version });
  }

  /* The other half of the folder list above: `Workbench` publishes every
     folder it has not seen and records the fingerprint **on success**, so a
     path that does not answer is retried every three seconds for as long as
     a workspace is open. Answered here with the artifact that folder is, as
     `publish_artifact` does. */
  if (req.method === "POST" && /^\/api\/v1\/sessions\/[^/]+\/artifacts$/.test(path)) {
    return json(res, ARTIFACTS[0], 201);
  }

  const poster_of = /^\/api\/v1\/artifacts\/([^/]+)\/poster$/.exec(path);
  if (poster_of) {
    const look = LOOKS[poster_of[1]];
    if (!look) return json(res, { code: "NotFound", message: "no such picture" }, 404);
    res.writeHead(200, { "content-type": "image/svg+xml", "access-control-allow-origin": "*", "cache-control": "no-store" });
    return res.end(poster(look));
  }

  if (req.method === "POST" && /^\/api\/v1\/sessions\/[^/]+\/repos$/.test(path)) {
    const body = await new Promise((done) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => done(raw ? JSON.parse(raw) : {}));
    });
    const repo = REPOS.find((r) => r.id === body.repoId);
    // As long as a clone, so the panel's own waiting state is visible.
    await new Promise((r) => setTimeout(r, 1800));
    if (!repo) return json(res, { code: "RepoNotConnected", message: "that repository isn't connected" }, 404);
    if (repo.slug === "acme/docs") {
      return json(res, { code: "ActionFailed", message: "github.com refused the fetch: repository not found" }, 409);
    }
    const base = (body.base ?? "").trim() || repo.defaultBranch || "main";
    checkouts.push({
      slug: repo.slug,
      repoId: repo.id,
      base,
      branch: BRANCH,
      path: repo.slug.split("/").pop(),
      trouble: null,
      pullRequest: null,
      pullState: null,
    });
    return json(res, { detail: `./${repo.slug.split("/").pop()} · cut from ${base}` });
  }

  /**
   * What the Dashboard is drawn from, per scene.
   *
   * Three states and nothing in between, because those are the three the
   * design draws and the three worth photographing: agents asking you
   * something, agents working and nothing asking, and a Firetower with
   * nothing in it at all. `note` is the agent's own question — the Dashboard
   * reads it straight off the row rather than opening a conversation to find
   * it, which is the whole reason that field exists.
   */
  /* **Whose it is.** Every session carried the same path, so `isPersonal`
     answered false for all of them and the panel filed a whole fleet under
     "Shared with you" — with "Nothing running yet." printed above it. Most
     of them are this person's; two are not, which is what the drawing has. */
  const other = (over) => ({ ...session(), path: "u/kevin", ...over, checkouts: [], steps: undefined });
  const dashboard = () => {
    if (scene === "empty" || scene === "bare") return [];
    const working = [
      other({ id: "s_2", workspaceId: "w_2", number: 4, name: "Poke at the deploy script", status: "Working", repo: null, branch: null, createdAt: minutesAgo(8) }),
      /* `CursorAgent`, which is the variant name. `Cursor` is outside
         `Agent` altogether, so every screen that marks a row by its engine
         had one row it could not mark. */
      other({ id: "s_3", workspaceId: "w_3", number: 5, name: "Reconcile the webhook retries", status: "Working", agent: "CursorAgent", repo: "acme/api", branch: "fix/webhook-retry", createdAt: minutesAgo(120), path: "u/ana" }),
      other({ id: "s_4", workspaceId: "w_4", number: 6, name: "Backfill the invoice index", status: "Working", agent: "Codex", repo: "acme/jobs", branch: "chore/invoice-index", createdAt: minutesAgo(180) }),
      other({ id: "s_5", workspaceId: "w_5", number: 7, name: "Composer context meter", status: "Ready", repo: "acme/web", branch: "feat/context-meter", createdAt: minutesAgo(1440), path: "u/ana" }),
    ];
    /* A workspace with a team under it, which the Overview's team rail is
       the whole reason to open. Every other scene leaves `s_1` solo, so the
       panel it draws could not be looked at at all. */
    if (scene === "team") {
      return [
        session(),
        other({ id: "s_k1", workspaceId: "w_1", parentId: "s_1", number: 2, name: "Quota band thresholds", title: "Quota band thresholds", status: "NeedsYou", createdAt: minutesAgo(4), spawnReason: "decide whether a plan with no soft limit shows the band", note: "Should a plan with no soft limit show the band at all?" }),
        other({ id: "s_k2", workspaceId: "w_1", parentId: "s_1", number: 3, name: "Backfill the invoice index", title: "Backfill the invoice index", status: "Working", agent: "Codex", createdAt: minutesAgo(9), spawnReason: "writing the migration" }),
        other({ id: "s_k3", workspaceId: "w_1", parentId: "s_1", number: 4, name: "Token audit", title: "Token audit", status: "HandedBack", agent: "CursorAgent", createdAt: minutesAgo(62), spawnReason: "audit the token store" }),
      ];
    }
    /* **A team whose children have checkouts of their own**, which is the
       case no scene here could produce and the one a display bug shipped
       in.

       A subagent started in the manager's own workspace carries the
       *workspace's* name, so the roster reads its `title` — and a title
       never carries a prefix. A child given a workspace of its own is
       named by the server: `delegate.rs` composes
       `format!("{} / {what}", lead.name)`, so its row reads
       `auth refactor / verifier` and under the manager's own row says the
       manager twice, once per member. Every scene above puts every child
       at `workspaceId: "w_1"`, so every row went through `title` and that
       second kind of row had never been on screen, before its fix or
       after it — see #465.

       Both kinds together, because the panel has to be read with both in
       it: one subagent in the manager's checkout and two children with
       their own. The one that is asking is the in-checkout one on
       purpose, so the home's waiting chip still opens the *manager's*
       workspace and `e2e/team.yaml` reaches this panel by the same path
       it reaches `team`'s. `branch` is composed the way the server
       composes a child's, from the lead's and the slug of what it was
       sent to do.

       `name` on the in-checkout row is the workspace's, which is what the
       server would really have given it — the `team` scene above gives
       each of its three a name of its own, which is why nothing there can
       tell a row reading `title` from a row reading `name`. */
    if (scene === "team-delegated") {
      return [
        session(),
        other({ id: "s_k1", workspaceId: "w_1", parentId: "s_1", number: 2, name: "auth refactor", title: "Quota band thresholds", status: "NeedsYou", createdAt: minutesAgo(4), spawnReason: "decide whether a plan with no soft limit shows the band", note: "Should a plan with no soft limit show the band at all?" }),
        other({ id: "s_d1", workspaceId: "w_d1", parentId: "s_1", number: 3, name: "auth refactor / edge-cache", title: "One key fetch for the edge check", status: "Working", agent: "Codex", branch: `${BRANCH}-edge-cache`, createdAt: minutesAgo(26), spawnReason: "fold the edge config's copy of the key set into the app's fetch" }),
        other({ id: "s_d2", workspaceId: "w_d2", parentId: "s_1", number: 4, name: "auth refactor / verifier", title: "Accept both key ids until the window closes", status: "HandedBack", repo: "acme/api", branch: `${BRANCH}-verifier`, createdAt: minutesAgo(71), spawnReason: "accept the retired key for as long as the refresh window" }),
      ];
    }
    /* **A child that failed**, which the drawing added with `S.teamfail`
       because the artifact could not draw the state at all. `OverviewTab`
       has always returned `failed` and drawn it; nothing could reach it
       here, so the mark that was a round pip two rows under a round ember
       dot had never been photographed. */
    if (scene === "team-failed") {
      return [
        session(),
        other({ id: "s_k1", workspaceId: "w_1", parentId: "s_1", number: 2, name: "Quota band thresholds", title: "Quota band thresholds", status: "NeedsYou", createdAt: minutesAgo(4), spawnReason: "decide whether a plan with no soft limit shows the band", note: "Should a plan with no soft limit show the band at all?" }),
        other({ id: "s_k2", workspaceId: "w_1", parentId: "s_1", number: 3, name: "Backfill the invoice index", title: "Backfill the invoice index", status: "Failed", agent: "Codex", createdAt: minutesAgo(9), spawnReason: "the migration would not apply — the index already exists", note: "the migration would not apply" }),
        other({ id: "s_k3", workspaceId: "w_1", parentId: "s_1", number: 4, name: "Token audit", title: "Token audit", status: "Ended", agent: "CursorAgent", createdAt: minutesAgo(62), spawnReason: "audit the token store" }),
      ];
    }
    /* **The four states proposition C was chosen against.** Seven, forty
       with thirty in one repository, everything finished, and none. The
       panel's whole argument is what it does at forty rows, and nothing
       here could produce forty. */
    if (scene === "ws-many") {
      const verb = ["Backfill", "Reconcile", "Rewrite", "Audit", "Trim", "Split", "Port", "Cache", "Retry", "Measure"];
      const noun = ["the invoice index", "the webhook retries", "the quota band", "the token store", "the migration",
        "the session log", "the poster queue", "the vault read", "the host probe", "the diff view"];
      const status = (i) => (i < 3 ? "NeedsYou" : i < 9 ? "Working" : i === 29 ? "Failed" : "HandedBack");
      const out = [];
      for (let i = 0; i < 30; i++) {
        out.push(other({
          id: `m_${i}`, workspaceId: `wm_${i}`, number: 100 + i,
          name: `${verb[i % 10]} ${noun[(i * 3) % 10]}`, title: `${verb[i % 10]} ${noun[(i * 3) % 10]}`,
          status: status(i), repo: "acme/api", createdAt: minutesAgo(i < 9 ? i + 4 : (i - 6) * 60),
        }));
      }
      ["acme/web", "acme/infra", "acme/ledger-sync", "acme/docs", "acme/pricing", "acme/billing-worker"]
        .forEach((repo, i) => out.push(other({
          id: `o_${i}`, workspaceId: `wo_${i}`, number: 200 + i,
          name: `Work on ${repo.split("/")[1]}`, title: `Work on ${repo.split("/")[1]}`,
          status: i === 0 ? "NeedsYou" : i < 3 ? "Working" : "HandedBack",
          repo, createdAt: minutesAgo((i + 1) * 60 * 24),
        })));
      return out;
    }
    /* Everything finished: the same set, all handed back. The question C
       answers here is what a panel with no *Working* band looks like. */
    if (scene === "ws-done") {
      return [session(), ...working].map((x) => ({ ...x, status: "HandedBack" }));
    }
    if (scene === "ws-none") return [];
    if (scene === "calm") return [session(), ...working];
    /* **Two or three workspaces, which is the row that does not spill.**
       *View all* is drawn off a measurement, so the state where it is *not*
       drawn has to be reachable or the measurement is only ever checked one
       way round. */
    if (scene === "ws-few") {
      return [session(), other({ id: "s_6", workspaceId: "w_6", number: 8, name: "Quota meter rounding", status: "NeedsYou", repo: "acme/web", createdAt: minutesAgo(12), note: "Should a plan with no soft limit show the band at all?" })];
    }
    const asking = [
      other({
        id: "s_6", workspaceId: "w_6", number: 8, name: "Quota meter rounding", status: "NeedsYou",
        repo: "acme/web", branch: "feat/quota-band", createdAt: minutesAgo(12),
        note: "The amber band starts at 80% of the soft limit. Should a plan with no soft limit show the band at all, or stay neutral until it hits the hard one?",
      }),
      other({
        id: "s_7", workspaceId: "w_7", number: 9, name: "Light mode for the whole app", status: "NeedsYou",
        repo: "acme/design-system", branch: "feat/light", createdAt: minutesAgo(41),
        note: "Three of the seven file colours are too pale to read on a white page. Darken all seven, or give light mode its own set?",
      }),
      /* A third, past the ember budget: it has to appear in the list below
         with weight rather than a third dot. */
      other({
        id: "s_8", workspaceId: "w_8", number: 10, name: "Tracker webhook signature", status: "HandedBack",
        repo: "acme/api", branch: "fix/webhook-sig", createdAt: minutesAgo(95),
        note: "Gitea signs with SHA-256 and GitHub with SHA-1. Verify both, or refuse the older one?",
      }),
    ];
    /* **One long name**, which is the state that breaks a row of chips —
       and a real workspace name gets this long. The drawing renames its
       first workspace for exactly this; so does this. */
    if (scene === "longname") {
      return [
        { ...session(), name: "Reconcile the webhook retries against the ledger-sync mirror" },
        ...asking,
        ...working,
      ];
    }
    return [session(), ...asking, ...working];
  };

  const routes = {
    "/api/v1/bootstrap": { version: "0.34.1", eventsPath: "/api/v1/events", authModes: ["password"], organization: ORG.name, serverId: "o_1" },
    /* `locked` and `needs-setup` are what `Gate.tsx` stands between a
       connected server and the app for, and neither could be reached. */
    "/api/v1/auth/me": { user: { ...USER, mustChangePassword: scene === "locked" }, organization: ORG },
    /* `publicUrl` is required on `SetupState` and was absent from all
       three of these — the address this installation tells people to come
       back to. */
    "/api/v1/setup":
      scene === "needs-setup"
        ? { needsPassword: false, needsOrganization: true, needsGithub: false, publicUrl: `http://localhost:${PORT}`, completed: false, organization: null }
        : scene === "setup-done"
          ? { needsPassword: false, needsOrganization: false, needsGithub: false, publicUrl: `http://localhost:${PORT}`, completed: false, organization: ORG }
          : { needsPassword: false, needsOrganization: false, needsGithub: false, publicUrl: `http://localhost:${PORT}`, completed: true, organization: ORG },
    "/api/v1/sessions": dashboard(),
    "/api/v1/sessions/s_1": session(),
    "/api/v1/sessions/w_1": session(),
    "/api/v1/sessions/s_1/work": work(),
    "/api/v1/sessions/s_1/diff": BIG ? bigDiff(url.searchParams.get("namesOnly") === "true") : QUOTA_DIFF,
    "/api/v1/sessions/s_1/files": listing(url.searchParams.get("path") ?? ""),
    "/api/v1/sessions/s_1/turn": { sent: true },
    "/api/v1/artifacts": scene === "no-artifacts" || scene === "bare" ? [] : ARTIFACTS,
    "/api/v1/sessions/s_1/conversation": conversation(),
    "/api/v1/sessions/s_1/controls": scene.startsWith("codex") ? [] : CLAUDE_CONTROLS,
    /* **The limit-hit scene did not hit a limit.** `exhausted()` is
       `["rejected", "blocked", "reached"].includes(status)` and this said
       `exhausted`, which is in nobody's list — so the one scene built to
       photograph a spent subscription drew a healthy one. `scope` is the
       window as the agent reports it (`five_hour`, `seven_day`), not a
       word for it, and `observedAt` is required: a percentage with no age
       is worse than no percentage, which is the whole reason the column is
       sent. `switches` is a list of `Switch` — what was moved, when, and
       where it went — and held an `Account`, which is a different object
       with no `state` the switcher can read. Nothing has switched in this
       scene, so it is empty. */
    "/api/v1/sessions/s_1/account":
      scene === "limit-hit"
        ? {
            account: { ...ACCOUNTS[0], limits: [SPENT] },
            limits: [SPENT],
            switches: [],
          }
        : { account: ACCOUNTS[0], limits: [], switches: [] },
    "/api/v1/sessions/s_1/annotations": [],
    /* `throws` answers the right path with the wrong shape, which is what a
       real client meets when a server drifts — and is the one way to get
       `Boundary`'s own screen on camera without planting a bug in the app. */
    "/api/v1/skills": scene === "throws" ? { nope: true } : SKILLS,
    /* ── The seven the 404 found ──────────────────────────────────────
       Every one of these answered `[]` through the fall-through, so the
       screens that read them drew their empty state and nobody could tell
       that from the real thing. They are served explicitly now — some with
       content, some genuinely empty, and the difference is the point. */
    /* Which skills this session reads. The composer's chip counts them. */
    "/api/v1/sessions/s_1/skills": SKILLS.filter((k) => !k.held).slice(0, 2).map((k) => k.id),
    /* The run controls, per agent rather than per session. */
    "/api/v1/agents/ClaudeCode/controls": CLAUDE_CONTROLS,
    "/api/v1/agents/Codex/controls": [],
    /* **Folders, not artifacts.** This is what `Workbench` polls every
       three seconds to find pages the agent has written and publish each
       one it has not seen — `{ name, fingerprint }` — and it answered a
       list of published `Artifact`s, which have neither field. So
       `folder.name` was `undefined` on every pass. The Overview's
       "Artifacts & links" reads `/api/v1/artifacts`, not this; the comment
       that used to be here named the wrong screen. */
    "/api/v1/sessions/s_1/artifacts": [
      { name: "checkout-flow", fingerprint: "f_checkout_1" },
    ],
    /* No fallback configured, said explicitly. The list is `accountIds`
       and was `order`, so `useFallback` read `undefined` and the sheet
       drew no accounts whatever was configured. */
    "/api/v1/sessions/s_1/fallback": { enabled: false, accountIds: [] },
    /* What a tracker is scoped to. `key` is what goes on the wire —
       `acme/web`, or `ENG` — and this said `id`, which `TaskScope` has
       never had. */
    "/api/v1/trackers/gh_1/scopes": [
      { key: "acme/web", label: "acme/web" },
      { key: "acme/api", label: "acme/api" },
    ],
    /* **Main's endpoint**, added with the machine retirement — the line
       under Compute saying what was removed and where its sessions went.
       It has never been drawn here, because this answered `[]`. */
    "/api/v1/hosts/retired": scene === "no-retired" ? [] : [{ id: "h_gone", name: "build-02" }],
    /* The repositories a connected host offers to import. */
    "/api/v1/providers/github/repos": REPOS.map((r) => ({
      id: r.id, slug: r.slug, remote: r.remote, defaultBranch: r.defaultBranch, private: false,
    })),
    "/api/v1/repos": ["no-repos", "no-hosts", "fresh-install", "host-needs-app"].includes(scene) ? [] : REPOS,
    "/api/v1/hosts": scene === "no-machines" ? [] : scene === "long-machine" ? LONG_HOSTS : HOSTS,
    "/api/v1/agents": AGENTS,
    "/api/v1/agent-accounts": ACCOUNTS,
    /* What `GitHosts` actually reads. The stub here was four fields, so the
       screen drew one row with no state, no address and no "Add a host" —
       `maySetApplication` is what that button is gated on.

       **And it was not scene-varied at all**, so a fresh install — the
       built-in `github.com` registered and nobody signed into it — could not
       be driven or photographed by anything in the harness. That is the same
       gap that let the composer's chip overflow ship: every fixture was
       already in the happy state, so the state that was broken was invisible
       to every check at once. Three scenes, which are the three rungs the
       Repositories blank's one action climbs:

         `fresh-install`  the built-in GitHub, registered, nobody signed in;
         `host-needs-app` a colleague's host with no application of its own;
         `no-hosts`       nothing registered, which is the only state where
                          the next step is genuinely *adding* one. */
    /* **`AuthMode` is `device | token`, and this said `deviceCode`.** So
       `firstWayIn` answered `token` for every host here and
       `p.authModes.includes("device")` was false everywhere — the *In a
       browser* control was drawn disabled on GitHub, and the line
       explaining that a host has no device flow was printed under one that
       does. Four more fields `ProviderStatus` requires were absent
       altogether: `auth` (the way this one is set up *now*, as against the
       ways it could be), `baseUrl`, `tokenPage` and `appPage` — the three
       links the connect screen is mostly made of. They are absolute, the
       way the server composes them from `base_url`. */
    "/api/v1/providers": scene === "no-hosts"
      ? []
      : scene === "fresh-install"
        ? [{ id: "github", kind: "github", label: "GitHub", gitHost: "github.com", baseUrl: "https://github.com", tokenPage: "https://github.com/settings/tokens/new?scopes=repo,workflow&description=Firetower", appPage: "https://github.com/settings/applications/new", connected: false, configured: true, identity: null, builtin: true, maySetApplication: true, sharedApplication: false, auth: "device", authModes: ["device", "token"], kinds: ["issue", "pullRequest"], changeNoun: "pull request" }]
        : scene === "host-needs-app"
          ? [{ id: "gitlab_01j", kind: "gitlab", label: "GitLab (internal)", gitHost: "git.acme.internal", baseUrl: "https://git.acme.internal", tokenPage: "https://git.acme.internal/-/user_settings/personal_access_tokens?name=Firetower&scopes=api,write_repository", appPage: "https://git.acme.internal/-/user_settings/applications", connected: false, configured: false, identity: null, builtin: false, maySetApplication: true, sharedApplication: false, auth: "token", authModes: ["token"], kinds: ["issue", "pullRequest"], changeNoun: "merge request" }]
          : [
      { id: "github", kind: "github", label: "GitHub", gitHost: "github.com", baseUrl: "https://github.com", tokenPage: "https://github.com/settings/tokens/new?scopes=repo,workflow&description=Firetower", appPage: "https://github.com/settings/applications/new", connected: true, configured: true, identity: "kevin", builtin: true, maySetApplication: true, sharedApplication: false, auth: "device", authModes: ["device", "token"], kinds: ["issue", "pullRequest"], changeNoun: "pull request" },
      { id: "gitlab_01j", kind: "gitlab", label: "GitLab (internal)", gitHost: "git.acme.internal", baseUrl: "https://git.acme.internal", tokenPage: "https://git.acme.internal/-/user_settings/personal_access_tokens?name=Firetower&scopes=api,write_repository", appPage: "https://git.acme.internal/-/user_settings/applications", connected: false, configured: true, identity: null, builtin: false, maySetApplication: true, sharedApplication: true, auth: "token", authModes: ["token"], kinds: ["issue", "pullRequest"], changeNoun: "merge request" },
      { id: "gitea_01k", kind: "gitea", label: "Gitea", gitHost: "code.acme.dev", baseUrl: "https://code.acme.dev", tokenPage: "https://code.acme.dev/user/settings/applications", appPage: "https://code.acme.dev/user/settings/applications", connected: false, configured: false, identity: null, builtin: false, maySetApplication: true, sharedApplication: false, auth: "token", authModes: ["token"], kinds: ["issue", "pullRequest"], changeNoun: "pull request" },
    ],
    "/api/v1/trackers": scene === "no-trackers" ? [] : TRACKERS,
    "/api/v1/tasks": scene === "no-tasks" ? { more: false, next: null, tasks: [] } : TASKS,
    "/api/v1/colleagues": scene === "no-people" ? [] : COLLEAGUES,
    "/api/v1/teams": scene === "no-people" ? [] : TEAMS,
    "/api/v1/directories": scene === "no-dirs" ? [] : DIRECTORIES,
    "/api/v1/secrets": scene === "no-secrets" ? { ...SECRETS, held: [], access: [] } : SECRETS,
    "/api/v1/roles": scene === "no-roles" ? [] : ROLES,
    "/api/v1/provider-kinds": PROVIDER_KINDS,
    /* **The catalogue, for `assert-connected.mjs`.** Not an API route — a
       harness one, under a name no client asks for. The connectedness check
       has to know what each control *names* before it can say whether
       pressing it landed on that thing, and the alternative was tagging
       every row in the app with a `data-opens` attribute it does not
       otherwise need. */
    "/__entities": [
      ...REPOS.map((r) => ({ kind: "repository", id: r.id, name: r.slug })),
      ...HOSTS.map((h) => ({ kind: "machine", id: h.id, name: h.name })),
      ...ARTIFACTS.map((a) => ({ kind: "artifact", id: a.id, name: a.title })),
      ...SKILLS.map((k) => ({ kind: "skill", id: k.id, name: k.name })),
      /* A session and the workspace it lives in are one thing to a row that
         names it: the rail lists workspaces by their session's title and
         navigates to the *workspace*. Both ids are a correct landing. */
      ...dashboard().map((x) => ({ kind: "session", id: x.id, also: x.workspaceId ?? null, name: x.name ?? x.title })),
    ],
    "/api/v1/updates/runs": scene === "upgrading" ? [RUNNING, DONE_RUN] : [DONE_RUN],
    /* One run, by id. The list was served and the detail was not, so the
       screen that draws the steps had nothing to draw them from and the
       upgrading state could never be photographed. */
    "/api/v1/updates/runs/ur_2": RUNNING,
    "/api/v1/updates/runs/ur_1": DONE_RUN,
    /* `UpdateStatus`, as the screen and the rail actually read it. The old
       three-field object here predated both and was the wrong shape, so the
       Updates screen could not be opened against the mock at all. With
       something out, so the rail's slate row and the upgrade buttons are
       reachable without waiting for a release. */
    "/api/v1/updates": {
      current: "0.34.1",
      latest: { version: "0.35.0", publishedAt: "2026-10-02T09:00:00Z", notesUrl: null, notes: null, cliMinimum: null },
      checkedAt: "2026-10-02T09:12:00Z",
      checkError: null,
      updateAvailable: true,
      activeRun: scene === "upgrading" ? "ur_2" : null,
      controlPlane: {
        version: "0.34.1",
        upgradable: true,
        mayUpgrade: true,
        reason: null,
        sessions: ["Ledger exports"],
        updater: { configured: true, reachable: true, version: "0.34.1", apiVersion: 1, problem: null },
      },
      hosts: HOSTS.map((h) => ({
        hostId: h.id,
        name: h.name,
        version: h.workerVersion,
        online: h.state === "Online",
        drained: h.drained,
        upgradable: true,
        mayUpgrade: true,
        reason: null,
        sessions: [],
      })),
    },
    "/api/v1/events": [],
  };

  if (path in routes) return json(res, routes[path]);
  /* The file itself. `useFileText` reads the body as bytes and decides for
     itself whether it is text, a picture or too big — so this answers with
     the text and nothing around it. */
  if (/^\/api\/v1\/sessions\/[^/]+\/file$/.test(path)) {
    const wanted = url.searchParams.get("path") ?? "";
    /* A real picture, because `useFileText` reads the bytes and decides for
       itself what it is holding — a text stand-in renders as a code pane. */
    if (wanted.endsWith(".png")) {
      res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" });
      return res.end(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAGQAAABGCAYAAAAZpBqjAAAAXklEQVR4nO3QMQEAAAjAoNm/9Eq4AZIjcKtzdGBqAzsBOwE7ATsBOwE7ATsBOwE7ATsBOwE7ATsBOwE7ATsBOwE7ATsBOwE7ATsBOwE7ATsBOwE7ATsBOwE7AbsPUZEAgXCYVwkAAAAASUVORK5CYII=",
          "base64",
        ),
      );
    }
    const body = FILES[wanted];
    if (body === undefined) return json(res, { message: `No such file: ${wanted}` }, 404);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" });
    return res.end(body);
  }

  /* The rows the drawing draws under an expanded machine. An empty list was
     "ready: true, checks: []", which no screen can say anything useful about
     — and which the composer's machine picker drew as a red band. */
  /* What an agent wrote and is waiting on. Without this the held skill — the
     first row of the gallery — opened onto a screen that threw. */
  const detail_of = /^\/api\/v1\/skills\/([^/]+)\/detail$/.exec(path);
  if (detail_of) {
    const k = SKILLS.find((x) => x.id === detail_of[1]);
    if (!k) return json(res, { code: "NotFound", message: "no such skill" }, 404);
    return json(res, {
      ...k,
      body: `## When to use this\n\nReach for it when a change is visual and a reviewer cannot tell from the diff whether it is right — a new screen, a layout that moves, anything where "it looks correct" is the acceptance test.\n\n## What it does\n\n- Finds how this project starts its app, and starts it.\n- Drives the routes the change touches and photographs each one, light and dark.\n- Attaches the set to the pull request with a one-line caption each.\n\n## Frontmatter\n\n\`\`\`\nname: ${k.name}\ndescription: ${k.description}\nallowed-tools: Bash, Read, Write\n\`\`\`\n\nFiretower stores the folder verbatim and interprets six fields.\n`,
      /* `frontmatter` is required on `SkillDetail` and was absent — the
         parsed head of SKILL.md, which the body below only *prints*.
         `executable` is required on every `SkillFile` and was on none of
         them, which is the bit that says a bundle carries something that
         runs. */
      frontmatter: {
        name: k.name,
        description: k.description,
        "allowed-tools": ["Bash", "Read", "Write"],
      },
      files: [
        { path: "SKILL.md", size: 1840, executable: false, shared: false },
        { path: "scripts/shoot.ts", size: 7420, executable: true, shared: false },
        { path: "references/playwright.md", size: 52010, executable: false, shared: true },
      ],
    });
  }

  /* **Every session, not just `s_1`.** The child agents in the team rail are
     real sessions and the workspace opens them; only the manager's account
     was served, so every child fell through to the catch-all `[]` — which is
     truthy, so `data?.limits` passed the guard and `.find` threw. Opening a
     child from the team rail took the screen down to the error boundary.
     Found by `assert-connected.mjs` on its first run with the fifth
     outcome. */
  /* **⌘P had nothing to find.** The sheet opens, you type, and the worker's
     `find_files` fell through to the handler's `[]` — so the state the
     drawing draws, five of a hundred and forty-eight files with their
     directories beside them, could not be photographed. A checkout's worth
     of paths, filtered the way the worker filters them. */
  const search_in = /^\/api\/v1\/sessions\/([^/]+)\/files\/search$/.exec(path);
  if (search_in) {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const every = [
      "crates/ft-server/src/quota.rs",
      "crates/ft-server/tests/quota_band.rs",
      "web/app/components/QuotaMeter.tsx",
      "web/app/globals.css",
      "Cargo.toml",
      "crates/ft-server/src/main.rs",
      "crates/ft-worker/src/lib.rs",
      "desktop/src/ui/Home.tsx",
      "docs/STYLE.md",
      "package.json",
    ];
    return json(res, q ? every.filter((f) => f.toLowerCase().includes(q)) : every);
  }

  /* **Any session, by id.** Only `s_1` was served, so every child in the
     team rail fell through to the catch-all `[]` — and opening one took the
     Overview down, because `[]` has no `name`. That is the third crash from
     this one fixture gap, after the skill review and the account sheet. */
  const session_of = /^\/api\/v1\/sessions\/([^/]+)$/.exec(path);
  if (session_of && session_of[1] !== "s_1") {
    const found = dashboard().find((x) => x.id === session_of[1]);
    if (found) return json(res, found);
  }

  const account_of = /^\/api\/v1\/sessions\/([^/]+)\/account$/.exec(path);
  if (account_of && account_of[1] !== "s_1") {
    return json(res, { account: ACCOUNTS[0], limits: [], switches: [] });
  }

  const review_of = /^\/api\/v1\/skills\/([^/]+)\/review$/.exec(path);
  if (review_of) {
    const held = SKILLS.find((k) => k.id === review_of[1]);
    if (!held) return json(res, { code: "NotFound", message: "no such skill" }, 404);
    return json(res, {
      name: held.name,
      description: held.description,
      body: "# Deploy runbook\n\nUse when somebody asks to ship, cut a release or roll back.\n\n## Steps\n\n1. Run `scripts/preflight.sh` and stop at the first failure.\n2. Promote staging to production.\n3. Watch the smoke suite for ten minutes.\n",
      files: [
        { path: "SKILL.md", size: 1840, executable: false, text: "# Deploy runbook\n\nUse when somebody asks to ship." },
        { path: "scripts/preflight.sh", size: 612, executable: true, text: "#!/usr/bin/env bash\nset -euo pipefail\ncargo test --workspace\n" },
        { path: "scripts/promote.sh", size: 934, executable: true, text: "#!/usr/bin/env bash\nset -euo pipefail\nfiretower deploy --promote staging\n" },
      ],
    });
  }

  /* ── The scenes the reconciliation could not reach ────────────────
     Every one of these fell through to the handler's `[]`, so the state the
     prototype draws for it could not be photographed at all. */

  /* A forwarded port, so the Preview tab has something to be. */
  if (/^\/api\/v1\/sessions\/[^/]+\/forwards$/.test(path)) {
    return json(res, {
      alreadyReachable: false,
      availableHere: true,
      forwards: [{ port: 3000, local: 53000, url: "http://localhost:53000" }],
    });
  }

  /* An ssh probe, with its three answers. */
  if (req.method === "POST" && path === "/api/v1/hosts/probe") {
    if (scene === "probe-fails") {
      return json(res, {
        reached: false,
        diagnosis: {
          at: new Date().toISOString(),
          cause: "AuthRefused",
          summary: "build-02 refused the key",
          detail: "Permission denied (publickey). The key is in the agent but the machine has not been told about it.",
          remedy: "Add Firetower's public key to ~/.ssh/authorized_keys on build-02.",
        },
      });
    }
    await new Promise((r) => setTimeout(r, scene === "probe-slow" ? 30_000 : 400));
    return json(res, { reached: true, diagnosis: null });
  }

  /* Dictation. Five states, and the client could reach none of them. */
  if (path === "/api/v1/voice") {
    return json(res, {
      configured: scene !== "voice-unset",
      mayConfigure: true,
    });
  }
  if (req.method === "POST" && path === "/api/v1/voice/ticket") {
    if (scene === "voice-rejected") {
      return json(res, { code: "Forbidden", message: "OpenAI refused the key: incorrect API key provided" }, 403);
    }
    return json(res, { url: "wss://example.invalid/realtime", token: "tok" });
  }
  if (req.method === "POST" && path === "/api/v1/voice/key") return json(res, { detail: "stored" });

  /* Connecting a git host: the device code, the token, and what came back. */
  if (req.method === "POST" && /^\/api\/v1\/providers\/[^/]+\/authorize$/.test(path)) {
    return json(res, { userCode: "FTWR-8213", verificationUri: "https://github.com/login/device" });
  }
  if (req.method === "POST" && /^\/api\/v1\/providers\/[^/]+\/token$/.test(path)) {
    return json(res, { account: "kevin" });
  }
  if (/^\/api\/v1\/providers\/[^/]+\/connection$/.test(path)) {
    return json(res, { connected: scene === "host-connected", identity: scene === "host-connected" ? "kevin" : null });
  }
  /* **`GitIdentity`, which is `{ name, email, source }`** — what a
     person's commits are signed with and where it was read from. This
     answered `{ identity, scopes }`, which is not a shape any client was
     generated against, so the line that says whose name is on a commit had
     nothing in it. `source` is `host` (read from the token) or `set` (typed,
     and nothing overwrites it). */
  if (/^\/api\/v1\/providers\/[^/]+\/identity$/.test(path)) {
    return json(res, { name: "Kevin", email: "kevin@acme.co", source: "host" });
  }

  if (path.endsWith("/readiness")) {
    return json(res, {
      user: "kevin",
      checks: [
        { name: "SSH", available: true, required: true, detail: "reached in 180ms", remedy: null },
        { name: "Worker", available: true, required: true, detail: "0.34.1, answering", remedy: null },
        { name: "git", available: true, required: true, detail: "2.49.0", remedy: null },
        { name: "node", available: true, required: true, detail: "22.11.0", remedy: null },
        { name: "Claude Code", available: scene !== "needs-signin", required: false, detail: scene === "needs-signin" ? "installed, not signed in" : "2.1.273", remedy: null },
      ],
    });
  }
  /* **An unmatched route is a 404, not an empty list.**
   *
   * This answered `[]` with a 200, and `[]` is truthy — so `data?.files`,
   * `data?.limits` and `data.name` all sailed past their guards and threw
   * one level in. That is three white screens from one line: the skill
   * review, the account sheet, and opening a child from the team rail. Each
   * was found on a different day by a different check, and all three would
   * have shown up at the first render if the mock had said "I do not serve
   * this" instead of "here is nothing".
   *
   * A real server 404s a path it does not have. So does this, now, and the
   * body says which path so the gap names itself in the console. */
  return json(res, { code: "NotFound", message: `the mock does not serve ${req.method} ${path}` }, 404);
});

/**
 * The event socket, answered and then silent.
 *
 * The client holds one for the page and reconnects with backoff when it is
 * refused, so refusing it would put a reconnect loop behind every screenshot.
 * Completing the handshake and sending nothing is what "quiet" looks like.
 */
/**
 * How often the mock agent reports having edited a file, in milliseconds.
 *
 * `FT_MOCK_EDITS=3000` is an agent writing a file every three seconds. Off by
 * default: every other scene here wants the quiet socket.
 */
const EDITS = Number(process.env.FT_MOCK_EDITS ?? 0);

/**
 * What kind of item the edit is reported as.
 *
 * The refresh in `Chat.tsx` counts `FileChange` and `CommandExecution` only, and
 * `classify` in `ft-core/src/normalise.rs` answers `McpToolCall` for anything
 * whose name carries `mcp` *before* it asks whether the name is an edit — so a
 * file written through an MCP server arrives as `McpToolCall` and that refresh
 * never sees it. `FT_MOCK_EDITS_KIND=McpToolCall` is that case.
 */
const EDIT_KIND = process.env.FT_MOCK_EDITS_KIND ?? "FileChange";

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(
    ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"),
  );
  socket.on("data", () => {});
  socket.on("error", () => {});

  if (!EDITS) return;
  /* An agent editing a file, on the stream, the way a real one reports it —
     so what the diff poll is for can be compared against what the socket
     already knows. See `FT_MOCK_EDITS` above. */
  let n = 0;
  const every = setInterval(() => {
    n++;
    push(socket, {
      t: "line",
      id: "s_1",
      events: [
        { lineNo: 100 + n * 2, type: "ItemStarted", item: `edit_${n}`, kind: EDIT_KIND, title: "changed", task: null },
        { lineNo: 101 + n * 2, type: "ItemCompleted", item: `edit_${n}`, status: "Completed" },
      ],
    });
  }, EDITS);
  socket.on("close", () => clearInterval(every));
  socket.on("error", () => clearInterval(every));
});



/**
 * A library with one of each kind in it, so the gallery's four sections and
 * its risk lines can be driven and photographed. `held` is the one an agent
 * wrote that is waiting to be read.
 */
const skill = (over) => ({
  id: "sk_x", name: "a-skill", description: "", version: 1, tokens: 900, bytes: 61270, files: 3,
  alwaysOn: false, builtin: false, held: false, mayShare: true, mayWrite: true,
  author: null, risk: [], defaultIn: [], path: "u/kevin",
  createdAt: minutesAgo(9000), updatedAt: minutesAgo(90), ...over,
  /* **`slug` and `versionId`, both required and both absent** — the second
     under the invented name `currentVersionId`, which nothing has ever
     read. They are after the spread because both are derived from what an
     entry overrode: the slug is the folder's, by `ft_core::slug`'s rule
     (labels are `[A-Za-z0-9_-]`, so every run of anything else becomes one
     `_`), and the version id names the version actually being served. */
  slug: slug(over.name ?? "a-skill"),
  versionId: `sv_${over.id ?? "sk_x"}_${over.version ?? 1}`,
});

/** `ft_core::slug`: a name as a label an `ltree` will accept. */
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "untitled";
}
const SKILLS = [
  skill({
    id: "sk_1", name: "deploy-runbook", version: 0, held: true,
    description: "Deploy the control plane to staging, run the smoke suite, then promote. Use when somebody asks to ship, cut a release or roll back.",
    risk: ["hooks", "scripts"],
  }),
  skill({
    id: "sk_2", name: "firetower-surfaces", version: 4,
    description: "The surfaces Firetower runs on — web, desktop, iOS and Android, and the iPhone Duo's three postures — and which features belong on each.",
    alwaysOn: true,
  }),
  skill({
    id: "sk_3", name: "claude-api", version: 2, defaultIn: ["acme/web"],
    description: "Reference for the Claude API and the Anthropic SDK: model ids, pricing, params, streaming, tool use, MCP, caching and token counting.",
  }),
  skill({
    id: "sk_4", name: "dataviz", version: 1,
    description: "Read before writing any chart, graph, plot or dashboard, in any medium. A form heuristic, a colour formula with a runnable validator, and mark specs.",
    risk: ["scripts"], defaultIn: ["acme/web"],
  }),
  skill({
    id: "sk_5", name: "pr-screenshots", version: 6,
    description: "Drive the app, take the screenshots a pull request needs, and attach them. Use when a change is visible to somebody.",
    risk: ["shell", "scripts"],
  }),
  skill({
    id: "sk_6", name: "skill-creator", version: 3, builtin: true, mayShare: false, mayWrite: false,
    path: "d/firetower", alwaysOn: true,
    description: "Write a new skill, or improve an existing one, and save it to the library.",
  }),
  skill({
    id: "sk_7", name: "incident-timeline", version: 2, mayShare: false, mayWrite: false,
    path: "d/platform", risk: ["tools"],
    description: "Turn an incident channel into the note that goes to the customer. Use when somebody asks for a customer-facing write-up.",
  }),
];

/**
 * What Settings reads, which until the reconciliation was nothing at all.
 *
 * Every one of these paths fell through to the handler's `[]`, so People,
 * Teams, Directories, Vault and Profiles each drew their empty state against
 * the mock and could not be compared with the drawing at all. An empty list
 * is a state worth photographing — it is just not the one those five screens
 * are mostly in.
 */
const COLLEAGUES = [
  { id: "u_1", username: "kevin", slug: "kevin" },
  { id: "u_2", username: "ana" },
  { id: "u_3", username: "lisa" },
  { id: "u_4", username: "tomas" },
  { id: "u_5", username: "priya" },
  { id: "u_6", username: "omar" },
];

const TEAMS = [
  { id: "t_0", name: "Everyone", everyone: true, members: 6 },
  { id: "t_1", name: "Platform", everyone: false, members: 4 },
  { id: "t_2", name: "Design", everyone: false, members: 2 },
  { id: "t_3", name: "Support", everyone: false, members: 3 },
];

const TEAM_MEMBERS = {
  t_0: COLLEAGUES,
  t_1: COLLEAGUES.slice(0, 4),
  t_2: COLLEAGUES.slice(2, 4),
  t_3: COLLEAGUES.slice(3),
};

const DIRECTORIES = [
  { id: "d_1", name: "Platform", slug: "platform", level: "admin", workspaces: 12, skills: 4, secrets: 3, hosts: 1, agentAccounts: 2 },
  { id: "d_2", name: "Design", slug: "design", level: "writer", workspaces: 5, skills: 2, secrets: 1, hosts: 0, agentAccounts: 1 },
  { id: "d_3", name: "Firetower", slug: "firetower", level: "viewer", workspaces: 31, skills: 7, secrets: 6, hosts: 1, agentAccounts: 3 },
];

const GRANTS = {
  d_1: [
    { subjectKind: "person", subjectId: "u_1", subjectName: "kevin", level: "admin" },
    { subjectKind: "team", subjectId: "t_1", subjectName: "Platform", level: "writer" },
    { subjectKind: "person", subjectId: "u_4", subjectName: "tomas", level: "viewer" },
  ],
  d_2: [{ subjectKind: "team", subjectId: "t_2", subjectName: "Design", level: "writer" }],
  d_3: [{ subjectKind: "team", subjectId: "t_0", subjectName: "Everyone", level: "viewer" }],
};

/* The vault, with one of each: a key of this person's own, one a directory
   holds for everybody, and the access log the reveal line points at. */
const SECRETS = {
  rootKey: "ft-root-2026-04",
  intact: true,
  brokenAt: null,
  held: [
    { id: "se_1", scope: "u/kevin", name: "ANTHROPIC_API_KEY", path: "u/kevin", mine: true },
    { id: "se_2", scope: "u/kevin", name: "LINEAR_API_KEY", path: "u/kevin", mine: true },
    { id: "se_3", scope: "d/platform", name: "STAGING_DEPLOY_TOKEN", path: "d/platform", mine: false },
    { id: "se_4", scope: "d/platform", name: "SENTRY_DSN", path: "d/platform", mine: false },
  ],
  access: [
    { id: 3, name: "STAGING_DEPLOY_TOKEN", scope: "d/platform", action: "revealed", at: minutesAgo(40), reason: "read by kevin" },
    { id: 2, name: "ANTHROPIC_API_KEY", scope: "u/kevin", action: "used", at: minutesAgo(190), reason: "Quota meter rounding" },
    { id: 1, name: "SENTRY_DSN", scope: "d/platform", action: "stored", at: minutesAgo(5000), reason: "filed by ana" },
  ],
};

/* **`placement` is `here | new | lead`**, not a directory. Every role here
   carried "Yours" or "Platform" — which is `path`'s job — so no screen was
   ever shown a real placement: the list drew "lead picks where" for all
   three, and the editor's coercion fired on every open. */
const role = (over) => ({
  id: "r_x", name: "A profile", does: "", instructions: "", path: "u/kevin",
  placement: "here", agent: "ClaudeCode", account: null, machine: null,
  /* What a lead may do about a child that has run out of allowance, and
     whether a Manager re-routes one itself. `wait` and `ask` are the
     column defaults; both are required on `Role` and neither was here, so
     `toDraft` copied `undefined` into every draft and the editor's two
     groups of buttons opened with nothing pressed. `onUsageLimit` is
     `wait | same | engine` and `onChildLimit` is `ask | reroute`. */
  onUsageLimit: "wait", onChildLimit: "ask",
  isDefault: false, canDelegate: false, delegateScope: [], skillScope: [],
  includeAlwaysOn: true, includeRepoDefaults: true,
  mayShare: true, mayWrite: true, settings: { model: null, effort: null, mode: null, sandbox: null },
  createdAt: minutesAgo(20000), updatedAt: minutesAgo(400), ...over,
});
const ROLES = [
  role({
    id: "r_1", name: "Reviewer", isDefault: true,
    does: "Reads a change and says what is wrong with it. Never writes.",
    instructions: "Read the diff. Report defects with a file and a line. Do not edit anything.",
    settings: { model: "claude-opus-5", effort: "high", mode: "read-only", sandbox: null },
  }),
  role({
    id: "r_2", name: "Release captain", canDelegate: true, delegateScope: ["r_1"],
    placement: "new", machine: "h_1",
    does: "Cuts a release, watches the smoke suite, and rolls back when it fails.",
    instructions: "Follow the deploy runbook. Stop at the first failing check and say so.",
    settings: { model: "claude-sonnet-5", effort: "medium", mode: null, sandbox: "workspace" },
  }),
  role({
    /* **Open on all three**, which is what a profile that commits to nothing
       looks like on the wire: `placement: "lead"`, no engine, no machine, and
       no subscription — the owner's default for whatever engine it ends up on.
       Without one of these the editor's open states could only be photographed
       on a profile that does not exist yet. */
    id: "r_4", name: "Documentation reviewer",
    placement: "lead", agent: null, machine: null, account: null, canDelegate: true,
    does: "Turns a change into words somebody outside can read, then checks the words against the diff.",
    instructions: "Read the diff, then the docs. Say which sentences are now wrong.",
  }),
  role({
    /* An open *machine* under a committed engine and placement: the state the
       Machines screen's cleanup block is about, and the row that reads
       "new workspace, any machine". */
    id: "r_5", name: "Load tester", path: "u/kevin",
    placement: "new", machine: null, agent: "Codex",
    does: "Hammers a branch until something gives, on whatever is free.",
    instructions: "Ramp until it breaks. Report the shape of the failure, not just the number.",
  }),
  role({
    /* **`lead` on a profile somebody else administers.** Readable here and not
       writable — not because the value is retired (the server takes all three
       now), but because the directory is not this person's. */
    id: "r_3", name: "Triager", path: "d/platform", placement: "lead", mayWrite: false, mayShare: false,
    does: "Reads an inbox of issues and files each one where it belongs.",
    instructions: "Label, assign and close duplicates. Ask before closing anything with a customer on it.",
    settings: { model: "claude-haiku-4-5", effort: null, mode: null, sandbox: null },
  }),
];

/* Enough to list; the kinds page is what the git-host picker offers. */
/**
 * What this server can talk to, as `KindInfo` — the shape the client actually
 * reads.
 *
 * **It was a different shape entirely**: `kind`/`defaultHost`/`ways`/
 * `tokenUrl`, which is nothing `useListKinds`'s consumers look for. So the
 * kind picker — the one place the product ever says what it supports — drew
 * three nameless rows all reading *your own server*, and the hosted forms
 * were missing altogether. Nothing caught it because no state drove the list
 * far enough to read it.
 *
 * `selfHostedLabel` is the field that matters most here: it is what tells
 * somebody with an Enterprise install or a Forgejo that this product can talk
 * to it at all, and it is why the hosted and the self-hosted forms are
 * separate rows rather than one brand.
 */
const PROVIDER_KINDS = [
  { id: "github", label: "GitHub", selfHostedLabel: "GitHub Enterprise Server", changeNoun: "pull request", authModes: ["device", "token"], hostedBaseUrl: "https://github.com", selfHosted: false, appPage: "/settings/applications/new", appSteps: ["Tick **Enable Device Flow**", "Leave the callback URL blank"], tokenSteps: ["Make a token with **repo** and **read:org**"] },
  { id: "gitlab", label: "GitLab", selfHostedLabel: "GitLab self-managed", changeNoun: "merge request", authModes: ["device", "token"], hostedBaseUrl: "https://gitlab.com", selfHosted: false, appPage: "/-/profile/applications", appSteps: ["Untick **Confidential**", "Scopes: **api**, **read_repository**"], tokenSteps: ["Make a token with **api** and **read_repository**"] },
  { id: "gitea", label: "Gitea", selfHostedLabel: "Gitea or Forgejo", changeNoun: "pull request", authModes: ["token"], hostedBaseUrl: null, selfHosted: true, appPage: "/user/settings/applications", appSteps: [], tokenSteps: ["Make a token with the **user** scope"] },
];

const TRACKERS = [
  { id: "gh_1", kind: "github", label: "GitHub", host: "github.com", connected: true, auth: "gitProvider", kinds: ["issue", "pullRequest"], changeNoun: "pull request", scopeKind: "repos", keyUrl: null, secret: null, path: null },
  { id: "tr_linear", kind: "linear", label: "Linear", host: "linear.app", connected: false, auth: "apiKey", kinds: ["ticket"], changeNoun: "change", scopeKind: "teams", keyUrl: "https://linear.app/settings/api", secret: null, path: null },
];

/**
 * What an upgrade would write, and one half-run upgrade.
 *
 * `Updates` draws three things — what is running, what the next version would
 * write over, and a run in progress — and only the first could be reached:
 * `/api/v1/updates/plan` and `/api/v1/updates/runs` both fell through to the
 * handler's `[]`, so pressing Upgrade drew an empty sheet.
 */
const PLAN = {
  version: "0.35.0",
  updaterUpgrade: false,
  envMissing: ["FT_OBJECT_STORE_URL"],
  files: [
    { name: "docker-compose.yml", verdict: "Update", releaseChange: "ft-server pinned to 0.35.0; a new `objects` service", yourEdits: null },
    { name: ".env", verdict: "Edited", releaseChange: "two new keys", yourEdits: "you set FT_LOG=debug" },
    { name: "Caddyfile", verdict: "Unchanged", releaseChange: null, yourEdits: null },
    { name: "objects.yml", verdict: "New", releaseChange: "the object store's own compose file", yourEdits: null },
    { name: "run-local.sh", verdict: "Unshipped", releaseChange: null, yourEdits: "yours; the release does not carry it" },
  ],
};

const step = (position, title, target, state, over = {}) => ({
  position, title, target, state, log: "", detail: null,
  startedAt: state === "pending" ? null : minutesAgo(6 - position),
  finishedAt: state === "running" || state === "pending" ? null : minutesAgo(5 - position),
  ...over,
});
const RUNNING = {
  id: "ur_2",
  state: "running",
  fromVersion: "0.34.1",
  toVersion: "0.35.0",
  whenIdle: false,
  targets: { controlPlane: true, hostIds: ["h_1"] },
  startedBy: "kevin",
  createdAt: minutesAgo(6),
  startedAt: minutesAgo(6),
  finishedAt: null,
  error: null,
  steps: [
    step(0, "Back up the database", "control plane", "done", { detail: "41 MB to /var/lib/firetower/backups" }),
    step(1, "Write the compose file", "control plane", "done"),
    step(2, "Pull 0.35.0", "control plane", "running", { detail: "layer 3 of 7" }),
    step(3, "Restart the control plane", "control plane", "pending"),
    step(4, "Upgrade the worker", "this Mac", "pending"),
  ],
};
const DONE_RUN = {
  ...RUNNING,
  id: "ur_1",
  state: "succeeded",
  fromVersion: "0.33.2",
  toVersion: "0.34.1",
  createdAt: minutesAgo(21600),
  startedAt: minutesAgo(21600),
  finishedAt: minutesAgo(21580),
  steps: RUNNING.steps.map((t) => ({ ...t, state: "done", detail: null })),
};

const TASKS = {
  more: false,
  next: null,
  tasks: [
    { id: "github:acme/web#5138", key: "#5138", kind: "issue", source: "github", state: "open", title: "Quota meter rounds the wrong way at 99.5%", repo: "acme/web", url: "https://example.invalid/5138", updatedAt: minutesAgo(35), body: "The meter reads 100% before the band is reached.", labels: [{ name: "bug", colour: "d73a4a" }], assignees: [{ login: "kevin", avatar: null }] },
    { id: "github:acme/api#812", key: "#812", kind: "issue", source: "github", state: "open", title: "Webhook signatures from Gitea are refused", repo: "acme/api", url: "https://example.invalid/812", updatedAt: minutesAgo(220), body: "Gitea signs with SHA-256.", labels: [{ name: "tracker", colour: "0e8a16" }], assignees: [] },
    { id: "github:acme/web#5141", key: "#5141", kind: "pullRequest", source: "github", state: "open", title: "Light mode for the whole app", repo: "acme/web", url: "https://example.invalid/5141", updatedAt: minutesAgo(90), body: null, labels: [], assignees: [{ login: "ana", avatar: null }] },
    { id: "github:acme/jobs#77", key: "#77", kind: "issue", source: "github", state: "open", title: "Backfill the invoice index out of hours", repo: "acme/jobs", url: "https://example.invalid/77", updatedAt: minutesAgo(1500), body: null, labels: [{ name: "chore", colour: "cfd3d7" }], assignees: [] },
    /* **A task that names no repository**, which the seeded home has to say
       rather than leaving two controls looking broken. Every fixture named
       one, so the state could not be driven at all. */
    { id: "github:acme#91", key: "#91", kind: "issue", source: "github", state: "open", title: "Decide whether we keep the v1 embed", repo: null, url: "https://example.invalid/91", updatedAt: minutesAgo(600), body: null, labels: [], assignees: [] },
  ],
};

/**
 * One real file, so the viewer has something to be.
 *
 * Every path used to answer `[]` — the fall-through — which meant the code
 * pane, the gutter, the syntax layer and the note-on-a-selection could not be
 * driven or photographed at all. This is the file the design's own artifact
 * uses as its example, with a hunk attributed to this session so the gutter
 * has lines to mark.
 */
const QUOTA_RS = `// The quota band, and where it starts.
//
// A plan with no soft limit has no band at all: amber at 80% of a
// ceiling nobody was told about is a warning you cannot act on.

use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Band {
    soft: Option<u64>,
    hard: u64,
}

impl Band {
    // Where amber begins, or None when it never does.
    pub fn amber_at(&self) -> Option<u64> {
        let soft = self.soft?;
        Some(soft * 80 / 100)
    }

    pub fn ratio(&self, used: u64) -> f64 {
        used as f64 / self.hard as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_soft_limit_has_no_band() {
        let b = Band { soft: None, hard: 1_000 };
        assert!(b.amber_at().is_none());
    }
}
`;

/** Text, by path. Anything else is still an empty answer. */
const FILES = {
  "src/quota.rs": QUOTA_RS,
  "package.json": '{\n  "name": "acme-web",\n  "private": true,\n  "version": "0.4.0"\n}\n',
  "README.md": "# acme/web\n\nThe customer-facing app.\n\n- `src/quota.rs` is the band\n- `app/` is the routes\n",
};

/**
 * The hunk this session wrote in `src/quota.rs`.
 *
 * Lines 14-19 — `impl Band` and `amber_at` — so the gutter marks them, the
 * header says `+6`, and the count is clamped to a file of 33 lines rather
 * than reporting more touched than there are.
 */
const QUOTA_DIFF = [
  {
    at: "src/quota.rs",
    path: "src/quota.rs",
    added: 6,
    removed: 1,
    binary: false,
    patch: [
      "diff --git a/src/quota.rs b/src/quota.rs",
      "index 1111111..2222222 100644",
      "--- a/src/quota.rs",
      "+++ b/src/quota.rs",
      "@@ -13,2 +13,7 @@ pub struct Band {",
      "-impl Band {}",
      "+impl Band {",
      "+    // Where amber begins, or None when it never does.",
      "+    pub fn amber_at(&self) -> Option<u64> {",
      "+        let soft = self.soft?;",
      "+        Some(soft * 80 / 100)",
      "+    }",
    ].join("\n"),
  },
];

/**
 * The workspace tree the generated diff implies, one directory at a time.
 *
 * `bigDiff` writes into `web/src/auth`, so this answers `web`, `web/src`,
 * `web/src/auth` and nothing else — which is all the tree asks for.
 */
function listing(path) {
  if (!BIG) {
    // A small tree, for the `@` list's second section.
    const tree = {
      "": [["app", true], ["components", true], ["docs", true], ["src", true], ["package.json", false], ["README.md", false]],
      app: [["checkout", true], ["pricing", true], ["layout.tsx", false], ["page.tsx", false]],
      "app/checkout": [["page.tsx", false], ["form.tsx", false]],
      src: [["ui", true], ["api", true], ["paths.ts", false], ["quota.rs", false]],
      "src/ui": [["Chat.tsx", false], ["Composer.tsx", false]],
      docs: [["artifacts.md", false], ["mentions.md", false], ["shot.png", false]],
    };
    /* `size`, which is what `FileEntry` has and what the row draws.
       `bytes` was this fixture's own word for it, so every file in the
       tree read as sizeless. */
    return (tree[path] ?? []).map(([name, directory]) => ({ name, directory, link: false, size: directory ? 0 : 2048 }));
  }
  const dirs = { "": "web", web: "src", "web/src": "auth" };
  if (path in dirs) return [{ name: dirs[path], directory: true, link: false, size: 0 }];
  if (path !== "web/src/auth") return [];
  return bigDiff(true).map((f) => ({
    name: f.path.split("/").pop(),
    directory: false,
    link: false,
    size: 1024,
  }));
}

/** One text frame, server to client — unmasked, which is the server's half. */
function push(socket, frame) {
  const body = Buffer.from(JSON.stringify(frame));
  let head;
  if (body.length < 126) {
    head = Buffer.from([0x81, body.length]);
  } else if (body.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(body.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(body.length), 2);
  }
  socket.write(Buffer.concat([head, body]));
}

server.listen(PORT, () => console.log(`mock control plane on http://localhost:${PORT}`));
