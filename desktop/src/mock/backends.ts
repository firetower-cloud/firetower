/**
 * Three servers, and enough of a fleet in each that the real screens have
 * something true to draw.
 *
 * The shapes here are the generated ones, not inventions: sessions carry a
 * `workspaceId` so `group()` folds several agents into one workspace, a `repo`
 * so the rail groups by repository, and a `branch` because that is the line
 * under every row. Getting these wrong means the real components render an
 * empty or lying screen, which is worse than no prototype.
 */
import type { Session, Task } from "@/src/api/generated/model";

export type BackendId = "e1" | "e2" | "me";
export type Reach = "live" | "slow" | "unreachable";

export type Backend = {
  id: BackendId;
  org: string;
  user: string;
  /** The monogram in the strip. Identity is a shape here, never a hue. */
  mark: string;
  url: string;
  latency: [number, number];
  reach: Reach;
};

export const BACKENDS: Backend[] = [
  { id: "e1", org: "Westlabs", user: "kevin", mark: "W", url: "https://ft-e1.tailnet.ts.net", latency: [60, 150], reach: "live" },
  { id: "e2", org: "Northbank", user: "k.piacentini", mark: "N", url: "https://ft-e2.tailnet.ts.net", latency: [110, 280], reach: "live" },
  { id: "me", org: "Personal", user: "kevin", mark: "P", url: "https://hetzner.tailnet.ts.net", latency: [40, 90], reach: "live" },
];

const T0 = Date.now();
const ago = (m: number) => new Date(T0 - m * 60_000).toISOString();

type Run = {
  agent: "ClaudeCode" | "Codex" | "Shell";
  status: Session["status"];
  minutes: number;
  note?: string;
  title?: string;
};

/** A workspace: a checkout on a host, with the agents working in it. */
type Place = {
  ws: string;
  name: string;
  repo: string;
  branch: string;
  runs: Run[];
  pullRequest?: string;
};

const PLACES: Record<BackendId, Place[]> = {
  e1: [
    {
      ws: "w_e1_device", name: "device flow", repo: "firetower-cloud/firetower", branch: "ft/device-flow",
      runs: [
        { agent: "ClaudeCode", status: "NeedsYou", minutes: 4, title: "Add the device flow to auth", note: "Should the device code be single-use across retries, or reusable until it expires?" },
        { agent: "Codex", status: "Working", minutes: 3, title: "Write the device-flow tests" },
      ],
    },
    {
      ws: "w_e1_tokens", name: "scoped tokens", repo: "firetower-cloud/firetower", branch: "ft/scoped-tokens",
      runs: [
        { agent: "ClaudeCode", status: "Working", minutes: 22, title: "Scope git tokens per session" },
        { agent: "Shell", status: "Working", minutes: 20, title: "cargo watch" },
      ],
    },
    {
      ws: "w_e1_flake", name: "updater flake", repo: "firetower-cloud/firetower", branch: "ft/updater-flake",
      runs: [{ agent: "Codex", status: "HandedBack", minutes: 64, title: "Chase the flaky updater test", note: "Reproduced it twice. The backup step races the dump; I need a decision on the timeout." }],
    },
    {
      ws: "w_e1_boot", name: "bootstrap fields", repo: "firetower-cloud/firetower", branch: "ft/bootstrap",
      runs: [{ agent: "ClaudeCode", status: "Ready", minutes: 180, title: "Widen /bootstrap for native clients" }],
      pullRequest: "https://github.com/firetower-cloud/firetower/pull/101",
    },
    {
      ws: "w_e1_pricing", name: "pricing page", repo: "firetower-cloud/site", branch: "site/pricing",
      runs: [{ agent: "ClaudeCode", status: "Working", minutes: 12, title: "Rework the pricing page" }],
    },
    {
      ws: "w_e1_docs", name: "deployment docs", repo: "firetower-cloud/site", branch: "site/docs-deploy",
      runs: [{ agent: "ClaudeCode", status: "Ended", minutes: 900, title: "Rewrite the deployment page" }],
    },
  ],
  e2: [
    {
      ws: "w_e2_ledger", name: "ledger split", repo: "northbank/core", branch: "nb/ledger-split",
      runs: [{ agent: "Codex", status: "NeedsYou", minutes: 9, title: "Split the ledger reconciliation job", note: "Two tables disagree on rounding. Which one is authoritative?" }],
    },
    {
      ws: "w_e2_limits", name: "rate limits", repo: "northbank/edge", branch: "nb/rate-limits",
      runs: [
        { agent: "ClaudeCode", status: "Working", minutes: 41, title: "Per-tenant rate limits" },
        { agent: "Codex", status: "Working", minutes: 38, title: "Benchmark the limiter" },
      ],
    },
    {
      ws: "w_e2_backfill", name: "accounts backfill", repo: "northbank/core", branch: "nb/backfill",
      runs: [{ agent: "Codex", status: "Failed", minutes: 120, title: "Backfill the accounts table", note: "Out of disk on the worker at 61%." }],
    },
  ],
  me: [
    {
      ws: "w_me_parser", name: "feed parser", repo: "kevin/reader", branch: "me/parser",
      runs: [{ agent: "ClaudeCode", status: "NeedsYou", minutes: 14, title: "Rewrite the feed parser", note: "The old feed has three date formats. Normalise all three, or fail loudly on the third?" }],
    },
    {
      ws: "w_me_tokens", name: "token cleanup", repo: "kevin/reader", branch: "me/tokens",
      runs: [{ agent: "ClaudeCode", status: "Working", minutes: 33, title: "Drop the unused design tokens" }],
    },
    {
      ws: "w_me_zsh", name: "zsh config", repo: "kevin/dotfiles", branch: "me/zsh",
      runs: [{ agent: "Codex", status: "Ended", minutes: 1400, title: "Tidy the zsh config" }],
    },
  ],
};

