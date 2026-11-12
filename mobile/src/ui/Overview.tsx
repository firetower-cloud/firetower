/**
 * What a workspace is, beside what it said.
 *
 * Ported from the desk's `OverviewTab`, and the panels keep its order for the
 * reason that commit gives: the team, then the live plan, then the record of
 * what came out. The plan sits in the middle because it is the thing moving.
 *
 * **Team is a local view, not the whole tree.** The manager at the top is this
 * workspace when it leads one and the workspace that started it when it is a
 * child — one level up, never further. Everyone under that manager is the
 * roster, whichever member you happen to be reading, and the one that is this
 * session is drawn as the active card rather than hidden.
 *
 * An agent that keeps no plan gets no empty panel. A workspace with no team
 * and nothing produced gets nothing at all — a page of headings over three
 * absences says less than one honest line.
 */
import { Pressable, Text, View } from "react-native";
import { ChevronRight, GitBranch, GitPullRequest, Link2, Shapes } from "lucide-react-native";
import type { Artifact, PlanStep, Session } from "~/api/generated/model";
import { BEAT_TOKEN, beatOf, elapsed, minutesSince, statusLabel } from "~/api/view";
import { opens } from "~/api/workspaces";
import { AgentMark } from "~/ui/AgentMark";
import { Blocks } from "~/ui/Blocks";
import { useTheme } from "~/design/theme";

/**
 * Working first, then whatever wants a human, then the quiet ones.
 *
 * Numbered with a gap at 4, which is where a member this app cannot read
 * goes — see {@link rankOf}. Local to this panel and keyed by status rather
 * than by `Beat`, because the roster separates `Ready` from `HandedBack` and
 * `api/workspaces`'s `RANK` folds both into `done`.
 */
const RANK: Record<string, number> = {
  NeedsYou: 0,
  Working: 1,
  Starting: 2,
  Failed: 3,
  HandedBack: 5,
  Ready: 6,
  Ended: 7,
};

/**
 * Where a member sorts, including one whose status this app has never heard
 * of.
 *
 * It used to be `RANK[status] ?? 9`, which put an unreadable member **below
 * `Ended`** — the quietest place on the roster, for the one state nobody can
 * work out. That is the mistake the rest of this change exists to stop
 * making: `api/view`'s `beatOf` names the gap and `api/workspaces`'s `RANK`
 * files it at 2, with the two that want somebody and above the ones at rest.
 * This is the same answer in this table's own numbering.
 *
 * `Object.hasOwn`, not `??`, for `unrecognised`'s reason: `RANK` is a plain
 * object literal, so `RANK["toString"]` is a function and `??` does not fall
 * through on it. Subtracting it gives `NaN`, and a comparator that answers
 * `NaN` leaves the roster in no defined order at all.
 */
const rankOf = (status: string): number => (Object.hasOwn(RANK, status) ? RANK[status] : 4);

function Legend({
  children,
  lit = false,
  note,
  hot,
}: {
  children: string;
  lit?: boolean;
  note?: string;
  /**
   * The part of the note that wants a person, in ember.
   *
   * On a roster of eight, how many of them are waiting is the first thing you
   * need and the last thing a list of eight two-line rows will tell you.
   */
  hot?: string;
}) {
  const { color } = useTheme();
  return (
    <View className="flex-row items-baseline gap-2 px-4 pb-2 pt-4">
      <Text
        className="font-narrow text-micro uppercase tracking-[0.18em]"
        style={{ color: lit ? color.slate : color.mute }}
      >
        {children}
      </Text>
      {note ? (
        <Text className="font-mono text-micro text-mute">
          {note}
          {hot ? <Text style={{ color: color["ember-ink"] }}>{`, ${hot}`}</Text> : null}
        </Text>
      ) : null}
    </View>
  );
}

