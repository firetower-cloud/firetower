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
 *
 * ## And a row now stands for a family
 *
 * A workspace that delegated to another workspace has that child's row hidden
 * under this one — so three things on this row are the *family's* rather than
 * the place's own, and all three come from `~/api/workspaces`:
 *
 * - **the mark**, `placeBeat`, so an idle parent with a blocked child wears
 *   the same ember the child's own row wore;
 * - **the age**, `lastMoved`, so it does not read 3h while something under it
 *   moved a minute ago;
 * - **a second line**, `childLine`, which is the only thing on the screen that
 *   says what is under here. It hangs off a hairline dropped from the mark —
 *   the figure `Overview` uses for its roster, so the row is a miniature of
 *   the panel it opens.
 *
 * **A row with no children is untouched**, at 54pt and one line. The height is
 * information: a taller row stands for more work. The alternative — a fixed
 * 66 with the second line blank — is a list of half-empty rows, which reads as
 * something failing to load.
 */
import { Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { router } from "expo-router";
import { asking, childLine, familyOf, lastMoved, placeBeat, rowLabel, type Workspace } from "~/api/workspaces";
import { BEAT_TOKEN, elapsed, minutesSince } from "~/api/view";
import { usePeekable } from "~/ui/Peek";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

export function WorkspaceRow({
  place,
  places,
  onPeek,
}: {
  place: Workspace;
  /**
   * The whole fleet, children included — not the rows being drawn.
   *
   * Everything family-wide here goes looking for workspaces this list has
   * deliberately left out, so handed the drawn rows it would find none of
   * them and quietly answer for the place alone. See `familyOf`.
   */
  places: Workspace[];
  onPeek: () => void;
}) {
  const { color } = useTheme();
  const beat = placeBeat(place, places);
  const token = BEAT_TOKEN[beat];
  const tone = token === "mute" ? color.dim : token === "ember" ? color["ember-ink"] : color[token];
  const soft = beat === "done" || beat === "over";
  /* Family-wide, and the desk's rail is the one place this is still read off
     `place.runs` — so there a parent with a blocked child gets the ember mark
     and a quiet name. One question, one answer, one row. */
  const hot = asking(place, places).length > 0;
  const kids = childLine(place, places);
  const said = kids
    ? kids.tone === "blocked"
      ? color["ember-ink"]
      : kids.tone === "broken"
        ? color.brick
        : color.dim
    : undefined;
  const { gesture, pressed } = usePeekable(onPeek, () => router.push(`/workspace/${place.id}`));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        testID="workspace-row"
        accessibilityRole="button"
        className="min-h-[54px] flex-row items-start gap-3 px-5"
        style={pressed}
      >
        {/* The mark, and the hairline the second line hangs from. `self-stretch`
            rather than a fixed height: the drop has to reach the bottom of
            whatever the body turned out to be. */}
        <View className="w-2 items-center self-stretch pt-[19px]">
          <View className="h-2 w-2 rounded-full" style={{ backgroundColor: tone }} />
          {kids ? (
            <View className="mb-3 mt-[5px] w-px flex-1" style={{ backgroundColor: color.line }} />
          ) : null}
        </View>

        <View className={`min-w-0 flex-1 ${kids ? "pb-[13px] pt-3" : "py-3.5"}`}>
          <View className="flex-row items-baseline gap-3">
            {/* `font-medium` rather than `font-sans`, never both: on this
                phone the two are *families* — Archivo 500 against Archivo 400
                — so a row carrying both declares its typeface twice and which
                one lands is whichever the stylesheet wrote last. */}
            <Text
              numberOfLines={1}
              className={`min-w-0 flex-1 ${hot ? "font-medium" : "font-sans"} ${soft ? "text-dim" : "text-bone"}`}
              style={{ fontSize: size.title, letterSpacing: size.title * -0.012 }}
            >
              {rowLabel(place, places)}
            </Text>
            <Text className="font-sans text-meta text-mute">
              {elapsed(minutesSince(lastMoved(familyOf(place, places))))}
            </Text>
          </View>

          {/* Two slots rather than a sentence with a dot in it: the phrase on
              the left, how many it stands for on the right. The phrase gives
              way under pressure and the count never does — how many agents a
              row answers for is the one thing you cannot work out by looking
              at it. */}
          {kids ? (
            <View className="mt-0.5 flex-row items-baseline gap-2.5">
              <Text numberOfLines={1} className="min-w-0 flex-1 font-sans text-meta" style={{ color: said }}>
                {kids.text}
              </Text>
              {kids.count ? (
                <Text className="font-sans text-meta text-mute">{kids.count}</Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </Animated.View>
    </GestureDetector>
  );
}
