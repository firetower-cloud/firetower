/**
 * A stand-in control plane for the surfaces that the retired machine touches.
 *
 * A sibling of `mock-server.mjs` rather than a change to it: that one is
 * scoped to a workspace's repositories and holds its own fixture state, and
 * these screens want a fleet that is empty, a fleet with a retired machine
 * behind it, and a session whose machine is not in the fleet at all — three
 * things it has no scene for.
 *
 * Scenes, set by `POST /__scene?s=<name>`:
 *
 *   empty    — a fresh install: no machine, nothing retired
 *   retired  — one ssh machine, plus a retired one with chores and sessions
 *   norecord — one ssh machine, retired one with sessions and no chores
 *
 *   node scripts/mock-retired.mjs [port]
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.argv[2] ?? 4471);

const ORG = { id: "o_1", name: "Acme" };
const USER = { id: "u_1", orgId: "o_1", username: "kevin", role: "admin", mustChangePassword: false };

let scene = "retired";

/* The one machine somebody added over ssh. `compute.type` is `Server`, which
   is now the only kind a client ever sees in a list. */
const SSH_HOST = {
  id: "h_box",
  name: "build-box",
  state: "Online",
  compute: { type: "Server", host: "10.0.4.7", user: "editor", port: null, key: { type: "Managed" } },
  cpus: 16,
  memoryMb: 65536,
  docker: { status: "Running", detail: "28.1.1" },
  drained: false,
  reconnecting: false,
  workerVersion: "0.51.0",
  path: "u/kevin/build-box",
};

/** The machine that is gone — never in `hosts`, only in `hosts/retired`. */
const RETIRED = { id: "h_local", name: "localhost" };

const hosts = () => (scene === "empty" ? [] : [SSH_HOST]);
const retired = () => (scene === "empty" ? [] : [RETIRED]);

/* Repositories connected by a path, which is one of the two chores: a path
   only means something on the machine that did the cloning. */
const PATH_REPOS = [
  { id: "r_web", slug: "acme/web", remote: "/srv/checkouts/web", defaultBranch: "main", env: [] },
  { id: "r_notes", slug: "acme/notes", remote: "~/scratch/notes", defaultBranch: "main", env: [] },
];
const URL_REPOS = [{ id: "r_api", slug: "acme/api", remote: "git@github.com:acme/api.git", defaultBranch: "main", env: [] }];
const repos = () => (scene === "empty" ? [] : scene === "norecord" ? URL_REPOS : [...PATH_REPOS, ...URL_REPOS]);

const role = (id, name, does, machine) => ({
  id,
  name,
  does,
  machine,
  account: null,
  agent: null,
  canDelegate: false,
  createdAt: "2026-10-01T09:00:00Z",
  updatedAt: "2026-10-01T09:00:00Z",
  delegateScope: [],
  skillScope: [],
  instructions: "Run the suite and report back.",
  isDefault: false,
  mayShare: true,
  mayWrite: true,
  path: "u/kevin/qa",
  placement: "new",
  settings: {},
});

const roles = () =>
  scene === "empty"
    ? []
    : scene === "norecord"
      ? [role("ro_qa", "QA", "runs the test suite and reports back", null)]
      : [role("ro_qa", "QA", "runs the test suite and reports back", RETIRED.id)];

/**
 * The sessions that ran in the control plane's container.
 *
 * `hostId` is the retired machine, and that machine is not in `hosts` — which
 * is the whole of what `machineGone` asks. Status is left as it was found,
 * because ending them is what would delete the conversation.
 */
const session = (id, number, name, title, branch, status) => ({
  id,
  owner: "u_1",
  number,
  name,
  title,
  prompt: title,
  size: "Medium",
  status,
  agent: "ClaudeCode",
  hostId: RETIRED.id,
  workspaceId: id,
  createdAt: "2026-10-28T09:12:00Z",
  updatedAt: "2026-10-28T11:48:00Z",
  share: "equal",
  base: "main",
  branch,
  repo: "acme/web",
  checkouts: [{ slug: "acme/web", repoId: "r_web", base: "main", branch, path: "web", trouble: null, pullRequest: null, pullState: null }],
  steps: ["Fetch", "Worktree", "Workspace", "Setup", "Launch"],
  usage: { cpu: 0, memoryMb: 0 },
  note: null,
  pullRequest: null,
  proposedTitle: null,
  proposedBody: null,
  taskKey: null,
  taskUrl: null,
  forgottenAt: null,
});

const GONE = [
  session("s_auth", 3, "auth refactor", "Move session tokens onto the new signing key", "agent/auth-refactor", "Working"),
  session("s_e2e", 4, "flaky e2e", "Find why the checkout e2e fails one run in five", "agent/flaky-e2e", "Ready"),
];

/** A session on the machine that is still here, so a normal workspace exists too. */
const LIVE = {
  ...session("s_live", 5, "ledger import", "Import the October ledger", "agent/ledger", "Working"),
  hostId: SSH_HOST.id,
  workspaceId: "s_live",
};

const sessions = () => (scene === "empty" ? [] : [...GONE, LIVE]);

const say = (item, text) => [
  { lineNo: 0, type: "ItemStarted", item, kind: "AssistantMessage", title: null, task: null },
  { lineNo: 0, type: "ContentDelta", item, stream: "Content", delta: text },
  { lineNo: 0, type: "ItemCompleted", item, status: "Completed" },
];
const asked = (item, text) => [
  { lineNo: 0, type: "ItemStarted", item, kind: "UserMessage", title: null, task: null },
  { lineNo: 0, type: "ContentDelta", item, stream: "Content", delta: text },
  { lineNo: 0, type: "ItemCompleted", item, status: "Completed" },
];