let counter = 0;
function build(b: BackendId, p: Place): Session[] {
  return p.runs.map((r, i): Session => {
    counter += 1;
    return {
      // The first run of a workspace carries the workspace's own id, which is
      // what `group()` folds on.
      id: i === 0 ? p.ws : `s_${b}_${counter}`,
      workspaceId: p.ws as Session["workspaceId"],
      number: 100 + counter,
      name: p.name,
      title: r.title ?? p.name,
      prompt: r.title ?? p.name,
      status: r.status,
      agent: r.agent as Session["agent"],
      owner: `u_${b}` as Session["owner"],
      hostId: `h_${b}` as Session["hostId"],
      repo: p.repo,
      branch: p.branch,
      base: "main",
      size: "Medium" as Session["size"],
      share: "equal" as Session["share"],
      note: r.note ?? null,
      pullRequest: p.pullRequest ?? null,
      createdAt: ago(r.minutes),
      updatedAt: ago(Math.max(0, r.minutes - 1)),
      steps: ["Fetch", "Worktree", "Workspace", "Setup", "Launch"] as Session["steps"],
      checkouts: [
        {
          slug: p.repo,
          branch: p.branch,
          base: "main",
          path: `/work/${p.name.replace(/\s+/g, "-")}`,
          repoId: `r_${b}`,
        } as NonNullable<Session["checkouts"]>[number],
      ],
      usage: { cpu: 0.4 + i * 0.2, memoryMb: 900 + i * 300, memoryMaxMb: 4096, memoryPeakMb: 1800, oomKills: 0 } as Session["usage"],
    };
  });
}

export const STATE: Record<BackendId, Session[]> = {
  e1: PLACES.e1.flatMap((p) => build("e1", p)),
  e2: PLACES.e2.flatMap((p) => build("e2", p)),
  me: PLACES.me.flatMap((p) => build("me", p)),
};

const person = (login: string) => ({ login, avatar: null });
const label = (name: string, colour: string) => ({ name, colour });

