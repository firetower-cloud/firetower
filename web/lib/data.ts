/* Mock data for the Firetower prototype. No backend — this is the UI only. */

/** Mirrors the API's SessionStatus. Screens still on mock data use this. */
export type Status =
  | "Starting"
  | "Working"
  | "NeedsYou"
  | "HandedBack"
  | "Failed"
  | "Ended";

export type Line =
  | { kind: "say"; text: string }
  | { kind: "tool"; name: string; arg: string; result?: string }
  | { kind: "you"; text: string }
  | { kind: "note"; text: string };

export type FileChange = {
  path: string;
  mode: "M" | "A" | "D";
  add: number;
  del: number;
};

export type Session = {
  id: string;
  repo: string;
  name: string;
  prompt: string;
  agent: "Claude Code" | "Codex" | "Shell";
  status: Status;
  /** Present when status is "waiting" — the question, pulled out of the PTY. */
  question?: string;
  /** One-verb heartbeat shown next to running sessions. */
  doing?: string;
  branch: string;
  base: string;
  host: string;
  /** Minutes since launch, or minutes since it ended for terminal states. */
  minutes: number;
  size: string;
  files: FileChange[];
  ports?: { port: number; label: string }[];
  transcript: Line[];
  /** For finished/merged sessions. */
  outcome?: string;
};

/* ── Agents and their credentials ─────────────────────────────────────
   Single-user for v0.1: these are "your" credentials, not a team's.   */

export type CredMode = "subscription" | "api-key" | "cloud";
export type CredState = "connected" | "expiring" | "failed" | "none";

export type AgentCred = {
  agent: "Claude Code" | "Codex" | "Shell";
  version?: string;
  mode?: CredMode;
  /** What the user calls it — plan name, key nickname. */
  label?: string;
  /** Whether the running agent can read the secret. Shown in the UI. */
  placement?: "workspace" | "brokered";
  state: CredState;
  expires?: string;
  daysLeft?: number;
  /** Concurrent agents allowed on this credential, and how many are live. */
  concurrent?: [number, number];
  note?: string;
};

export const AGENTS: AgentCred[] = [
  {
    agent: "Claude Code",
    version: "2.1.44",
    mode: "subscription",
    label: "Max plan",
    placement: "workspace",
    state: "expiring",
    expires: "18 Aug 2026",
    daysLeft: 6,
    concurrent: [4, 10],
  },
  {
    agent: "Codex",
    version: "0.31",
    mode: "api-key",
    label: "OPENAI_API_KEY",
    placement: "brokered",
    state: "connected",
    concurrent: [1, 8],
  },
  { agent: "Shell", state: "connected", note: "No credential needed." },
];

export const IMAGE = {
  tag: "firetower/workspace:0.3.1",
  includes: "node 22 · python 3.12 · git 2.47 · tmux 3.5 · ripgrep",
  agents: "claude-code 2.1.44 · codex 0.31 · shell",
};

export const HOSTS = [
  {
    name: "fire-01",
    state: "online" as const,
    kind: "Hetzner CX41 · fra1",
    cpu: [4, 8],
    ram: [8, 16],
    workspaces: 3,
    uptime: "12d",
    version: "0.3.1",
  },
  {
    name: "fire-02",
    state: "online" as const,
    kind: "Home server · nuc",
    cpu: [7, 16],
    ram: [18, 64],
    workspaces: 5,
    uptime: "4d",
    version: "0.3.1",
  },
  {
    name: "fire-03",
    state: "draining" as const,
    kind: "DigitalOcean · ams3",
    cpu: [2, 4],
    ram: [3, 8],
    workspaces: 1,
    uptime: "31d",
    version: "0.3.0",
  },
];

export const REPOS = [
  { slug: "acme/backend", base: "main", sessions: 3, setup: "mise install && pnpm i" },
  { slug: "acme/frontend", base: "main", sessions: 1, setup: "pnpm i" },
  { slug: "acme/payments", base: "main", sessions: 1, setup: "cargo fetch" },
  { slug: "acme/infra", base: "trunk", sessions: 1, setup: "terraform init" },
];

