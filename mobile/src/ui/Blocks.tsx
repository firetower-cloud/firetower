/**
 * Three blocks of four, and the empty one walks.
 *
 * Ported from `desktop/src/island/Blocks.tsx` and the `.blocks` rules in
 * `desktop/src/styles.css`. Four quadrants with one of them away, and which
 * one moves clockwise — so the shape turns without anything rotating. That
 * matters at this size, where a rotating square spends most of every turn as a
 * grey smudge and a quadrant blinking out stays a crisp edge the whole way
 * round.
 *
 * The states are the ones in `BEAT` — the single table that says what a status
 * means — so this and the inbox row cannot disagree about a colour. Each says
 * what it is by how it moves and not only by how it is coloured: working
 * turns, blocked breathes, done and broken are perfectly still. Movement means
 * work is happening, which is why the state that is stuck is the one that does
 * not move, however loud it is.
 *
 * Everything animated runs in a worklet on the UI thread. A list of these
 * scrolling is the exact case where a JS-driven animation drops frames, and
 * dropped frames on the one glyph that means "an agent is waiting" is the
 * worst place in the app to spend them.
 */
import { useEffect, useState } from "react";
import { AccessibilityInfo, View } from "react-native";
import Animated, {
  type SharedValue,
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import type { Beat } from "~/api/view";
import { BEAT_TOKEN } from "~/api/view";
import { color } from "~/design/tokens.generated";

/* `--dur-island` and `--ease-island`. Not the app's own 200ms/swift: the
   island's timing is its own and this glyph came from there. */
const TURN = 320;
const ISLAND = Easing.bezier(0.22, 1, 0.36, 1).factory();

/** `@keyframes blocks-away`: away for the first 22%, back by 30%. */
const GONE = 0.22;
const BACK = 0.3;

/**
 * Clockwise: top-left, top-right, bottom-right, bottom-left.
 *
 * In grid order the children are TL, TR, BL, BR, so the phases are not in
 * source order — TR leads BL by half a turn. The desktop writes the same thing
 * as negative `animation-delay`s; this is that arithmetic already done.
 */
const PHASE = [0, 0.75, 0.25, 0.5];

/** The quadrant that is away when the glyph is still. The desk hides the fourth. */
const STILL_AWAY = 3;

function Quadrant({
  offset,
  spin,
  cell,
  gap,
  tone,
  at,
  moving,
  hidden,
}: {
  offset: number;
  spin: SharedValue<number>;
  cell: number;
  gap: number;
  tone: string;
  at: { left: number; top: number };
  moving: boolean;
  hidden: boolean;
}) {
  const style = useAnimatedStyle(() => {
    if (!moving) return { opacity: hidden ? 0 : 1, transform: [{ scale: 1 }] };
    const phase = (spin.value + offset) % 1;
    /* The easing shapes the pop, which is the only interval in the keyframes
       where anything changes — the same place CSS applies it. */
    const local = Math.min(1, Math.max(0, (phase - GONE) / (BACK - GONE)));
    const eased = ISLAND(local);
    return { opacity: eased, transform: [{ scale: 0.55 + 0.45 * eased }] };
  }, [moving, hidden, offset]);

  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          width: cell,
          height: cell,
          left: at.left,
          top: at.top,
          borderRadius: Math.max(1.5, cell * 0.22),
          backgroundColor: tone,
        },
        style,
      ]}
    />
  );
}

export function Blocks({ beat, size = 13 }: { beat: Beat; size?: number }) {
  const tone = color[BEAT_TOKEN[beat]];
  const gap = Math.max(1.5, size * 0.11);
  const cell = (size - gap) / 2;

  const spin = useSharedValue(0);
  const breath = useSharedValue(1);

  /* Honoured for the same reason the desk honours it: the glyph must still
     say what it is when nothing is allowed to move. With the walk stopped,
     working would be a solid square — the one shape the glyph never makes —
     so it keeps a quadrant away and the colour does the rest. */
  const [still, setStill] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setStill);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setStill);
    return () => sub.remove();
  }, []);

  const turning = beat === "working" && !still;
  const breathing = beat === "blocked" && !still;

  useEffect(() => {
    if (!turning) {
      cancelAnimation(spin);
      return;
    }
    spin.value = 0;
    spin.value = withRepeat(withTiming(1, { duration: TURN, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(spin);
  }, [turning, spin]);

  useEffect(() => {
    if (!breathing) {
      cancelAnimation(breath);
      breath.value = 1;
      return;
    }
    /* `@keyframes breathe`: 0.5 at each end, 1 in the middle — so a reversing
       half-cycle, not a full one. */
    breath.value = 0.5;
    breath.value = withRepeat(
      withTiming(1, { duration: 950, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
      -1,
      true,
    );
    return () => cancelAnimation(breath);
  }, [breathing, breath]);

  const whole = useAnimatedStyle(() => ({ opacity: breath.value }));

  const places = [
    { left: 0, top: 0 },
    { left: cell + gap, top: 0 },
    { left: 0, top: cell + gap },
    { left: cell + gap, top: cell + gap },
  ];

  /* The desk's `drop-shadow(0 0 4px …)`. React Native has no filter, and
     Android's elevation only casts grey, so the bloom is drawn rather than
     cast. It has to *hug* the glyph: a circle at 1.6× read as a coloured
     badge sitting behind a cube, which is a second object where there should
     be one. A rounded square barely larger than the shape, at low alpha, is
     the shadow a 4px blur would have left. Only the two lit states get one —
     done and broken are meant not to catch an eye. */
  const lit = beat === "working" || beat === "blocked";
  const bloom = size * 1.28;

  return (
    <View
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View style={[{ width: size, height: size }, whole]}>
        {lit ? (
          <View
            style={{
              position: "absolute",
              left: (size - bloom) / 2,
              top: (size - bloom) / 2,
              width: bloom,
              height: bloom,
              borderRadius: bloom * 0.34,
              backgroundColor: tone,
              opacity: 0.17,
            }}
          />
        ) : null}

        {places.map((at, i) => (
          <Quadrant
            key={i}
            offset={PHASE[i]}
            spin={spin}
            cell={cell}
            gap={gap}
            tone={tone}
            at={at}
            moving={turning}
            hidden={!turning && i === STILL_AWAY}
          />
        ))}
      </Animated.View>
    </View>
  );
}
