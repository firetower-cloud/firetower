/**
 * What your voice looks like while it is being heard.
 *
 * A dictation button with no feedback is indistinguishable from a dictation
 * button that is broken — you talk, nothing moves, and you stop to check. The
 * wave is there to answer one question, continuously: *is it hearing me?*
 *
 * It is a **trail, not a meter**. The newest sample enters at the right and the
 * history slides left, so a pause leaves a visible gap of dots behind it and
 * you can see the shape of the sentence you just said. A single centred bar
 * bouncing would answer the same question with less to look at, but it would
 * not let you see that the last three words went into silence.
 *
 * The amplitude is real — `expo-speech-recognition` reports the input level
 * every 100ms — and it never leaves the UI thread: the trail lives in one
 * shared value, each bar reads its own slot, and a tick is a single assignment
 * rather than 28 React renders a second.
 */
import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { color } from "~/design/tokens.generated";

/** Enough to hold about two and a half seconds of speech. */
const BARS = 28;
/** How often the trail advances. Faster than the eye resolves, slower than
    the level events arrive, so no sample is dropped and none is doubled. */
const TICK = 80;
const DOT = 3;
const TALL = 22;

export function Waveform({ level }: { level: SharedValue<number> }) {
  const trail = useSharedValue<number[]>(new Array(BARS).fill(0));

  useEffect(() => {
    const beat = setInterval(() => {
      trail.value = [...trail.value.slice(1), level.value];
    }, TICK);
    return () => clearInterval(beat);
  }, [level, trail]);

  return (
    <View className="h-6 flex-1 flex-row items-center justify-between px-2">
      {Array.from({ length: BARS }, (_, i) => (
        <Bar key={i} trail={trail} at={i} />
      ))}
    </View>
  );
}

function Bar({ trail, at }: { trail: SharedValue<number[]>; at: number }) {
  const rise = useAnimatedStyle(() => {
    const loud = trail.value[at] ?? 0;
    return {
      height: withTiming(DOT + (TALL - DOT) * loud, {
        duration: TICK * 2,
        easing: Easing.out(Easing.quad),
      }),
      /* Silence is a dot you can still see, not a gap. The line has to read as
         continuous or the quiet stretches look like the wave stopped. */
      opacity: withTiming(0.3 + 0.7 * Math.min(1, loud * 3), { duration: TICK * 2 }),
    };
  });

  return (
    <Animated.View
      style={[{ width: DOT, borderRadius: DOT / 2, backgroundColor: color.bone }, rise]}
    />
  );
}