/** A short transcript, complete and readable — which is the claim being tested. */
const conversation = () => ({
  lastLine: 42,
  events: [
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

const AGENTS = () => [
  {
    kind: "ClaudeCode",
    label: "Claude Code",
    enabled: true,
    supported: true,
    needsCredential: true,
    credentialSet: true,
    latestVersion: "2.1.285",
    hosts: hosts().map((h) => ({
      hostId: h.id,
      hostName: h.name,
      installed: true,
      coveredByToken: true,
      loggedIn: true,
      account: "kevin@acme.com",
      version: "2.1.285 (Claude Code)",
      behind: false,
      mayUpdate: true,
    })),
  },
];

const ACCOUNTS = [
  { id: "a_1", kind: "ClaudeCode", name: "Acme · Max", mode: "subscription", isDefault: true, enabled: true, state: "ready", revision: 1, credentialSet: true, identity: "kevin@acme.com", limits: [] },
];

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

  if (path === "/__scene") {
    scene = url.searchParams.get("s") ?? "retired";
    return json(res, { scene });
  }

  /* Saving a repository with an empty fleet: the probe is refused the way a
     control plane with no machine refuses it, and the save is accepted — which
     is the pair AC15 is about. */
  if (req.method === "POST" && path === "/api/v1/repos/probe") {
    return json(
      res,
      {
        code: "NoHost",
        message: "No machine is connected yet, and a repository is read by a machine. Add one under Compute, then try again.",
      },
      409,
    );
  }
  if (req.method === "POST" && path === "/api/v1/repos") return json(res, { id: "r_new", slug: "acme/new", remote: "git@github.com:acme/new.git", defaultBranch: "main", env: [] });

  if (req.method === "PUT" && /^\/api\/v1\/roles\/[^/]+$/.test(path)) return json(res, roles()[0]);

  const routes = {
    "/api/v1/bootstrap": { version: "0.51.0", eventsPath: "/api/v1/events", authModes: ["password"], organization: ORG.name, serverId: "o_1" },
    "/api/v1/auth/me": { user: USER, organization: ORG },
    "/api/v1/setup": { needsPassword: false, needsOrganization: false, needsGithub: false, completed: true, organization: ORG },
    "/api/v1/hosts": hosts(),
    "/api/v1/hosts/retired": retired(),
    "/api/v1/repos": repos(),
    "/api/v1/roles": roles(),
    "/api/v1/sessions": sessions(),
    "/api/v1/agents": AGENTS(),
    "/api/v1/agent-accounts": ACCOUNTS,
    /* A fresh install has no git host connected either, which is the state
       that puts `Repos` into its own `Start` block — the only route to the
       paste-a-remote form. */
    "/api/v1/providers":
      scene === "empty"
        ? [{ id: "github", kind: "GitHub", label: "GitHub", gitHost: "github.com", connected: false, identity: null }]
        : [{ id: "github", kind: "GitHub", label: "GitHub", gitHost: "github.com", connected: true, identity: "kevin" }],
    "/api/v1/trackers": [],
    "/api/v1/artifacts": [],
    "/api/v1/skills": [],
    "/api/v1/events": [],
    /* The control-plane row, with no `sessions` field at all: nothing runs in
       its container, so there is no "sessions will be ended" to warn about. */
    "/api/v1/updates": {
      current: "0.51.0",
      latest: { version: "0.52.0", publishedAt: "2026-11-02T09:00:00Z", notesUrl: null, notes: null, cliMinimum: null },
      checkedAt: "2026-11-06T09:12:00Z",
      checkError: null,
      updateAvailable: true,
      activeRun: null,
      controlPlane: {
        version: "0.51.0",
        upgradable: true,
        mayUpgrade: true,
        reason: null,
        updater: { configured: true, reachable: true, version: "0.51.0", apiVersion: 1, problem: null },
      },
      hosts: hosts().map((h) => ({
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
  };

  const all = [...sessions()];
  for (const s of all) {
    routes[`/api/v1/sessions/${s.id}`] = s;
    routes[`/api/v1/sessions/${s.id}/conversation`] = conversation();
    routes[`/api/v1/sessions/${s.id}/controls`] = [];
    routes[`/api/v1/sessions/${s.id}/account`] = { account: ACCOUNTS[0], limits: [], switches: [] };
    routes[`/api/v1/sessions/${s.id}/annotations`] = [];
    routes[`/api/v1/sessions/${s.id}/diff`] = [];
    routes[`/api/v1/sessions/${s.id}/files`] = [];
  }
  /* `session_work` is refused for a machine that is gone, which is why the
     status bar must not ask at all. If it asks anyway, this is what it gets. */
  for (const s of GONE) {
    routes[`/api/v1/sessions/${s.id}/work`] = null;
  }
  routes[`/api/v1/sessions/${LIVE.id}/work`] = [
    { slug: "acme/web", path: "web", branch: LIVE.branch, base: "main", uncommitted: 4, commits: 2, ahead: 0, pushed: false, pullRequest: null, pullState: null, trouble: null },
  ];

  if (path in routes) {
    const body = routes[path];
    if (body === null) return json(res, { code: "NoHost", message: "that machine is not in this Firetower" }, 409);
    return json(res, body);
  }
  if (path.endsWith("/readiness")) return json(res, { ready: true, checks: [] });
  return json(res, [], 200);
});

/** The event socket, answered and then silent — a reconnect loop behind every
    screenshot is worse than no socket at all. */
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
  socket.on("data", () => {});
  socket.on("error", () => {});
});

server.listen(PORT, () => console.log(`mock control plane (retired-machine scenes) on http://localhost:${PORT}`));
