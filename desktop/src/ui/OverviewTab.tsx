/**
 * The Overview tab of the Inspector — a Manager's cockpit.
 *
 * Three live reads of the work, stacked: the **team** it spawned (children, by
 * status), the **artifacts and links** the work produced, and the **plan** it's
 * following. It is only drawn for a workspace that has something to show — a
 * team, artifacts, or a plan — so a solo agent never meets an empty panel. Per
 * the scope: this reads what the app already holds (the sessions list, the
 * artifacts, the conversation's plan); nothing new is fetched for it.
 *
 * Token-per-child spend is a deliberate follow-up: it is recorded server-side
 * (`consumption_events`) but not yet exposed per session, so it isn't drawn.
 */
import { useMemo } from "react";
import { ExternalLink, FileText, GitBranch, GitPullRequest, LayoutList, Link2 } from "lucide-react";
import { navigate } from "~/shims/next-navigation";
import { AgentMark } from "~/components/AgentMark";
import { Blocks } from "~/island/Blocks";
import { beatOf } from "~/api/view";
import { useConversation } from "~/api/conversation";
import { relays } from "~/api/relay";
import { useTokenUsage } from "~/data";
import type { Agent, Artifact, PlanStep, Session, SessionStatus } from "~/api/generated/model";

/** `94100000` → `94.1M`. The context-meter way of saying a big number. */
function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${n}`;
}
/** Segment colours for the budget bar: one per child, in turn. */
const SEGMENTS = ["bg-slate", "bg-sage", "bg-amber", "bg-kind-data", "bg-brick"];

/** The word beside a child's mark. The mark itself — colour and motion — is
 *  the rail's own `Blocks`, so a child reads here exactly as it does there. */
function labelOf(s: SessionStatus): string {
  switch (s) {
    case "Working":
    case "Starting":
      return "working";
    case "NeedsYou":
      return "needs you";
    case "HandedBack":
      return "handed back";
    case "Ready":
      return "ready";
    case "Failed":
      return "failed";
    default:
      return "ended";
  }
}
const RANK: Record<string, number> = { Working: 0, Starting: 0, NeedsYou: 1, Ready: 2, HandedBack: 3, Failed: 4, Ended: 5 };

/** A delegated child is named `"<lead> / <agent>"`; inside the lead's own rail
 *  the prefix is noise, so show just the agent part. */
function agentName(name: string): string {
  const at = name.lastIndexOf(" / ");
  return at >= 0 ? name.slice(at + 3) : name;
}

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="px-3 py-3">
      <div className="mb-2 flex items-center gap-2">
        <h4 className="text-micro font-semibold uppercase tracking-wide text-mute">{title}</h4>
        {note && <span className="ml-auto font-mono text-micro text-mute">{note}</span>}
      </div>
      {children}
    </section>
  );
}

/** The shared shell of a team row — compact: one line of name, one of note,
 *  the token share at the end. The active one (the agent you're reading) wears
 *  the slate highlight, so "you are here" needs no words. */
const ROW = "flex w-full items-center gap-2 rounded-md border px-2 py-1 text-left";
const tone = (active: boolean, link: boolean) =>
  active ? "border-slate bg-slate-tint" : `border-line bg-raise${link ? " transition-colors hover:border-dim" : ""}`;

function TokenShare({ tokens, total }: { tokens: number; total: number }) {
  if (total <= 0) return null;
  return (
    <span className="shrink-0 text-right">
      <span className="block font-mono text-micro text-text">{fmtTokens(tokens)}</span>
      <span className="block text-micro text-mute">{Math.round((tokens / total) * 100)}%</span>
    </span>
  );
}

/** The manager at the top of the Team panel — the level above. The active card
 *  when it is this workspace, a link up when it is the parent of a child. */
function ManagerRow({ manager, active, tokens, total }: { manager: Session; active: boolean; tokens: number; total: number }) {
  const inner = (
    <>
      <AgentMark agent={manager.agent as Agent} size={14} className="shrink-0 text-dim" />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <Blocks beat={beatOf(manager)} size={9} />
        <span className="truncate text-meta text-bone">{agentName(manager.name)}</span>
        <span className="shrink-0 rounded bg-sage-tint px-1 text-micro text-sage">manager</span>
      </span>
      <TokenShare tokens={tokens} total={total} />
    </>
  );
  return active ? (
    <div className={`${ROW} ${tone(true, false)}`}>{inner}</div>
  ) : (
    <button onClick={() => navigate(`/sessions/${manager.id}`)} className={`${ROW} ${tone(false, true)}`}>
      {inner}
    </button>
  );
}

/** One agent on the team. The active one — the session you're reading — is a
 *  plain highlighted row; the rest are links to open them. */
function MemberRow({ member, active, shared, checkIn, tokens, total }: { member: Session; active: boolean; shared: boolean; checkIn?: string; tokens: number; total: number }) {
  const sub = checkIn ?? member.pullRequest ?? member.branch ?? member.spawnReason ?? "";
  // A same-workspace child's `name` is the shared workspace's; its own name is
  // its `title`. Everyone else reads off the workspace name.
  const label = agentName(shared ? member.title : member.name);
  const inner = (
    <>
      <AgentMark agent={member.agent as Agent} size={14} className="shrink-0 text-dim" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <Blocks beat={beatOf(member)} size={9} />
          <span className="truncate text-meta text-bone">{label}</span>
        </span>
        <span className="mt-px block truncate text-micro text-mute">
          {checkIn ? <span className="text-slate">“{sub}”</span> : (<>{labelOf(member.status)}{sub ? ` · ${sub}` : ""}</>)}
        </span>
      </span>
      <TokenShare tokens={tokens} total={total} />
    </>
  );
  return active ? (
    <div className={`${ROW} ${tone(true, false)}`}>{inner}</div>
  ) : (
    <button onClick={() => navigate(`/sessions/${member.id}`)} className={`${ROW} ${tone(false, true)}`}>
      {inner}
    </button>
  );
}

export function OverviewTab({
  session,
  lead,
  team,
  artifacts,
  onOpenArtifact,
}: {
  session: Session;
  /** The manager that started this one, when it is a child. */
  lead: Session | null;
  team: Session[];
  artifacts: Artifact[];
  onOpenArtifact: (id: string, title: string) => void;
}) {
  const conversation = useConversation(session.id).conversation;
  const plan: PlanStep[] = conversation.plan;
  // The latest check-in each child has posted, read straight out of this
  // workspace's own transcript — every update arrived here as a relay-marked
  // turn, so nothing new is fetched. Items are chronological, so the last one
  // per child wins.
  const latestCheckIn = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of conversation.items) {
      for (const r of relays(it.text)) {
        if (r.kind === "update") {
          m.set(r.id, r.body.split("\n").find((l) => l.trim())?.trim() ?? r.body);
        }
      }
    }
    return m;
  }, [conversation.items]);
  // The top of this local view: the workspace itself when it leads a team, or
  // the manager that started it when this is a child — one level up.
  const manager = lead ?? session;
  const kids = [...team].sort(
    (a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || a.name.localeCompare(b.name),
  );
  // Everyone under the manager — the whole team, whichever member you are
  // reading. The one that is this session is just drawn as the active card.
  const roster = kids;
  const working = kids.filter((k) => k.status === "Working" || k.status === "Starting").length;
  const done = plan.filter((s) => String(s.status) === "Completed").length;

  // Token spend for the manager and each member under it. The manager leads
  // the panel — the level above — so its spend is the first segment.
  const ids = useMemo(() => [manager.id, ...roster.map((r) => r.id)], [manager.id, roster]);
  const usage = useTokenUsage(ids);
  const managerTokens = usage.get(manager.id) ?? 0;
  const total = managerTokens + roster.reduce((s, r) => s + (usage.get(r.id) ?? 0), 0);
  const segments = total > 0 ? [managerTokens, ...roster.map((r) => usage.get(r.id) ?? 0)] : [];

  const links: { icon: typeof GitBranch; label: string; href?: string }[] = [];
  if (session.branch) links.push({ icon: GitBranch, label: session.branch });
  if (session.pullRequest) links.push({ icon: GitPullRequest, label: session.pullRequest, href: session.pullRequest });
  if (session.repo) links.push({ icon: Link2, label: session.repo });

  // There is a tree to show whenever this workspace leads a team or hangs off
  // a manager; otherwise it is solo and the panel is skipped.
  const hasTeam = !!lead || kids.length > 0;
  const nothing = !hasTeam && artifacts.length === 0 && links.length === 0 && plan.length === 0;

  return (
    <div className="divide-y divide-line-soft">
      {/* ── Team ── The local tree around this workspace: the manager at the
          top — this workspace when it leads, or the one that started it when
          this is a child — and the agents under it below. A solo workspace has
          neither, so it gets nothing. */}
      {hasTeam && (
        <Panel
          title="Team"
          note={roster.length ? `${roster.length} agent${roster.length > 1 ? "s" : ""}${working ? ` · ${working} working` : ""}` : undefined}
        >
          {total > 0 && (
            <div className="mb-2.5">
              <div className="flex h-1.5 overflow-hidden rounded-full bg-ground">
                {segments.map((t, i) => (
                  <div key={i} className={SEGMENTS[i % SEGMENTS.length]} style={{ width: `${(t / total) * 100}%` }} />
                ))}
              </div>
              <div className="mt-1 flex justify-between font-mono text-micro text-mute">
                <span>{fmtTokens(total)} tokens</span>
                <span>manager + team</span>
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <ManagerRow manager={manager} active={manager.id === session.id} tokens={managerTokens} total={total} />
            {/* Under the manager — the whole team. The one you are reading is
                the active card; the rest are links to open them. */}
            <div className="ml-2 space-y-1 border-l border-line-soft pl-2">
              {roster.map((r) => (
                <MemberRow
                  key={r.id}
                  member={r}
                  active={r.id === session.id}
                  // A child in the manager's own workspace shares its name, so
                  // that name says nothing — use its session title, which the
                  // control plane sets to the child's own name.
                  shared={!!manager.workspaceId && r.workspaceId === manager.workspaceId}
                  checkIn={latestCheckIn.get(r.id)}
                  tokens={usage.get(r.id) ?? 0}
                  total={total}
                />
              ))}
            </div>
          </div>
        </Panel>
      )}

      {/* ── Artifacts & links ── */}
      {(artifacts.length > 0 || links.length > 0) && (
        <Panel title="Artifacts & links">
          {artifacts.length > 0 && (
            <>
              <p className="mb-1 px-1 text-micro text-mute">Artifacts</p>
              {artifacts.map((a) => (
                <button
                  key={a.id}
                  onClick={() => onOpenArtifact(a.id, a.title)}
                  className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-raise"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-dim" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate text-meta text-text">{a.title}</span>
                  <span className="shrink-0 font-mono text-micro text-slate">open</span>
                </button>
              ))}
            </>
          )}
          {links.length > 0 && (
            <>
              <p className="mb-1 mt-2 px-1 text-micro text-mute">Changes & links</p>
              {links.map((l, i) =>
                l.href ? (
                  <a
                    key={i}
                    href={l.href}
                    target="_blank"
                    rel="noreferrer"
                    className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-raise"
                  >
                    <l.icon className="h-3.5 w-3.5 shrink-0 text-dim" strokeWidth={1.75} />
                    <span className="min-w-0 flex-1 truncate text-meta text-text">{l.label}</span>
                    <ExternalLink className="h-3 w-3 shrink-0 text-mute" strokeWidth={1.75} />
                  </a>
                ) : (
                  <div key={i} className="flex items-center gap-2.5 px-1.5 py-1.5">
                    <l.icon className="h-3.5 w-3.5 shrink-0 text-dim" strokeWidth={1.75} />
                    <span className="min-w-0 flex-1 truncate font-mono text-meta text-text">{l.label}</span>
                  </div>
                ),
              )}
            </>
          )}
        </Panel>
      )}

      {/* ── Plan ── */}
      {plan.length > 0 && (
        <Panel title="Plan" note={`${done} / ${plan.length}`}>
          <div className="mb-2 h-1 overflow-hidden rounded-full bg-ground">
            <div className="h-full bg-sage" style={{ width: `${Math.round((done / plan.length) * 100)}%` }} />
          </div>
          <ol className="space-y-1">
            {plan.map((s, i) => {
              const state = String(s.status);
              return (
                <li key={i} className="flex items-start gap-2.5 text-meta">
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                      state === "Completed" ? "bg-sage" : state === "InProgress" ? "bg-slate animate-pulse" : "bg-line"
                    }`}
                  />
                  <span className={state === "Completed" ? "text-mute line-through" : state === "InProgress" ? "text-bone" : "text-text"}>
                    {s.step}
                  </span>
                </li>
              );
            })}
          </ol>
        </Panel>
      )}

      {/* Before the agent has made a plan, cut a branch or delegated anything,
          there is genuinely nothing — say so rather than draw empty panels. */}
      {nothing && (
        <p className="px-3 py-6 text-meta text-mute">
          Nothing to show yet. The plan it's following, the branch it works on, any agents it delegates to and the
          artifacts it produces all appear here.
        </p>
      )}
    </div>
  );
}

/** The tab's icon, exported so the Inspector's TABS can name it. */
export const OverviewIcon = LayoutList;
