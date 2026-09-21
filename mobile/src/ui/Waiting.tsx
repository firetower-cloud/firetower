/**
 * Waiting for something, said out loud.
 *
 * Every screen here already had an `ActivityIndicator` in `--color-mute`, and
 * every one of them read as a hang. Three reasons, and the fix is one
 * component because the reasons are the same everywhere:
 *
 * - **It said nothing.** A spinner names neither what is being fetched nor
 *   whose fault it is if it never comes. `Sheen` is already this app's way of
 *   saying *this is not finished yet* — it sweeps per glyph off one clock, so
 *   it is visibly alive, and its own docblock is the argument: a spinner on
 *   something that may take four minutes reads as a hang.
 * - **It was invisible.** `--color-mute` is #5e5e67 on #0b0b0c.
 * - **It appeared instantly**, so a fast load flashed a spinner, which is its
 *   own kind of broken. Nothing shows for the first third of a second.
 *
 * And the one that is not about looks: past `SLOW` it says **"Still going."**
 * That is the whole question somebody is actually asking when they stare at a
 * loading screen, and no amount of animation answers it — only a sentence
 * that appeared *because* time passed can.
 *
 * `bars` draws the transcript's own shape underneath: the agent speaks onto
 * the ground in full-width lines, you get a raised card on the right. A
 * conversation that is slow to arrive is the case people hit hardest, and the
 * shape says *a conversation is coming* before any of the words do.
 */
import { useEffect, useState } from "react";
import { AccessibilityInfo, Text, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { Sheen } from "~/ui/Sheen";
import { color } from "~/design/tokens.generated";

/** Under this, a load is not worth telling anybody about. */
const HOLD = 350;
/** Past this, somebody is wondering whether it is stuck. */
const SLOW = 6000;

const PULSE = 1100;

export function Waiting({
  say,
  bars = false,
}: {
  /** What is being waited for, as a sentence. "Reading the conversation" */
  say: string;
  bars?: boolean;
}) {
  const [shown, setShown] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const a = setTimeout(() => setShown(true), HOLD);
    const b = setTimeout(() => setSlow(true), SLOW);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, []);

  if (!shown) return null;

  return (
    <View className="gap-4 py-2">
      {bars ? <Shape /> : null}
      <View className={bars ? "" : "items-center"}>
        <Sheen text={say} />
        {/* Said only once enough time has passed for it to be the
            question somebody is asking. */}
        {slow ? <Text className="mt-1.5 font-sans text-meta text-mute">Still going.</Text> : null}
      </View>
    </View>
  );
}

/** The transcript's shape, breathing. */
function Shape() {
  const [still, setStill] = useState(false);
  const pulse = useSharedValue(0);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setStill);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setStill);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (still) return;
    pulse.value = 0;
    pulse.value = withRepeat(withTiming(1, { duration: PULSE, easing: Easing.inOut(Easing.quad) }), -1, true);
    return () => cancelAnimation(pulse);
  }, [still, pulse]);

  const breath = useAnimatedStyle(() => ({ opacity: still ? 0.3 : 0.2 + pulse.value * 0.35 }));

  /* Widths that do not divide evenly, so it reads as prose rather than as a
     progress bar somebody forgot to fill in. */
  return (
    <View className="gap-2.5">
      {[1, 0.94, 0.66].map((w, i) => (
        <Animated.View
          key={i}
          style={[{ height: 12, borderRadius: 6, backgroundColor: color.overlay, width: `${w * 100}%` }, breath]}
        />
      ))}
      <View className="items-end">
        <Animated.View
          style={[{ height: 40, borderRadius: 14, backgroundColor: color.raise, width: "58%" }, breath]}
        />
      </View>
      {[0.88, 0.52].map((w, i) => (
        <Animated.View
          key={i}
          style={[{ height: 12, borderRadius: 6, backgroundColor: color.overlay, width: `${w * 100}%` }, breath]}
        />
      ))}
    </View>
  );
}
