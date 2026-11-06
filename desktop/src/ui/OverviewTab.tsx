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
import { Check, ExternalLink, FileText, GitBranch, GitPullRequest, LayoutList, Link2 } from "lucide-react";
import { navigate } from "~/shims/next-navigation";
import { AgentMark } from "~/components/AgentMark";
import { Blocks } from "~/island/Blocks";
import { beatOf, elapsed, minutesSince } from "~/api/view";
import { useConversation } from "~/api/conversation";
import { relays } from "~/api/relay";
import { useHosts, useTokenUsage } from "~/data";
import { whereItRuns } from "~/components/WhereItRuns";
import type { Agent, Artifact, PlanStep, Session, SessionStatus } from "~/api/generated/model";

/** `94100000` → `94.1M`. The context-meter way of saying a big number. */
function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${n}`;
}
/** Segment colours for the token bar. The design system's `series` palette —
 *  the one meant to carry a chart — not the semantic signals (sage = done,
 *  brick = broke), which made the bar read as a status it does not mean. */
const SEGMENTS = ["bg-series-1", "bg-series-2", "bg-series-3", "bg-series-4"];

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

function Panel({
  title,
  note,
  lit,
  children,
}: {
  title: string;
  note?: string;
  /** The live one. A faint wash from the top and a slate heading, so the eye
   *  lands on the thing that is still moving rather than on the record of
   *  what already happened. */
  lit?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className="px-3 py-3"
      style={lit ? { background: "linear-gradient(180deg, rgb(63 134 207 / 0.06), transparent 60%)" } : undefined}
    >
      {/* A section label is a sentence, not a map legend. Tracked-out capitals
          read as shouting and are harder to scan than the words they replaced;
          see `STYLE.md`. */}
      <div className="mb-2 flex items-center gap-2">
        <h4 className={`text-ui font-mid ${lit ? "text-slate" : "text-dim"}`}>{title}</h4>
        {note && <span className="ml-auto text-meta tabular-nums text-mute">{note}</span>}
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
function ManagerRow({ manager, active, color, tokens, total }: { manager: Session; active: boolean; color: string; tokens: number; total: number }) {
  const inner = (
    <>
      {total > 0 && <span className={`h-5 w-0.5 shrink-0 rounded-full ${color}`} title="its slice of the bar" />}
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
function MemberRow({ member, active, shared, color, checkIn, tokens, total }: { member: Session; active: boolean; shared: boolean; color: string; checkIn?: string; tokens: number; total: number }) {
  const sub = checkIn ?? member.pullRequest ?? member.branch ?? member.spawnReason ?? "";
  // A same-workspace child's `name` is the shared workspace's; its own name is
  // its `title`. Everyone else reads off the workspace name.
  const label = agentName(shared ? member.title : member.name);
  const inner = (
    <>
      {total > 0 && <span className={`h-5 w-0.5 shrink-0 rounded-full ${color}`} title="its slice of the bar" />}
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
  // The live one first: Claude Code's todo list and Codex's own plan arrive on
  // the turn stream and update as the agent works. Only when there is none do
  // we fall back to what an agent set through `firetower:plan` — the
  // cross-engine path, which rides on the session and so lands a poll later.
  const live: PlanStep[] = conversation.plan;
  const plan: PlanStep[] = live.length > 0 ? live : (session.plan ?? []);
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
  // The agents the bar's segments stand for, in order, so each slice can name
  // itself on hover. A shared child reads off its title, like its row does.
  const barAgents = [manager, ...roster];
  const nameOf = (a: Session) =>
    agentName(a.id !== manager.id && !!manager.workspaceId && a.workspaceId === manager.workspaceId ? a.title : a.name);

  const links: { icon: typeof GitBranch; label: string; href?: string }[] = [];
  if (session.branch) links.push({ icon: GitBranch, label: session.branch });
  if (session.pullRequest) links.push({ icon: GitPullRequest, label: session.pullRequest, href: session.pullRequest });
  if (session.repo) links.push({ icon: Link2, label: session.repo });

  // There is a tree to show whenever this workspace leads a team or hangs off
  // a manager; otherwise it is solo and the panel is skipped.
  const hasTeam = !!lead || kids.length > 0;
  const hosts = useHosts();
  const where = whereItRuns(hosts.data.find((h) => h.id === session.hostId), hosts.data);

  return (
    <div className="divide-y divide-line-soft">
      {/* ── Where this is ──
          The facts that used to run along the bottom edge in one line of mono.
          A strip of chrome that is always there is a strip nobody reads, and
          these are not chrome — they are what the workspace *is*. As
          sentences, at the top of the thing that describes it. */}
      <section className="px-3 py-3">
        <p className="text-ui text-text">
          {session.repo ? (
            <>
              In <span className="text-bone">{session.repo}</span>
              {session.branch && (
                <>
                  , on <span className="font-mono text-meta text-slate">{session.branch}</span>
                </>
              )}
            </>
          ) : (
            "No repository — a bare agent."
          )}
        </p>
        <p className="mt-1 text-ui text-dim">
          {where ? where.name : "Waiting for a machine"}
          {", "}
          {elapsed(minutesSince(session.createdAt))} in
          {where?.quiet && <span className="text-mute"> · not answering</span>}
          {where?.draining && <span className="text-mute"> · draining</span>}
        </p>
      </section>

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
                  <div
                    key={i}
                    className={SEGMENTS[i % SEGMENTS.length]}
                    style={{ width: `${(t / total) * 100}%` }}
                    title={`${nameOf(barAgents[i])} — ${fmtTokens(t)} tokens · ${Math.round((t / total) * 100)}%`}
                  />
                ))}
              </div>
              <div className="mt-1 flex justify-between font-mono text-micro text-mute">
                <span>{fmtTokens(total)} tokens total</span>
                <span>share by agent</span>
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <ManagerRow manager={manager} active={manager.id === session.id} color={SEGMENTS[0]} tokens={managerTokens} total={total} />
            {/* Under the manager — the whole team. The one you are reading is
                the active card; the rest are links to open them. */}
            <div className="ml-2 space-y-1 border-l border-line-soft pl-2">
              {roster.map((r, i) => (
                <MemberRow
                  key={r.id}
                  member={r}
                  active={r.id === session.id}
                  // Its slice of the bar — segment 0 is the manager, so a child
                  // at roster index i is segment i + 1.
                  color={SEGMENTS[(i + 1) % SEGMENTS.length]}
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

      {/* ── Plan ── Between the team and what they produced: the live thing,
          above the record of what already came out. Only when there is one —
          an agent that keeps no plan is not nagged with an empty panel. */}
      {plan.length > 0 && (
        <Panel title="Plan" lit note={`${done} / ${plan.length} · live`}>
          <div className="mb-2.5 h-1 overflow-hidden rounded-full bg-ground">
            <div
              className="h-full rounded-full bg-sage transition-[width] duration-500"
              style={{ width: `${Math.round((done / plan.length) * 100)}%` }}
            />
          </div>
          <ol className="space-y-1.5">
            {plan.map((s, i) => {
              const state = String(s.status);
              const finished = state === "Completed";
              const doing = state === "InProgress";
              return (
                <li key={i} className="flex items-start gap-2.5 text-meta">
                  <span
                    className={`mt-[3px] grid h-3 w-3 shrink-0 place-items-center rounded-full ${
                      finished ? "bg-sage" : doing ? "animate-pulse border-2 border-slate" : "border border-line"
                    }`}
                  >
                    {finished && <Check className="h-2 w-2 text-ground" strokeWidth={4} />}
                  </span>
                  <span className={finished ? "text-mute line-through" : doing ? "text-bone" : "text-text"}>
                    {s.step}
                  </span>
                </li>
              );
            })}
          </ol>
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

      {/* Before the agent has made a plan or delegated anything there is
          nothing *more* to show — say so rather than draw empty panels. The
          two sentences at the top are always there, which is why this no
          longer has to carry the branch. */}
      {!hasTeam && artifacts.length === 0 && links.length === 0 && plan.length === 0 && (
        <p className="px-3 py-6 text-meta text-mute">
          Nothing else yet. The plan it&rsquo;s following, any agents it delegates to and the artifacts it produces
          all appear here.
        </p>
      )}
    </div>
  );
}

/** The tab's icon, exported so the Inspector's TABS can name it. */
export const OverviewIcon = LayoutList;