/** A member of the team, or the manager above it. */
function Member({
  session,
  active,
  leads = false,
  shared = false,
  onOpen,
}: {
  session: Session;
  active: boolean;
  leads?: boolean;
  /** Running in the manager's own workspace rather than one of its own. */
  shared?: boolean;
  /**
   * Opens the session this row names. Absent for one row only — the one you
   * are already reading. Every other member is a link, which is the desk's
   * rule and the only one: a row that names a real session is never dead
   * under a thumb, whether it has a workspace of its own or shares one.
   */
  onOpen?: () => void;
}) {
  const { color } = useTheme();
  const beat = beatOf(session);
  const tone = BEAT_TOKEN[beat];
  const row = `flex-row items-start gap-2 rounded-lg px-3 py-2.5 ${active ? "bg-raise" : ""}`;
  const inner = (
    <>
      <View className="pr-0.5 pt-[5px]">
        <Blocks beat={beat} />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-2">
          {/* A subagent in the manager's workspace carries the workspace's
              name, so a roster of them reads as the same row four times. Its
              title is the only thing that says what it was sent to do. */}
          <Text numberOfLines={1} className="min-w-0 flex-1 font-medium text-ui text-bone">
            {(shared ? session.title : session.name) || session.title}
          </Text>
          {leads ? <Text className="font-narrow text-micro uppercase tracking-[0.14em] text-mute">leads</Text> : null}
          <Text className="font-sans text-micro text-mute">{elapsed(minutesSince(session.updatedAt))}</Text>
        </View>
        <View className="flex-row items-center gap-2">
          {/* **What it asked, when it is asking.** `STATUS_LABEL` on eight
              rows reads "Asked a question / Working / Working", which sends
              you to look without saying what at — and now that a child has no
              row of its own, this panel is where you go. The note is already
              on the session and the peek already reads it. */}
          <Text
            numberOfLines={1}
            className="min-w-0 shrink font-sans text-meta"
            style={{ color: tone === "mute" ? color.dim : color[tone === "ember" ? "ember-soft" : tone] }}
          >
            {(session.status === "NeedsYou" ? session.note : null) || statusLabel(session.status)}
          </Text>
          <AgentMark agent={session.agent} size={11} tone={color.mute} />
        </View>
      </View>
      {/* The desk says *this opens something* by lighting the row under the
          pointer. A phone has no pointer, so the affordance has to be drawn —
          and this is the glyph the Made rows below already use for it. Every
          row but the one you are reading carries it, so the panel reads as a
          list of places to go rather than a list with one or two. */}
      {onOpen ? (
        <View className="pt-[7px]">
          <ChevronRight color={color.mute} size={14} />
        </View>
      ) : null}
    </>
  );
  /* The row is already two lines and well past the 44pt floor `STYLE.md` sets
     for anything tappable, so the target is the row itself rather than a
     control inside it. A pressable row is never the active one — `opens`
     returns nothing for the session you are already reading — so the two
     `bg-raise` states cannot land on the same row. */
  return onOpen ? (
    <Pressable
      testID="overview-member"
      onPress={onOpen}
      className={`${row} active:bg-raise`}
      android_ripple={{ color: color.overlay }}
    >
      {inner}
    </Pressable>
  ) : (
    <View className={row}>{inner}</View>
  );
}

/** One line of the plan. Done is ticked, the live one wears a ring. */
function Step({ step }: { step: PlanStep }) {
  const { color } = useTheme();
  const state = String(step.status);
  const done = state === "Completed";
  const live = state === "InProgress";
  return (
    <View className="flex-row items-start gap-2.5 px-3 py-1.5">
      <View className="pt-[3px]">
        <View
          className="h-[13px] w-[13px] items-center justify-center rounded-full"
          style={{
            borderWidth: done ? 0 : 1.5,
            borderColor: live ? color.slate : color.settling,
            backgroundColor: done ? color.sage : "transparent",
          }}
        >
          {done ? <View className="h-[5px] w-[5px] rounded-full" style={{ backgroundColor: color.ground }} /> : null}
          {live ? <View className="h-[5px] w-[5px] rounded-full" style={{ backgroundColor: color.slate }} /> : null}
        </View>
      </View>
      <Text
        className="min-w-0 flex-1 font-sans text-meta"
        style={{ color: done ? color.mute : live ? color.bone : color.text }}
      >
        {step.step}
      </Text>
    </View>
  );
}

