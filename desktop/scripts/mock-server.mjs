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

const PORT = Number(process.argv[2] ?? 4401);

const ORG = { id: "o_1", name: "Acme" };
const USER = { id: "u_1", orgId: "o_1", username: "kevin", role: "admin", mustChangePassword: false };

const REPOS = [
  { id: "r_web", slug: "acme/web", remote: "git@github.com:acme/web.git", defaultBranch: "main", env: [] },
  { id: "r_api", slug: "acme/api", remote: "git@github.com:acme/api.git", defaultBranch: "main", env: [] },
  { id: "r_infra", slug: "acme/infra", remote: "git@github.com:acme/infra.git", defaultBranch: "main", env: [] },
  { id: "r_ds", slug: "acme/design-system", remote: "git@github.com:acme/design-system.git", defaultBranch: "main", env: [] },
  { id: "r_docs", slug: "acme/docs", remote: "git@github.com:acme/docs.git", defaultBranch: "trunk", env: [] },
  { id: "r_mobile", slug: "acme/mobile", remote: "git@github.com:acme/mobile.git", defaultBranch: "main", env: [] },
  { id: "r_jobs", slug: "acme/jobs", remote: "git@github.com:acme/jobs.git", defaultBranch: "main", env: [] },
];

const BRANCH = "agent/auth-refactor";

/** What the workspace came up with. `POST /__reset` puts it back to this. */
const START = () => [
  { slug: "acme/web", repoId: "r_web", base: "main", branch: BRANCH, path: "web", trouble: null, pullRequest: null, pullState: null },
  { slug: "acme/api", repoId: "r_api", base: "main", branch: BRANCH, path: "api", trouble: null, pullRequest: null, pullState: null },
  { slug: "acme/infra", repoId: "r_infra", base: "main", branch: BRANCH, path: "infra", trouble: "github.com did not answer — nothing was cloned", pullRequest: null, pullState: null },
];

let checkouts = START();

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
  agent: "ClaudeCode",
  size: "Medium",
  status: "Working",
  hostId: "h_1",
  workspaceId: "w_1",
  createdAt: "2026-09-21T09:12:00Z",
  updatedAt: "2026-09-21T11:48:00Z",
  share: "equal",
  base: "main",
  branch: BRANCH,
  repo: checkouts[0]?.slug ?? null,
  checkouts,
  steps: ["Fetch", "Worktree", "Workspace", "Setup", "Launch"],
  usage: { cpu: 1.4, memoryMb: 940 },
  note: null,
  pullRequest: null,
  proposedTitle: null,
  proposedBody: null,
  taskKey: null,
  taskUrl: null,
  forgottenAt: null,
});

const HOSTS = [
  {
    id: "h_1",
    name: "this Mac",
    state: "Online",
    compute: { type: "Local" },
    cpus: 10,
    memoryMb: 32768,
    docker: { status: "Running", detail: "28.1.1" },
    drained: false,
    reconnecting: false,
    workerVersion: "0.13.0",
  },
];

const AGENTS = [
  {
    kind: "ClaudeCode",
    label: "Claude Code",
    enabled: true,
    hosts: [{ hostId: "h_1", hostName: "this Mac", installed: true, coveredByToken: true, loggedIn: true, account: "kevin@acme.com", version: "2.1.273" }],
  },
  {
    kind: "Codex",
    label: "Codex",
    enabled: true,
    hosts: [{ hostId: "h_1", hostName: "this Mac", installed: true, coveredByToken: true, loggedIn: true, account: "kevin@acme.com", version: "0.155.1" }],
  },
];

const ACCOUNTS = [
  { id: "a_1", kind: "ClaudeCode", name: "Acme · Max", mode: "subscription", isDefault: true, enabled: true, state: "ready", revision: 1, credentialSet: true, identity: "kevin@acme.com", limits: [] },
  { id: "a_2", kind: "Codex", name: "Acme · Plus", mode: "subscription", isDefault: true, enabled: true, state: "ready", revision: 1, credentialSet: true, identity: "kevin@acme.com", limits: [] },
];

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
    checkouts = START();
    return json(res, { detail: "back to three" });
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

  const routes = {
    "/api/v1/bootstrap": { version: "0.13.0", eventsPath: "/api/v1/events", authModes: ["password"], organization: ORG.name, serverId: "o_1" },
    "/api/v1/auth/me": { user: USER, organization: ORG },
    "/api/v1/setup": { needsPassword: false, needsOrganization: false, needsGithub: false, completed: true, organization: ORG },
    "/api/v1/sessions": [session()],
    "/api/v1/sessions/s_1": session(),
    "/api/v1/sessions/w_1": session(),
    "/api/v1/sessions/s_1/work": work(),
    "/api/v1/sessions/s_1/diff": [],
    "/api/v1/sessions/s_1/files": [],
    "/api/v1/sessions/s_1/conversation": conversation(),
    "/api/v1/sessions/s_1/controls": [],
    "/api/v1/sessions/s_1/account": { account: ACCOUNTS[0], limits: [], switches: [] },
    "/api/v1/sessions/s_1/annotations": [],
    "/api/v1/repos": REPOS,
    "/api/v1/hosts": HOSTS,
    "/api/v1/agents": AGENTS,
    "/api/v1/agent-accounts": ACCOUNTS,
    "/api/v1/providers": [{ id: "github", label: "GitHub", connected: true, identity: "kevin" }],
    "/api/v1/trackers": [],
    "/api/v1/updates": { current: "0.13.0", latest: "0.13.0", channel: "stable" },
    "/api/v1/events": [],
  };

  if (path in routes) return json(res, routes[path]);
  if (path.endsWith("/readiness")) return json(res, { ready: true, checks: [] });
  return json(res, [], 200);
});

/**
 * The event socket, answered and then silent.
 *
 * The client holds one for the page and reconnects with backoff when it is
 * refused, so refusing it would put a reconnect loop behind every screenshot.
 * Completing the handshake and sending nothing is what "quiet" looks like.
 */
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(
    ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"),
  );
  socket.on("data", () => {});
  socket.on("error", () => {});
});

server.listen(PORT, () => console.log(`mock control plane on http://localhost:${PORT}`));
