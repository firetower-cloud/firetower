/**
 * A workspace, in two lines.
 *
 * Name, ember dot and elapsed on the first; branch in mono and the agent marks
 * on the second. The branch is not optional decoration and it is not dropped
 * for width — it is how you tell two workspaces on one repository apart, which
 * on 390pt matters more than it does on a monitor, not less.
 *
 * 56pt, not the desk's 34px. A Mac is mouse-only and can be tighter; this is
 * the touch floor with two lines of content in it.
 */
import { Pressable, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import type { Workspace } from "~/api/workspaces";
import { doing, lead } from "~/api/workspaces";
import { BEAT, BEAT_TOKEN, elapsed, minutesSince, STATUS_LABEL } from "~/api/view";
import { AgentMark } from "~/ui/AgentMark";
import { Blocks } from "~/ui/Blocks";
import { color } from "~/design/tokens.generated";

/**
 * What this place is up to, in words.
 *
 * The agent's own note when it left one — it is always better than anything
 * derivable. Otherwise the same rule the desk's `outcomeOf` follows: say only
 * what is actually known. "Waiting on you" over a run that finished and opened
 * a pull request is the kind of small lie that makes somebody stop trusting
 * the rest of the screen.
 */
function line(place: Workspace): string {
  const speaker = lead(place);
  const asked = place.runs.find((r) => r.status === "NeedsYou" || r.status === "Failed");
  if (asked?.note) return asked.note;

  if (speaker.status === "HandedBack") {
    const open = place.runs.some((r) => r.checkouts?.some((c) => c.pullRequest));
    return open ? "Pull request open" : "Handed it back";
  }

  switch (doing(place)) {
    case "waiting":
      return "Waiting on you";
    case "working": {
      const n = place.runs.filter((r) => r.status === "Working").length;
      return n > 1 ? `${n} agents working` : "Working";
    }
    default:
      return STATUS_LABEL[speaker.status];
  }
}

export function WorkspaceRow({ place, onPress }: { place: Workspace; onPress?: () => void }) {
  const speaker = lead(place);
  /* Ember, and the tinted row, mean exactly one thing: an agent stopped and
     cannot go on until you answer. `needsYou` is a wider question — it also
     covers finished and broken, which belong on the list but are not the loud
     thing — so the tint is keyed to the status, not to the grouping. A failure
     painted ember spends the one colour that means "answer me" on something
     that is not asking. */
  const blocked = place.runs.some((r) => r.status === "NeedsYou");
  /* The second line takes the lead run's own meaning, so a red cross is never
     sitting next to an ember sentence. */
  const tone = BEAT_TOKEN[BEAT[speaker.status]];
  /* The agents in this place, each once. Four Claude runs is one mark. */
  const agents = [...new Set(place.runs.map((r) => r.agent))];

  return (
    <Pressable
      onPress={onPress}
      className={`flex-row items-start gap-1 rounded-lg px-3 py-2.5 ${blocked ? "bg-ember-tint" : ""}`}
      android_ripple={{ color: color.overlay }}
    >
      {/* Nudged down by a hair so the glyph sits on the name's baseline band
          rather than between the two lines, which is where centring put it. */}
      <View className="pr-1 pt-[5px]">
        <Blocks beat={BEAT[speaker.status]} />
      </View>

      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-2">
          <Text numberOfLines={1} className="min-w-0 flex-1 font-medium text-title text-bone">
            {place.name}
          </Text>
          <Text className="font-sans text-meta text-mute">{elapsed(minutesSince(speaker.updatedAt))}</Text>
        </View>

        <Text
          numberOfLines={1}
          className="font-sans text-meta"
          style={{ color: tone === "mute" ? color.dim : color[tone === "ember" ? "ember-soft" : tone] }}
        >
          {line(place)}
        </Text>

        <View className="mt-0.5 flex-row items-center gap-2">
          {place.branch ? (
            <Text numberOfLines={1} className="min-w-0 shrink font-mono text-meta text-mute">
              {place.branch}
            </Text>
          ) : null}
          <View className="flex-row items-center gap-1.5">
            {agents.map((a) => (
              <AgentMark key={a} agent={a} size={12} tone={color.mute} />
            ))}
          </View>
        </View>
      </View>

      <View className="pt-[5px]">
        <ChevronRight color={color.mute} size={16} />
      </View>
    </Pressable>
  );
}
