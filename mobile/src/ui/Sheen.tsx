/**
 * A word that is still being worked on.
 *
 * The desk's `.text-sheen`: a highlight sweeping left to right through
 * `--color-mute`, brightening to `--color-bone` as it passes and falling back.
 * It means *this is not finished yet* without a spinner, which is the right
 * answer for something that may take four minutes — a spinner at that length
 * reads as a hang.
 *
 * The web does it with a clipped background gradient. React Native has no
 * `background-clip: text`, and the alternatives all want a native module, so
 * this sweeps **per glyph** instead: each character's colour is interpolated
 * from one shared clock by how near the highlight is to it. At this size the
 * two are indistinguishable, and it costs nothing but the characters already
 * on screen.
 *
 * Reduced motion takes the sweep away and leaves the word dim, which is what
 * `globals.css` does — the word alone still says what it says.
 */
import { useEffect, useState } from "react";
import { AccessibilityInfo, View } from "react-native";
import Animated, {
  type SharedValue,
  Easing,
  cancelAnimation,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { color } from "~/design/tokens.generated";

/** `text-sheen 1.6s linear infinite`, and the same overshoot at both ends. */
const SWEEP = 1600;
const FROM = 1.3;
const TO = -0.3;
/** How wide the bright part of the sweep is, as a fraction of the word. */
const WIDTH = 0.42;

function Glyph({
  ch,
  at,
  clock,
  still,
}: {
  ch: string;
  at: number;
  clock: SharedValue<number>;
  still: boolean;
}) {
  const style = useAnimatedStyle(() => {
    if (still) return { color: color.dim };
    const head = FROM + (TO - FROM) * clock.value;
    const near = Math.max(0, 1 - Math.abs(at - head) / WIDTH);
    return { color: interpolateColor(near, [0, 1], [color.mute, color.bone]) };
  }, [still, at]);

  return (
    <Animated.Text className="font-sans text-meta" style={style}>
      {ch === " " ? " " : ch}
    </Animated.Text>
  );
}

export function Sheen({ text }: { text: string }) {
  const clock = useSharedValue(0);
  const [still, setStill] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setStill);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setStill);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (still) return;
    clock.value = 0;
    clock.value = withRepeat(withTiming(1, { duration: SWEEP, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(clock);
  }, [still, clock]);

  const glyphs = [...text];
  return (
    <View className="flex-row">
      {glyphs.map((ch, i) => (
        <Glyph key={i} ch={ch} at={glyphs.length > 1 ? i / (glyphs.length - 1) : 0} clock={clock} still={still} />
      ))}
    </View>
  );
}
