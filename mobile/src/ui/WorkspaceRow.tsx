/**
 * One workspace, as a row you can hold.
 *
 * **Every row carries a mark, in its own tone.** Ember blocked, brick broken,
 * slate working, sage done. A list where one row of three has a mark reads as
 * *missing* rather than as restraint — so the mark is on all of them and the
 * tone is what differs. `BEAT_TOKEN` is the shared fold that decides which, so
 * the phone cannot come to disagree with the desk about what a status means.
 *
 * Two surfaces draw it: the Workspaces destination, and the home's docked
 * column at 951, which is that destination previewed. One component, because
 * the column is meant to be the same list and not a second list that looks
 * like it.
 *
 * `numberOfLines={1}` and **the name gives way, never the timestamp**: the age
 * is four characters and fixed, and a row that drops it to fit a name has lost
 * the only thing on it that changes.
 */
import { Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { router } from "expo-router";
import { lead, type Workspace } from "~/api/workspaces";
import { BEAT, BEAT_TOKEN, elapsed, minutesSince } from "~/api/view";
import { usePeekable } from "~/ui/Peek";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

export function WorkspaceRow({ place, onPeek }: { place: Workspace; onPeek: () => void }) {
  const { color } = useTheme();
  const speaker = lead(place);
  const beat = BEAT[speaker.status];
  const token = BEAT_TOKEN[beat];
  const tone = token === "mute" ? color.dim : token === "ember" ? color["ember-ink"] : color[token];
  const soft = beat === "done" || beat === "over";
  const { gesture, pressed } = usePeekable(onPeek, () => router.push(`/workspace/${place.id}`));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        testID="workspace-row"
        accessibilityRole="button"
        className="min-h-[54px] flex-row items-center gap-3 px-5"
        style={pressed}
      >
        <View className="h-2 w-2 rounded-full" style={{ backgroundColor: tone }} />
        <Text
          numberOfLines={1}
          className={`min-w-0 flex-1 font-sans ${soft ? "text-dim" : "text-bone"}`}
          style={{ fontSize: size.title, letterSpacing: size.title * -0.012 }}
        >
          {place.name}
        </Text>
        <Text className="font-sans text-meta text-mute">{elapsed(minutesSince(speaker.updatedAt))}</Text>
      </Animated.View>
    </GestureDetector>
  );
}