export const TASKS: Record<BackendId, Task[]> = {
  e1: [
    { id: "t1", key: "github:firetower-cloud/firetower#112", source: "github", kind: "issue", state: "open", title: "Device flow: rate-limit the polling endpoint", body: "Ten minutes, single use, and a backoff on the poll.", repo: "firetower-cloud/firetower", url: "https://github.com/firetower-cloud/firetower/issues/112", updatedAt: ago(35), assignees: [person("kevinpiac")], labels: [label("auth", "#7d95b0"), label("security", "#e5645a")] },
    { id: "t2", key: "github:firetower-cloud/firetower#109", source: "github", kind: "issue", state: "open", title: "Per-user notification routing", body: "Notifier::from_env is one URL per install.", repo: "firetower-cloud/firetower", url: "https://github.com/firetower-cloud/firetower/issues/109", updatedAt: ago(180), assignees: [], labels: [label("notifications", "#6ec08a")] },
    { id: "t3", key: "github:firetower-cloud/site#22", source: "github", kind: "pullRequest", state: "open", title: "Pricing page rework", repo: "firetower-cloud/site", url: "https://github.com/firetower-cloud/site/pull/22", updatedAt: ago(12), assignees: [person("kevinpiac")], labels: [label("site", "#9a8cc4")] },
  ],
  e2: [
    { id: "t4", key: "linear:NB-418", source: "linear", kind: "ticket", state: "open", title: "Reconciliation rounding is inconsistent", body: "Ledger and statements disagree at the third decimal.", repo: "northbank/core", url: "https://linear.app/northbank/issue/NB-418", updatedAt: ago(20), assignees: [person("k.piacentini")], labels: [label("ledger", "#c2ab63")] },
    { id: "t5", key: "linear:NB-402", source: "linear", kind: "ticket", state: "open", title: "Edge rate limits per tenant", repo: "northbank/edge", url: "https://linear.app/northbank/issue/NB-402", updatedAt: ago(300), assignees: [], labels: [] },
  ],
  me: [
    { id: "t6", key: "github:kevin/reader#4", source: "github", kind: "issue", state: "open", title: "Feed dates are a mess", repo: "kevin/reader", url: "https://github.com/kevin/reader/issues/4", updatedAt: ago(60), assignees: [], labels: [label("parser", "#7b93b8")] },
  ],
};

export const backend = (id: BackendId) => BACKENDS.find((b) => b.id === id)!;

const watchers = new Set<() => void>();
export function emit() {
  watchers.forEach((w) => w());
}
export function watch(fn: () => void) {
  watchers.add(fn);
  return () => void watchers.delete(fn);
}

export function setReach(id: BackendId, reach: Reach) {
  backend(id).reach = reach;
  emit();
}

/* ── What a workspace is actually doing ───────────────────────────────────
   The control plane models a conversation as an event log — SessionConfigured,
   TurnStarted, ItemStarted/Delta/Completed, TurnCompleted — and the web client
   folds that into turns as it streams.

   The prototype keeps the *pattern* and not the plumbing: a turn has a speaker,
   some tool calls, and sometimes a question that stops everything. Faking the
   event model faithfully would be a week of work that teaches us nothing about
   how the window feels. */

export type Tool = { name: string; arg: string; result?: string; ok?: boolean };

export type Turn =
  | { who: "you"; text: string }
  | { who: "agent"; text: string; tools?: Tool[]; thinking?: string };

export type Ask = { question: string; options?: [string, string][] };

export type Diff = { path: string; added: number; removed: number; hunk: [string, string][] };

