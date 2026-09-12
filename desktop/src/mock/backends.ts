/**
 * Three servers, because one proves nothing.
 *
 * The memo's client holds N backends the way one Slack client holds N
 * workspaces — a personal box, and one per company. Everything interesting
 * about this client is a consequence of that: the inbox merges across servers,
 * ember has to aggregate, and one backend going dark must not take the others
 * with it.
 *
 * Each has its own fixtures, its own latency and its own reachability, so the
 * states that are hard to design for are switchable rather than imagined.
 */
import type { Session, SessionStatus } from "@/src/api/generated/model";

export type BackendId = "e1" | "e2" | "me";

export type Reach = "live" | "slow" | "unreachable";

export type Backend = {
  id: BackendId;
  /** What the company calls itself. */
  org: string;
  /** Who you are *there*. Two accounts, two tokens, no global identity. */
  user: string;
  /** The monogram in the strip. Identity is a shape here, never a hue. */
  mark: string;
  url: string;
  latency: [number, number];
  reach: Reach;
};

export const BACKENDS: Backend[] = [
  { id: "e1", org: "Westlabs", user: "kevin", mark: "W", url: "https://ft-e1.tailnet.ts.net", latency: [70, 180], reach: "live" },
  { id: "e2", org: "Northbank", user: "k.piacentini", mark: "N", url: "https://ft-e2.tailnet.ts.net", latency: [120, 320], reach: "live" },
  { id: "me", org: "Personal", user: "kevin", mark: "P", url: "https://hetzner.tailnet.ts.net", latency: [40, 90], reach: "live" },
];

const now = Date.now();
const ago = (m: number) => new Date(now - m * 60_000).toISOString();

type Seed = {
  n: number;
  name: string;
  title: string;
  status: SessionStatus;
  repo: string;
  branch: string;
  minutes: number;
  agent: "ClaudeCode" | "Codex";
  note?: string;
};

const SEEDS: Record<BackendId, Seed[]> = {
  e1: [
    { n: 41, name: "device flow", title: "Add the device flow to auth", status: "NeedsYou", repo: "firetower", branch: "ft/device-flow", minutes: 2, agent: "ClaudeCode", note: "Should the device code be single-use across retries, or reusable until it expires?" },
    { n: 40, name: "vault scoping", title: "Scope git tokens per session", status: "Working", repo: "firetower", branch: "ft/scoped-tokens", minutes: 22, agent: "ClaudeCode" },
    { n: 38, name: "flaky test", title: "Chase the flaky updater test", status: "HandedBack", repo: "firetower", branch: "ft/updater-flake", minutes: 64, agent: "Codex", note: "Reproduced it twice. The backup step races the dump; I need a decision on the timeout." },
    { n: 37, name: "docs pass", title: "Rewrite the deployment page", status: "Ended", repo: "firetower", branch: "ft/docs-deploy", minutes: 190, agent: "ClaudeCode" },
    { n: 36, name: "bootstrap", title: "Widen /bootstrap for clients", status: "Ready", repo: "firetower", branch: "ft/bootstrap", minutes: 300, agent: "ClaudeCode" },
  ],
  e2: [
    { n: 12, name: "ledger", title: "Split the ledger reconciliation job", status: "NeedsYou", repo: "northbank/core", branch: "nb/ledger-split", minutes: 8, agent: "Codex", note: "Two tables disagree on rounding. Which one is authoritative?" },
    { n: 11, name: "rate limits", title: "Per-tenant rate limits", status: "Working", repo: "northbank/edge", branch: "nb/rate-limits", minutes: 41, agent: "ClaudeCode" },
    { n: 9, name: "migration", title: "Backfill the accounts table", status: "Failed", repo: "northbank/core", branch: "nb/backfill", minutes: 120, agent: "Codex", note: "Out of disk on the worker at 61%." },
  ],
  me: [
    { n: 7, name: "parser", title: "Rewrite the feed parser", status: "NeedsYou", repo: "kevin/reader", branch: "me/parser", minutes: 14, agent: "ClaudeCode", note: "The old feed has three date formats. Normalise all three, or fail loudly on the third?" },
    { n: 6, name: "css cleanup", title: "Drop the unused tokens", status: "Working", repo: "kevin/reader", branch: "me/tokens", minutes: 33, agent: "ClaudeCode" },
    { n: 5, name: "dotfiles", title: "Tidy the zsh config", status: "Ended", repo: "kevin/dotfiles", branch: "me/zsh", minutes: 1400, agent: "Codex" },
  ],
};

function session(b: BackendId, s: Seed): Session {
  return {
    id: `s_${b}_${s.n}`,
    number: s.n,
    name: s.name,
    title: s.title,
    prompt: s.title,
    status: s.status,
    agent: s.agent as Session["agent"],
    owner: `u_${b}` as Session["owner"],
    hostId: `h_${b}` as Session["hostId"],
    repo: s.repo,
    branch: s.branch,
    base: "main",
    size: "Medium" as Session["size"],
    note: s.note ?? null,
    createdAt: ago(s.minutes),
    updatedAt: ago(Math.max(0, s.minutes - 1)),
    steps: [],
    checkouts: [],
  };
}

/** Mutable so the style page can push a session into `NeedsYou` and watch it land. */
export const STATE: Record<BackendId, Session[]> = {
  e1: SEEDS.e1.map((s) => session("e1", s)),
  e2: SEEDS.e2.map((s) => session("e2", s)),
  me: SEEDS.me.map((s) => session("me", s)),
};

export const backend = (id: BackendId) => BACKENDS.find((b) => b.id === id)!;

/** Knocked over from the style page, and by the scripted timeline. */
export function setReach(id: BackendId, reach: Reach) {
  backend(id).reach = reach;
  emit();
}

const watchers = new Set<() => void>();
export function emit() {
  watchers.forEach((w) => w());
}
export function watch(fn: () => void) {
  watchers.add(fn);
  return () => void watchers.delete(fn);
}
