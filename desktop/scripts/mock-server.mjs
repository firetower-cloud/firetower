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

/* `latestVersion` and `behind` are the published-against-installed pair the
   control plane now works out for itself — see `updates::agents`. The numbers
   here are the ones a real check produced: Claude Code 2.1.273 installed
   against 2.1.285 published, which is a host that has quietly been behind
   since the day it was added. Codex is left current, so both states can be
   looked at on one screen. */
const AGENTS = [
  {
    kind: "ClaudeCode",
    label: "Claude Code",
    enabled: true,
    supported: true,
    needsCredential: true,
    credentialSet: true,
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
    latestVersion: "0.159.2",
    hosts: [{ hostId: "h_1", hostName: "this Mac", installed: true, coveredByToken: true, loggedIn: true, account: "kevin@acme.com", version: "0.159.2", behind: false, mayUpdate: true }],
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
      { label: "Accept edits", value: "acceptEdits", note: "Writes files without asking. Commands still ask", grave: true },
      { label: "Never ask", value: "dontAsk", note: "Refuses anything not already allowed, rather than asking", grave: true },
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
  { lineNo: 20, type: "TaskProgress", task: "task_1", detail: "Reading desktop/src/island/state.ts" },
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
            "Seven surfaces read `SessionStatus`. Two of them — `Signal` and the island's blocks — draw the resting tick, and neither consults in-flight tasks.",
        },
        { lineNo: 42, type: "ItemCompleted", item: "call_1", status: "Completed" },
      ]
    : []),
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

const conversation = () => ({
  lastLine: 42,
  events:
    scene === "subagent"
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
    checkouts = START();
    scene = url.searchParams.get("scene") ?? "default";
    return json(res, { detail: `back to three, playing ${scene}` });
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
    "/api/v1/sessions/s_1/diff": bigDiff(url.searchParams.get("namesOnly") === "true"),
    "/api/v1/sessions/s_1/files": BIG ? listing(url.searchParams.get("path") ?? "") : [],
    "/api/v1/sessions/s_1/conversation": conversation(),
    "/api/v1/sessions/s_1/controls": scene.startsWith("codex") ? [] : CLAUDE_CONTROLS,
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
 * The workspace tree the generated diff implies, one directory at a time.
 *
 * `bigDiff` writes into `web/src/auth`, so this answers `web`, `web/src`,
 * `web/src/auth` and nothing else — which is all the tree asks for.
 */
function listing(path) {
  if (!BIG) return [];
  const dirs = { "": "web", web: "src", "web/src": "auth" };
  if (path in dirs) return [{ name: dirs[path], directory: true, link: false, bytes: 0 }];
  if (path !== "web/src/auth") return [];
  return bigDiff(true).map((f) => ({
    name: f.path.split("/").pop(),
    directory: false,
    link: false,
    bytes: 1024,
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