export const SESSIONS: Session[] = [
  {
    id: "t-104",
    repo: "acme/frontend",
    name: "Rebuild the top navigation",
    prompt:
      "Rebuild the top navigation so it collapses to a drawer under 768px. Keep the existing routes.",
    agent: "Codex",
    status: "NeedsYou",
    question:
      "There are two navigation components in the tree — Nav.tsx (used on marketing pages) and AppNav.tsx (used behind auth). Should I reuse Nav.tsx for both, or replace it with a single new component?",
    branch: "agent/navbar-drawer",
    base: "main",
    host: "fire-01",
    minutes: 7,
    size: "Medium · 2 CPU / 4 GB",
    files: [
      { path: "src/components/Nav.tsx", mode: "M", add: 41, del: 12 },
      { path: "src/components/NavDrawer.tsx", mode: "A", add: 96, del: 0 },
      { path: "src/styles/nav.css", mode: "M", add: 8, del: 3 },
    ],
    ports: [{ port: 5173, label: "vite" }],
    transcript: [
      { kind: "you", text: "Rebuild the top navigation so it collapses to a drawer under 768px. Keep the existing routes." },
      { kind: "tool", name: "Read", arg: "src/components/Nav.tsx", result: "read 184 lines" },
      { kind: "tool", name: "Grep", arg: "<Nav|<AppNav", result: "11 matches in 9 files" },
      {
        kind: "say",
        text: "I've mapped the routes and started on the drawer. Before I wire it up I need a decision on the component split.",
      },
      { kind: "tool", name: "Write", arg: "src/components/NavDrawer.tsx", result: "created · 96 lines" },
      {
        kind: "say",
        text: "There are two navigation components in the tree — Nav.tsx (used on marketing pages) and AppNav.tsx (used behind auth). Should I reuse Nav.tsx for both, or replace it with a single new component?",
      },
    ],
  },
  {
    id: "t-101",
    repo: "acme/backend",
    name: "Stripe webhook retries",
    prompt:
      "Fix retry handling for Stripe webhook processing. Use exponential backoff and cap at 5 attempts.",
    agent: "Claude Code",
    status: "Working",
    doing: "writing tests",
    branch: "agent/stripe-retries",
    base: "main",
    host: "fire-02",
    minutes: 18,
    size: "Medium · 2 CPU / 4 GB",
    files: [
      { path: "src/webhooks/stripe.ts", mode: "M", add: 34, del: 18 },
      { path: "src/lib/retry.ts", mode: "M", add: 88, del: 41 },
      { path: "src/lib/retry.test.ts", mode: "A", add: 112, del: 0 },
      { path: "src/types/webhook.ts", mode: "M", add: 9, del: 2 },
      { path: "src/webhooks/handlers/invoice.ts", mode: "M", add: 12, del: 7 },
      { path: "src/webhooks/handlers/charge.ts", mode: "M", add: 12, del: 7 },
      { path: "src/config/limits.ts", mode: "M", add: 6, del: 1 },
      { path: "docs/webhooks.md", mode: "M", add: 8, del: 18 },
    ],
    ports: [
      { port: 3000, label: "app" },
      { port: 5432, label: "postgres" },
    ],
    transcript: [
      {
        kind: "you",
        text: "Fix retry handling for Stripe webhook processing. Use exponential backoff and cap at 5 attempts.",
      },
      { kind: "tool", name: "Grep", arg: "processWebhook", result: "6 matches in 4 files" },
      { kind: "tool", name: "Read", arg: "src/webhooks/stripe.ts", result: "read 212 lines" },
      {
        kind: "say",
        text: "The handler calls processWebhook directly with no retry wrapper, and the three event handlers each swallow their own errors. I'll add a shared withRetry helper and route all three through it.",
      },
      { kind: "tool", name: "Update", arg: "src/lib/retry.ts", result: "88 additions, 41 removals" },
      { kind: "tool", name: "Update", arg: "src/webhooks/stripe.ts", result: "34 additions, 18 removals" },
      {
        kind: "say",
        text: "Backoff is 250ms × 2ⁿ with full jitter, capped at 5 attempts and a 30s ceiling. Non-retryable Stripe errors (4xx except 429) short-circuit immediately so we don't burn attempts on bad payloads.",
      },
      { kind: "tool", name: "Bash", arg: "npm test -- retry", result: "14 passed, 0 failed  ·  1.8s" },
      {
        kind: "say",
        text: "Tests pass for the helper. Now covering the handler path — replaying a duplicate invoice.payment_failed event and asserting we only commit once.",
      },
      { kind: "tool", name: "Write", arg: "src/lib/retry.test.ts", result: "running…" },
    ],
  },
  {
    id: "t-099",
    repo: "acme/payments",
    name: "Idempotency keys on charge intents",
    prompt:
      "Add idempotency keys to every outbound charge intent and persist them so replays are safe.",
    agent: "Claude Code",
    status: "HandedBack",
    outcome: "Pushed agent/idempotency-keys · ready for review",
    branch: "agent/idempotency-keys",
    base: "main",
    host: "fire-01",
    minutes: 5,
    size: "Large · 4 CPU / 8 GB",
    files: [
      { path: "src/charge/intent.rs", mode: "M", add: 121, del: 44 },
      { path: "src/charge/idempotency.rs", mode: "A", add: 208, del: 0 },
      { path: "migrations/0031_idempotency.sql", mode: "A", add: 24, del: 0 },
      { path: "src/store/mod.rs", mode: "M", add: 61, del: 29 },
      { path: "tests/replay.rs", mode: "A", add: 68, del: 0 },
    ],
    transcript: [
      { kind: "you", text: "Add idempotency keys to every outbound charge intent and persist them so replays are safe." },
      { kind: "tool", name: "Bash", arg: "cargo test", result: "62 passed, 0 failed  ·  22.4s" },
      {
        kind: "say",
        text: "Done. Every intent now carries a UUIDv7 key derived at the call site, stored in a new idempotency_records table with a 24h TTL. Replaying an intent returns the original response instead of charging twice.",
      },
      { kind: "note", text: "Pushed agent/idempotency-keys — 5 files, +482 −73" },
    ],
  },
  {
    id: "t-102",
    repo: "acme/backend",
    name: "Per-tenant rate limiter",
    prompt: "Add a per-tenant rate limiter in front of the public API. Redis-backed.",
    agent: "Claude Code",
    status: "Failed",
    outcome: "Setup script exited 1 — redis-server not found on fire-02",
    branch: "agent/rate-limiter",
    base: "main",
    host: "fire-02",
    minutes: 22,
    size: "Medium · 2 CPU / 4 GB",
    files: [],
    transcript: [
      { kind: "you", text: "Add a per-tenant rate limiter in front of the public API. Redis-backed." },
      { kind: "tool", name: "Bash", arg: "./scripts/setup.sh", result: "redis-server: command not found" },
      { kind: "note", text: "Workspace setup failed. The agent never started." },
    ],
  },
  {
    id: "t-103",
    repo: "acme/backend",
    name: "Split the billing module",
    prompt:
      "Split src/billing into billing/core and billing/adapters. Keep the public API surface identical.",
    agent: "Claude Code",
    status: "Working",
    doing: "running tests",
    branch: "agent/split-billing",
    base: "main",
    host: "fire-02",
    minutes: 42,
    size: "Large · 4 CPU / 8 GB",
    files: [
      { path: "src/billing/core/index.ts", mode: "A", add: 302, del: 0 },
      { path: "src/billing/adapters/stripe.ts", mode: "A", add: 188, del: 0 },
      { path: "src/billing/index.ts", mode: "M", add: 14, del: 291 },
    ],
    transcript: [
      { kind: "you", text: "Split src/billing into billing/core and billing/adapters. Keep the public API surface identical." },
      { kind: "tool", name: "Bash", arg: "npm test", result: "running… 141/218" },
      { kind: "say", text: "Moves are done and the barrel re-exports the same 31 symbols. Running the full suite to confirm nothing shifted." },
    ],
  },
  {
    id: "t-105",
    repo: "acme/infra",
    name: "Pin terraform provider versions",
    prompt: "Pin every terraform provider to an exact version and regenerate the lockfile.",
    agent: "Claude Code",
    status: "Starting",
    doing: "cloning repo",
    branch: "agent/pin-providers",
    base: "trunk",
    host: "fire-01",
    minutes: 1,
    size: "Small · 1 CPU / 2 GB",
    files: [],
    transcript: [{ kind: "note", text: "Creating workspace on fire-01 — fetching acme/infra…" }],
  },
  {
    id: "t-098",
    repo: "acme/docs",
    name: "Refresh the README",
    prompt: "Refresh the README to match the current install flow.",
    agent: "Claude Code",
    status: "Ended",
    outcome: "Merged in #418",
    branch: "agent/readme-refresh",
    base: "main",
    host: "fire-01",
    minutes: 120,
    size: "Small · 1 CPU / 2 GB",
    files: [],
    transcript: [],
  },
  {
    id: "t-097",
    repo: "acme/backend",
    name: "Retry budget spike",
    prompt: "Spike a retry budget model and report back. Don't change production code.",
    agent: "Claude Code",
    status: "Ended",
    outcome: "Discarded yesterday",
    branch: "agent/retry-budget",
    base: "main",
    host: "fire-02",
    minutes: 1580,
    size: "Small · 1 CPU / 2 GB",
    files: [],
    transcript: [],
  },
];

