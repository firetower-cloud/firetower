/**
 * One session: the tab strip, the conversation, and the thing it is asking you.
 *
 * Enough of the workbench to judge the density and the chrome. The real
 * `components/workspace/` is what would sit here — it already has tabs, split
 * panes, a tree and an inspector — and pulling it in is the next step once the
 * shell is settled.
 */
import { useState } from "react";
import { GitBranch, MessageSquare, FileDiff, SquareTerminal, Check, X, CircleSlash2 } from "lucide-react";
import type { Row } from "~/backend";
import { NEEDS_YOU } from "~/backend";

const TABS = [
  { id: "chat", label: "Conversation", icon: MessageSquare },
  { id: "diff", label: "Diff", icon: FileDiff },
  { id: "term", label: "Terminal", icon: SquareTerminal },
] as const;

export function Session({ row }: { row: Row }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("chat");
  const needs = NEEDS_YOU.has(row.status);
  const dark = row.backend.reach === "unreachable";

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-ground">
      {/* Tab strip. The drag region continues across it, so the whole top of
          the window moves the window except the tabs themselves. */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-ui transition-colors ${
              tab === t.id ? "bg-overlay text-bone" : "text-mute hover:bg-raise hover:text-dim"
            }`}
          >
            <t.icon className="h-3.5 w-3.5" strokeWidth={2} />
            {t.label}
          </button>
        ))}
      </div>

      {dark ? (
        <Unreachable org={row.backend.org} />
      ) : (
        <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
          {tab === "chat" && <Conversation row={row} needs={needs} />}
          {tab === "diff" && <Diff />}
          {tab === "term" && <Term />}
        </div>
      )}

      <footer className="flex h-[22px] shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-meta text-mute">
        <span className="flex items-center gap-1">
          <span className="server-mark grid h-3.5 w-3.5 place-items-center text-[8px]">{row.backend.mark}</span>
          {row.backend.org}
        </span>
        <span className="flex items-center gap-1">
          <GitBranch className="h-3 w-3" strokeWidth={2} />
          {row.branch}
        </span>
        <span>{row.repo}</span>
        <span className="ml-auto tabular-nums">{row.agent === "ClaudeCode" ? "Claude Code" : "Codex"}</span>
      </footer>
    </div>
  );
}

function Conversation({ row, needs }: { row: Row; needs: boolean }) {
  return (
    <div className="mx-auto max-w-[760px] px-6 py-5">
      <h1 className="text-display text-bone">{row.title}</h1>
      <p className="mt-1 text-meta text-mute">
        #{row.number} · started {Math.round((Date.now() - Date.parse(row.createdAt)) / 60_000)}m ago
      </p>

      <div className="mt-6 space-y-4">
        <Bubble who="you">{row.prompt}</Bubble>
        <Bubble who="agent">
          Read the surrounding code and the migration history. Two approaches fit; the
          difference matters for how this behaves during an upgrade, so I would rather
          you picked.
        </Bubble>
      </div>

      {/* The one loud thing on the screen, and the whole reason the product
          exists: an agent stopped, and it is waiting for you. */}
      {needs && row.note && (
        <div className="mt-6 rounded-lg border border-ember-deep bg-ember-tint p-4 shadow-(--shadow-raise)">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-ember" />
            <span className="eyebrow !text-ember-soft">Waiting on you</span>
          </div>
          <p className="mt-2 text-body text-bone">{row.note}</p>
          <div className="mt-4 flex gap-2">
            <button className="flex items-center gap-1.5 rounded-md border border-ember-deep bg-ember px-3 py-1.5 text-ui font-medium text-ground transition-opacity hover:opacity-90">
              <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> Approve
            </button>
            <button className="flex items-center gap-1.5 rounded-md border border-line bg-raise px-3 py-1.5 text-ui text-text transition-colors hover:bg-overlay">
              <X className="h-3.5 w-3.5" strokeWidth={2.5} /> Decline
            </button>
            <input
              placeholder="…or answer in words"
              className="min-w-0 flex-1 rounded-md border border-line bg-ground px-3 py-1.5 text-ui text-text placeholder:text-mute focus:border-line focus:outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Bubble({ who, children }: { who: "you" | "agent"; children: React.ReactNode }) {
  return (
    <div>
      <div className="eyebrow mb-1.5">{who === "you" ? "You" : "Agent"}</div>
      <div
        className={`rounded-md border p-3 text-body ${
          who === "you"
            ? "border-line-soft bg-panel text-text"
            : "border-line bg-raise text-text shadow-(--shadow-raise)"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function Diff() {
  const lines: [string, string][] = [
    ["ctx", "pub fn router() -> OpenApiRouter<AppState> {"],
    ["ctx", "    OpenApiRouter::with_openapi(ApiDoc::openapi())"],
    ["del", "        .routes(routes!(bootstrap))"],
    ["add", "        .routes(routes!(bootstrap))       // now carries server_id"],
    ["add", "        .routes(routes!(auth::device_start))"],
    ["add", "        .routes(routes!(auth::device_token))"],
    ["ctx", "        .routes(routes!(auth::login))"],
  ];
  return (
    <div className="p-4">
      <div className="mb-2 flex items-center gap-2 text-meta text-dim">
        <FileDiff className="h-3.5 w-3.5 text-kind-source" strokeWidth={2} />
        <span className="font-mono">crates/ft-server/src/api.rs</span>
        <span className="text-sage">+3</span>
        <span className="text-brick">−1</span>
      </div>
      <div className="overflow-hidden rounded-md border border-line bg-panel font-mono text-code">
        {lines.map(([kind, text], i) => (
          <div
            key={i}
            className={`px-3 py-0.5 ${
              kind === "add"
                ? "bg-sage-tint text-sage"
                : kind === "del"
                  ? "bg-brick-tint text-brick"
                  : "text-dim"
            }`}
          >
            <span className="mr-3 select-none text-mute">{kind === "add" ? "+" : kind === "del" ? "−" : " "}</span>
            {text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Term() {
  return (
    <div className="p-4 font-mono text-code text-text">
      <div className="rounded-md border border-line bg-panel p-3">
        <div className="text-mute">$ cargo test -p ft-server auth::</div>
        <div className="mt-1 text-dim">running 14 tests</div>
        <div className="text-sage">test auth::device::single_use ... ok</div>
        <div className="text-sage">test auth::device::expires ... ok</div>
        <div className="mt-1 text-dim">
          test result: <span className="text-sage">ok</span>. 14 passed; 0 failed
        </div>
        <div className="mt-1 flex items-center text-bone">
          $ <span className="ml-1.5 inline-block h-3.5 w-[7px] animate-pulse bg-bone" />
        </div>
      </div>
    </div>
  );
}

/**
 * The state the memo predicts will be the common one ("Is Tailscale on?").
 * Designed to look deliberate rather than broken: the work is still there, it
 * is the network that is not.
 */
function Unreachable({ org }: { org: string }) {
  return (
    <div className="grid flex-1 place-items-center">
      <div className="max-w-[360px] text-center">
        <CircleSlash2 className="mx-auto h-8 w-8 text-mute" strokeWidth={1.5} />
        <h2 className="mt-3 text-title text-bone">Can’t reach {org}</h2>
        <p className="mt-1.5 text-body text-dim">
          Everything here is still running on their machines. This client just has no
          route to the control plane.
        </p>
        <button className="mt-4 rounded-md border border-line bg-raise px-3 py-1.5 text-ui text-text transition-colors hover:bg-overlay">
          Check Tailscale
        </button>
      </div>
    </div>
  );
}