export function Overview({
  session,
  lead,
  team,
  plan,
  artifacts,
  onOpenArtifact,
  onOpenSession,
}: {
  session: Session;
  /** The workspace that started this one, when it is a child. */
  lead: Session | null;
  team: Session[];
  plan: PlanStep[];
  artifacts: Artifact[];
  onOpenArtifact: (id: string) => void;
  /**
   * Opens one session of the team. The phone has no session route, so this is
   * `/workspace/<session id>` — `runAt` is what the route does with an
   * address that names a run rather than a place.
   */
  onOpenSession: (id: string) => void;
}) {
  const { color } = useTheme();
  const manager = lead ?? session;
  const roster = [...team].sort(
    (a, b) => rankOf(a.status) - rankOf(b.status) || (a.name ?? "").localeCompare(b.name ?? ""),
  );
  const hasTeam = !!lead || roster.length > 0;
  const done = plan.filter((s) => String(s.status) === "Completed").length;
  /* The roster, not the roster plus the manager: it is the same set the row
     that opened this panel counts — *the 8 agents it started*. */
  const waiting = roster.filter((m) => m.status === "NeedsYou").length;

  /**
   * Where a team row goes, which is the desk's answer and nothing added to it.
   *
   * The resolution that used to live here — session to workspace, through
   * `placeOf`, before the row was allowed to be a button at all — is the bug
   * this panel shipped twice. It could fail, and a row that failed it went
   * silently dead: no chevron, no press, a name under a thumb that does
   * nothing. Worst of all on the commonest team there is, a manager with
   * subagents in its own checkout, where *every* row resolved back to the
   * workspace being read and the whole panel was furniture.
   *
   * The resolving still has to happen — `/workspace/<id>` is the only route
   * the phone has. It happens on the other side of the tap now, in the route,
   * where failing means a screen that says so rather than a row that says
   * nothing. See `opens` and `runAt` in `~/api/workspaces`.
   */
  const tap = (member: Session) => {
    const to = opens(member, session);
    return to ? () => onOpenSession(to) : undefined;
  };

  const links: { icon: typeof GitBranch; label: string }[] = [];
  if (session.branch) links.push({ icon: GitBranch, label: session.branch });
  if (session.pullRequest) links.push({ icon: GitPullRequest, label: session.pullRequest });
  if (session.repo) links.push({ icon: Link2, label: session.repo });

  if (!hasTeam && plan.length === 0 && artifacts.length === 0 && links.length === 0) {
    return (
      <View className="items-center px-8 py-16">
        <Text className="text-center font-sans text-ui text-dim">Nothing around this one yet.</Text>
        <Text className="mt-1 text-center font-sans text-meta text-mute">
          No team, no plan, nothing produced.
        </Text>
      </View>
    );
  }

  return (
    <View>
      {hasTeam ? (
        <View className="border-b border-line-soft pb-2">
          <Legend
            note={roster.length ? `${roster.length} ${roster.length === 1 ? "agent" : "agents"}` : undefined}
            hot={waiting ? `${waiting} waiting` : undefined}
          >
            Team
          </Legend>
          <View className="px-1">
            <Member
              session={manager}
              active={manager.id === session.id}
              leads={roster.length > 0}
              onOpen={tap(manager)}
            />
            {/* **A step in from the manager, under a hairline dropped from its
                own mark.** The desk's `.kids` — 17 of margin, 13 of padding,
                one line of `--color-line` — and the same depth here, because
                what a child *is* does not change with the screen it is drawn
                on. 18 rather than 17 only because the phone's mark is 13pt
                inside 12 of row padding, so that is where its centre lands.

                Without it the roster sat at the manager's own indent and a
                team of four read as a flat list of five peers. */}
            {roster.length > 0 ? (
              <View className="ml-[18px] border-l border-line pl-[13px]">
                {roster.map((m) => (
                  <Member
                    key={m.id}
                    session={m}
                    active={m.id === session.id}
                    shared={!!manager.workspaceId && m.workspaceId === manager.workspaceId}
                    onOpen={tap(m)}
                  />
                ))}
              </View>
            ) : null}
          </View>
        </View>
      ) : null}

      {artifacts.length > 0 || links.length > 0 ? (
        <View className="pb-4">
          <Legend>Made</Legend>
          {artifacts.map((a) => (
            <Pressable
              key={a.id}
              testID="overview-artifact"
              onPress={() => onOpenArtifact(a.id)}
              className="flex-row items-center gap-2.5 px-4 py-2"
              android_ripple={{ color: color.overlay }}
            >
              <Shapes color={color.dim} size={15} />
              <Text numberOfLines={1} className="min-w-0 flex-1 font-sans text-ui text-text">
                {a.title}
              </Text>
              <Text className="font-mono text-micro text-mute">v{a.version}</Text>
              <ChevronRight color={color.mute} size={14} />
            </Pressable>
          ))}
          {links.map((l) => (
            <View key={l.label} className="flex-row items-center gap-2.5 px-4 py-2">
              <l.icon color={color.mute} size={15} />
              <Text numberOfLines={1} className="min-w-0 flex-1 font-mono text-meta text-dim">
                {l.label}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {/* Last, and the drawing puts it there on purpose: **Team, Made, Plan**.
          The record of what came out sits above the thing still being worked
          on, because *what has this produced* is the question somebody opens
          this panel to answer and the plan is already narrated in the
          transcript beside it. Slate rather than mute, because it is the one
          panel that moves while you watch it. */}
      {plan.length > 0 ? (
        <View className="border-b border-line-soft bg-panel pb-3">
          <Legend lit note={`${done} / ${plan.length} · live`}>
            Plan
          </Legend>
          {plan.map((s, i) => (
            <Step key={`${i}-${s.step}`} step={s} />
          ))}
        </View>
      ) : null}

    </View>
  );
}
