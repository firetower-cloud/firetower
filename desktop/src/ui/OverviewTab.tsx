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
import { elapsed, minutesSince } from "~/api/view";
import { useConversation } from "~/api/conversation";
import { relays } from "~/api/relay";
import { useHosts } from "~/data";
import { whereItRuns } from "~/components/WhereItRuns";
import type { Agent, Artifact, PlanStep, Session, SessionStatus } from "~/api/generated/model";

/**
 * There is no token bar here, and that is deliberate.
 *
 * This panel carried a four-colour stacked bar, `229.8M tokens total`, and a
 * percentage beside every agent. It is out: four hues in one panel is four
 * more than a screen is allowed, identity in this system is a *mark* and
 * never a hue, and the rail got measurably louder for a number nobody opened
 * the workspace to read.
 *
 * **The numbers were real.** `POST /api/v1/sessions/token-usage` answers a
 * per-session figure and is in the generated client — this was not dropped
 * because it could only have been invented. It is a feature that may come
 * back somewhere it belongs, which is not the team rail.
 */

/** The word beside a child's mark, when it has posted nothing of its own. */
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

/** How long since it last moved, in the rail's own shorthand. */
const age = (at: string) => elapsed(minutesSince(at));

/**
 * One mark, and never a word beside it.
 *
 * **Three, and only three**: an ember dot for *asked you a question*, typing
 * dots for *working*, a tick for *handed back*. The island's four-quadrant
 * `Blocks` was here, which is a different alphabet — it has to carry every
 * status at eleven pixels on a surface with no room for words, and this row
 * has the words right beside it.
 */
function TeamMark({ status }: { status: SessionStatus }) {
  if (status === "NeedsYou") return <span className="dot" title="asked you a question" />;
  if (status === "Working" || status === "Starting") {
    return (
      <span className="typing" title="working">
        <i />
        <i />
        <i />
      </span>
    );
  }
  if (status === "HandedBack" || status === "Ready") {
    return <Check className="h-3.5 w-3.5 text-dim" strokeWidth={2} aria-label="handed back" />;
  }
  if (status === "Failed") return <span className="st" data-s="bad" title="failed" />;
  return <span className="st" data-s="off" title="ended" />;
}

/** The manager at the top of the Team panel — the level above. The active card
 *  when it is this workspace, a link up when it is the parent of a child. */
function ManagerRow({ manager, active }: { manager: Session; active: boolean }) {
  const inner = (
    <>
      <span className="ag">
        <AgentMark agent={manager.agent as Agent} size={15} />
      </span>
      <span className="tx">
        <b>{agentName(manager.name)}</b>
        <s>manager</s>
      </span>
      <span className="rt">
        {active && <span className="here-badge">here</span>}
        <span className="age">{age(manager.createdAt)}</span>
      </span>
    </>
  );
  return active ? (
    <div data-here="true" className="tm">
      {inner}
    </div>
  ) : (
    <button onClick={() => navigate(`/sessions/${manager.id}`)} className="tm">
      {inner}
    </button>
  );
}

/** One agent on the team. The active one — the session you're reading — is a
 *  plain highlighted row; the rest are links to open them. */
function MemberRow({ member, active, shared, checkIn }: { member: Session; active: boolean; shared: boolean; checkIn?: string }) {
  /* **Not the branch.** Every child of one workspace is on the same branch,
     so repeating it on four rows says nothing and crowds out the thing worth
     reading — what this agent is actually doing. Its own check-in first, then
     why it was started, then the status on its own. */
  const sub = checkIn ?? member.spawnReason ?? "";
  // A same-workspace child's `name` is the shared workspace's; its own name is
  // its `title`. Everyone else reads off the workspace name.
  const label = agentName(shared ? member.title : member.name);
  const inner = (
    <>
      <span className="ag">
        <AgentMark agent={member.agent as Agent} size={15} />
      </span>
      <span className="tx">
        <b>{label}</b>
        {/* What it is doing, in a few words. Its own check-in when it has
            posted one, and what the status means when it has not. */}
        <s>{checkIn ? `“${sub}”` : `${labelOf(member.status)}${sub ? ` · ${sub}` : ""}`}</s>
      </span>
      <span className="rt">
        <TeamMark status={member.status} />
        <span className="age">{age(member.createdAt)}</span>
      </span>
    </>
  );
  return active ? (
    <div data-here="true" className="tm">
      {inner}
    </div>
  ) : (
    <button onClick={() => navigate(`/sessions/${member.id}`)} className="tm">
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
          <div>
            <ManagerRow manager={manager} active={manager.id === session.id} />
            {/* Under the manager — the whole team, indented under a hairline.
                The one you are reading is the active card; the rest are links
                to open them. */}
            <div className="kids">
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
