/**
 * On or off, for a setting that takes effect where it is drawn.
 *
 * The first switch in this app, which is why it is here rather than inside the
 * one sheet that wants it: the next screen that needs one must not draw its
 * own, the way three sheets each drew their own grabber before `Sheet` existed.
 *
 * **30×18 with a 12pt knob** — the desk's shape at `desktop/src/ui/SkillPicker.tsx`
 * is 28×16, and this is the same drawing at touch scale. The track is small on
 * purpose and the *target* is not: nothing here is tappable on its own, because
 * a switch belongs to a row and the row is what you hit. Every caller is
 * responsible for giving it 44pt of something to sit in — see the skills
 * sheet's defaults row, where the label is part of the same target.
 *
 * **Sage, not ember.** Ember means an agent is waiting on somebody. A setting
 * being on is not that, and this is the only colour a switch gets.
 */
import { Pressable, View } from "react-native";
import * as Haptics from "expo-haptics";

export function Switch({
  on,
  onFlip,
  label,
}: {
  on: boolean;
  onFlip: () => void;
  /** What it is a switch for, said out loud. There is no visible label here —
   *  the row carries that — so this is the only thing a screen reader gets. */
  label: string;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      onPress={() => {
        Haptics.selectionAsync();
        onFlip();
      }}
      /* Generous beyond its own 18pt, so the switch itself is hittable even
         where a caller has not given it a row. */
      hitSlop={13}
      className={`h-[18px] w-[30px] shrink-0 justify-center rounded-full ${on ? "bg-sage-deep" : "bg-raise"}`}
    >
      <View
        className={`h-3 w-3 rounded-full ${on ? "bg-sage" : "bg-mute"}`}
        style={{ marginLeft: on ? 15 : 3 }}
      />
    </Pressable>
  );
}