export const byId = (id: string) => SESSIONS.find((t) => t.id === id);

/** Anything in here is blocked on a human. Everything else can wait. */
export const NEEDS_YOU: Status[] = ["NeedsYou", "HandedBack", "Failed"];
export const ACTIVE: Status[] = ["Working", "Starting"];

export const needsYou = () => SESSIONS.filter((t) => NEEDS_YOU.includes(t.status));
export const working = () => SESSIONS.filter((t) => ACTIVE.includes(t.status));
export const recent = () => SESSIONS.filter((t) => t.status === "Ended");

/* A session doesn't "finish" — it hands the work back and waits. The only
   terminal state is Ended: branch shipped, workspace destroyed. */
export const STATUS_LABEL: Record<Status, string> = {
  Starting: "Starting up",
  Working: "Working",
  NeedsYou: "Asked a question",
  HandedBack: "Handed it back",
  Failed: "Failed",
  Ended: "Ended",
};

export const elapsed = (m: number) =>
  m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;

/** The unified diff shown in the review tab. Illustrative, not generated. */
export const DIFF_HUNKS = [
  {
    header: "@@ -139,11 +139,16 @@ export async function handleStripeEvent(",
    lines: [
      { t: " ", n: [139, 139], s: "  const evt = verifySignature(raw, sig)" },
      { t: " ", n: [140, 140], s: "  if (await seen(evt.id)) return ok()" },
      { t: " ", n: [141, 141], s: "" },
      { t: "-", n: [142, null], s: "  await processWebhook(evt)" },
      { t: "-", n: [143, null], s: "  await markSeen(evt.id)" },
      { t: "+", n: [null, 142], s: "  await withRetry(() => processWebhook(evt), {" },
      { t: "+", n: [null, 143], s: "    attempts: 5," },
      { t: "+", n: [null, 144], s: "    backoff: 'exponential'," },
      { t: "+", n: [null, 145], s: "    jitter: 'full'," },
      { t: "+", n: [null, 146], s: "    ceilingMs: 30_000," },
      { t: "+", n: [null, 147], s: "    retryIf: isTransientStripeError," },
      { t: "+", n: [null, 148], s: "  })" },
      { t: "+", n: [null, 149], s: "" },
      { t: "+", n: [null, 150], s: "  await markSeen(evt.id)" },
      { t: " ", n: [144, 151], s: "  return ok()" },
      { t: " ", n: [145, 152], s: "}" },
    ],
  },
  {
    header: "@@ -1,4 +1,9 @@ src/lib/retry.ts",
    lines: [
      { t: "+", n: [null, 1], s: "/** Retries a transient failure with exponential backoff and full jitter. */" },
      { t: "+", n: [null, 2], s: "export async function withRetry<T>(" },
      { t: "+", n: [null, 3], s: "  fn: () => Promise<T>," },
      { t: "+", n: [null, 4], s: "  opts: RetryOptions," },
      { t: "+", n: [null, 5], s: "): Promise<T> {" },
      { t: " ", n: [1, 6], s: "  let attempt = 0" },
      { t: "-", n: [2, null], s: "  while (attempt < 3) {" },
      { t: "+", n: [null, 7], s: "  while (attempt < opts.attempts) {" },
      { t: " ", n: [3, 8], s: "    try {" },
      { t: " ", n: [4, 9], s: "      return await fn()" },
    ],
  },
];
