/**
 * Where the band turns: a word, a hairline, and how many rows are under it.
 *
 * Ported from the desk's `.pband` (`desktop/src/styles.css:4936`), at the
 * phone's numbers. It is **not** a section heading and there is no section:
 * `banded()` returns one list and this is drawn on the first row of each
 * band, so a workspace whose state changes moves inside that one order and
 * the labels re-land around it. Nothing to collapse, nothing to be empty, and
 * no row with a parent other than the scroll view it was always in.
 *
 * ## The four decisions in it
 *
 * - **It sits on the gutter**, `px-5`, which is the 20 pt every row sits on —
 *   so it starts to the left of the mark column and the rule runs *across*
 *   where the dots are. A band that reads as a line across the list does not
 *   read as a row in it.
 * - **Sentence case, not an eyebrow.** `STYLE.md` allows roughly one
 *   tracked-out ALL-CAPS legend per screen and this would be three. `micro`
 *   at 12.5 is deliberately *smaller* than the 14 pt second line under it: a
 *   heading at the content's size competes with it, and this one recedes
 *   until you look for it.
 * - **No colour, ever** — not even ember on *Waiting on you*. Ember means one
 *   blocked agent; spending it on furniture that is always there is how a
 *   budget of three becomes a budget of none. The row's mark is the only
 *   thing in this list allowed to be loud.
 * - **It does not stick to the top.** A pinned heading is a section's
 *   furniture and would be the one piece of this claiming the list has
 *   containers — and it would put a second moving thing on a screen whose
 *   rows already re-order. The count is what a sticky heading is usually
 *   reached for, and it is already here. If the list is ever long enough for
 *   that to be wrong, it is `stickyHeaderIndices` on the `ScrollView` at the
 *   indices the labels landed on.
 *
 * 14 over and 5 under, which is 36 pt at the turn — two thirds of a row, far
 * enough to separate and not so far as to look like a row that failed to
 * load. Both lists draw it: the Workspaces destination and the home's docked
 * column at 951, because rotating a Duo changes where a panel lands and never
 * what is on it.
 */
import { Text, View } from "react-native";
import { useTheme } from "~/design/theme";

export function BandLabel({
  says,
  count,
  /**
   * The first label on the list, which the count line above it has already
   * given air to. 14 pt under that line is a gap with nothing in it.
   */
  first = false,
}: {
  says: string;
  count: number;
  first?: boolean;
}) {
  const { color } = useTheme();

  return (
    <View className={`flex-row items-center gap-[9px] px-5 pb-[5px] ${first ? "pt-[7px]" : "pt-3.5"}`}>
      <Text className="font-medium text-micro text-dim">{says}</Text>
      {/* The rule takes whatever is left and never collapses, because the
          word and the count are both intrinsically sized: about 200 pt at
          390, about 120 in the 307 pt docked column. */}
      <View className="h-px flex-1" style={{ backgroundColor: color.line }} />
      {/* Tabular, so a count changing from 9 to 10 does not shift the rule it
          is anchored to. */}
      <Text className="font-sans text-micro text-mute" style={{ fontVariant: ["tabular-nums"] }}>
        {count}
      </Text>
    </View>
  );
}