export const TALK: Record<string, { turns: Turn[]; ask?: Ask; diffs: Diff[] }> = {
  w_e1_device: {
    turns: [
      { who: "you", text: "Add the device flow to auth. Symmetric to the one we already consume against GitHub." },
      {
        who: "agent",
        thinking: "Looking at how providers.rs consumes the GitHub device flow, so the one we serve matches it.",
        text: "Read `auth.rs`, `accounts.rs` and `providers.rs`. We already consume a device flow, so serving one is symmetric — the same four states, the other way round.\n\nI've added `device_codes` alongside `user_sessions` and two endpoints.",
        tools: [
          { name: "read", arg: "crates/ft-server/src/auth.rs", result: "312 lines", ok: true },
          { name: "read", arg: "crates/ft-server/src/providers.rs", result: "480 lines", ok: true },
          { name: "edit", arg: "crates/ft-server/src/api/auth.rs", result: "+64 −2", ok: true },
          { name: "bash", arg: "cargo check -p ft-server", result: "Finished in 4.2s", ok: true },
        ],
      },
    ],
    ask: {
      question: "Should the device code be single-use across retries, or reusable until it expires?",
      options: [
        ["Single use", "Safer. A poll that arrives twice gets one token and the second attempt fails."],
        ["Reusable", "Kinder to a flaky network, at the cost of a wider replay window."],
      ],
    },
    diffs: [
      {
        path: "crates/ft-server/src/api/auth.rs", added: 64, removed: 2,
        hunk: [
          ["ctx", "pub fn router() -> OpenApiRouter<AppState> {"],
          ["ctx", "    OpenApiRouter::with_openapi(ApiDoc::openapi())"],
          ["del", "        .routes(routes!(bootstrap))"],
          ["add", "        .routes(routes!(bootstrap))"],
          ["add", "        .routes(routes!(auth::device_start))"],
          ["add", "        .routes(routes!(auth::device_token))"],
          ["ctx", "        .routes(routes!(auth::login))"],
          ["ctx", "        .routes(routes!(auth::logout))"],
        ],
      },
      {
        path: "migrations/server/20260912160000_device_codes.sql", added: 18, removed: 0,
        hunk: [
          ["add", "-- A device waiting to be let in."],
          ["add", "create table device_codes ("],
          ["add", "    code_hash   text primary key,"],
          ["add", "    user_code   text not null unique,"],
          ["add", "    user_id     text references users(id) on delete cascade,"],
          ["add", "    expires_at  timestamptz not null"],
          ["add", ");"],
        ],
      },
    ],
  },
  w_e1_tokens: {
    turns: [
      { who: "you", text: "Scope git tokens per session instead of handing over the person's account token." },
      {
        who: "agent",
        text: "Working through `vault.rs` and `askpass.rs`. The owner is already in the vault key's primary key, so the shape is there — what's missing is minting an installation token per session.",
        tools: [
          { name: "read", arg: "crates/ft-server/src/vault.rs", result: "240 lines", ok: true },
          { name: "grep", arg: "credential_for", result: "6 matches", ok: true },
        ],
      },
    ],
    diffs: [{ path: "crates/ft-server/src/vault.rs", added: 22, removed: 6, hunk: [["ctx", "impl Vault {"], ["add", "    /// A token for one repository, for one session."], ["add", "    pub async fn scoped(&self, repo: &str) -> Result<Scoped> {"], ["ctx", "    }"]] }],
  },
  w_e1_flake: {
    turns: [
      { who: "you", text: "Chase the flaky updater test." },
      {
        who: "agent",
        text: "Reproduced it twice out of forty runs. The backup step races the dump: `pg_dump` is still flushing when the step checks the file size, so a slow disk reads as a failed backup.",
        tools: [
          { name: "bash", arg: "cargo test -p ft-server updates:: --count 40", result: "2 failed of 40", ok: false },
          { name: "read", arg: "crates/ft-server/src/updates/runs.rs", result: "610 lines", ok: true },
        ],
      },
    ],
    ask: { question: "Reproduced it twice. The backup step races the dump; I need a decision on the timeout." },
    diffs: [{ path: "crates/ft-server/src/updates/runs.rs", added: 9, removed: 3, hunk: [["del", "        let size = file.metadata()?.len();"], ["add", "        let size = wait_for_flush(&file, Duration::from_secs(30)).await?;"]] }],
  },
  w_e2_ledger: {
    turns: [
      { who: "you", text: "Split the ledger reconciliation job so it can run per-tenant." },
      { who: "agent", text: "The job assumes one global cursor. I've pulled the cursor into a per-tenant row, but the two tables disagree on rounding and I don't want to pick for you.", tools: [{ name: "read", arg: "src/ledger/reconcile.ts", result: "402 lines", ok: true }] },
    ],
    ask: { question: "Two tables disagree on rounding. Which one is authoritative?", options: [["ledger", "Banker's rounding, to the cent."], ["statements", "Half-up, to the cent."]] },
    diffs: [{ path: "src/ledger/reconcile.ts", added: 31, removed: 12, hunk: [["del", "const cursor = await globalCursor();"], ["add", "const cursor = await cursorFor(tenant);"]] }],
  },
  w_me_parser: {
    turns: [
      { who: "you", text: "Rewrite the feed parser — it chokes on half my feeds." },
      { who: "agent", text: "Three of the feeds use different date formats and one of them is not a standard at all. I can normalise all three, or fail loudly on the third so you find out early.", tools: [{ name: "read", arg: "src/feed/parse.ts", result: "180 lines", ok: true }, { name: "bash", arg: "pnpm vitest feed", result: "4 failed", ok: false }] },
    ],
    ask: { question: "The old feed has three date formats. Normalise all three, or fail loudly on the third?" },
    diffs: [{ path: "src/feed/parse.ts", added: 44, removed: 20, hunk: [["add", "const DATES = [rfc822, iso8601, sloppy] as const;"], ["ctx", "export function parseFeed(xml: string) {"]] }],
  },
};

/** Whatever we have; a workspace with nothing scripted still opens. */
export function talkFor(ws: string) {
  return TALK[ws] ?? { turns: [], diffs: [] };
}
