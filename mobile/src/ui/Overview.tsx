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
import { BEAT, BEAT_TOKEN, STATUS_LABEL, elapsed, minutesSince } from "~/api/view";
import { AgentMark } from "~/ui/AgentMark";
import { Blocks } from "~/ui/Blocks";
import { useTheme } from "~/design/theme";

/** Working first, then whatever wants a human, then the quiet ones. */
const RANK: Record<string, number> = {
  NeedsYou: 0,
  Working: 1,
  Starting: 2,
  Failed: 3,
  HandedBack: 4,
  Ready: 5,
  Ended: 6,
};

function Legend({ children, lit = false, note }: { children: string; lit?: boolean; note?: string }) {
  const { color } = useTheme();
  return (
    <View className="flex-row items-baseline gap-2 px-4 pb-2 pt-4">
      <Text
        className="font-narrow text-micro uppercase tracking-[0.18em]"
        style={{ color: lit ? color.slate : color.mute }}
      >
        {children}
      </Text>
      {note ? <Text className="font-mono text-micro text-mute">{note}</Text> : null}
    </View>
  );
}

/** A member of the team, or the manager above it. */
function Member({
  session,
  active,
  leads = false,
  shared = false,
}: {
  session: Session;
  active: boolean;
  leads?: boolean;
  /** Running in the manager's own workspace rather than one of its own. */
  shared?: boolean;
}) {
  const { color } = useTheme();
  const beat = BEAT[session.status];
  const tone = BEAT_TOKEN[beat];
  return (
    <View className={`flex-row items-start gap-2 rounded-lg px-3 py-2.5 ${active ? "bg-raise" : ""}`}>
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
          <Text
            numberOfLines={1}
            className="min-w-0 shrink font-sans text-meta"
            style={{ color: tone === "mute" ? color.dim : color[tone === "ember" ? "ember-soft" : tone] }}
          >
            {STATUS_LABEL[session.status]}
          </Text>
          <AgentMark agent={session.agent} size={11} tone={color.mute} />
        </View>
      </View>
    </View>
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
}: {
  session: Session;
  /** The workspace that started this one, when it is a child. */
  lead: Session | null;
  team: Session[];
  plan: PlanStep[];
  artifacts: Artifact[];
  onOpenArtifact: (id: string) => void;
}) {
  const { color } = useTheme();
  const manager = lead ?? session;
  const roster = [...team].sort(
    (a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || (a.name ?? "").localeCompare(b.name ?? ""),
  );
  const hasTeam = !!lead || roster.length > 0;
  const done = plan.filter((s) => String(s.status) === "Completed").length;

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
          <Legend>Team</Legend>
          <View className="px-1">
            <Member session={manager} active={manager.id === session.id} leads={roster.length > 0} />
            {roster.map((m) => (
              <Member
                key={m.id}
                session={m}
                active={m.id === session.id}
                shared={!!manager.workspaceId && m.workspaceId === manager.workspaceId}
              />
            ))}
          </View>
        </View>
      ) : null}

      {/* The live thing, above the record of what came out. Slate rather than
          mute, because it is the panel that moves while you watch it. */}
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

      {artifacts.length > 0 || links.length > 0 ? (
        <View className="pb-4">
          <Legend>Artifacts &amp; links</Legend>
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
    </View>
  );
}
