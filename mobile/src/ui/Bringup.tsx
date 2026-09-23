/**
 * What a workspace is doing before there is anything to read.
 *
 * Bringing a session up is the first thing that happens to it, so it belongs
 * at the top of the transcript rather than in a panel beside one — and once
 * the agent is talking it has scrolled away, which is the right amount of
 * attention for it.
 *
 * Only steps that have actually started are drawn. The whole plan up front is
 * five grey lines saying nothing has happened yet; the running step, carrying
 * whatever the worker last said about it, answers the only question anybody
 * has here, which is whether it is stuck.
 *
 * ## Why this moves when almost nothing else does
 *
 * `STYLE.md` says movement means work is happening, and this is the one screen
 * where a person is waiting with nothing else to look at. A clone of a large
 * repository is thirty seconds of a phone showing a sentence; the mark turning
 * and each line arriving is the difference between "it is working" and "it is
 * broken". It is also honest motion — every line appears because an event
 * arrived, not on a timer.
 */
import { useEffect } from "react";
import { Text, View } from "react-native";
import Animated, {
  Easing,
  FadeInDown,
  LinearTransition,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { Check, X } from "lucide-react-native";
import { DONE, LABELS, type Line } from "~/api/steps-bringup";
import { color } from "~/design/tokens.generated";

/** The mark for a step that is running: a ring that turns. */
function Turning() {
  const spin = useSharedValue(0);

  useEffect(() => {
    spin.value = 0;
    spin.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(spin);
  }, [spin]);

  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value * 360}deg` }] }));

  return (
    <Animated.View
      style={[
        {
          width: 12,
          height: 12,
          borderRadius: 6,
          borderWidth: 1.5,
          borderColor: color.slate,
          /* One quadrant left open, so the ring reads as turning rather than
             pulsing — the same trick `Blocks` uses for the same reason. */
          borderTopColor: "transparent",
        },
        style,
      ]}
    />
  );
}

function Mark({ state }: { state: Line["state"] }) {
  if (state === "running") return <Turning />;
  if (state === "failed") return <X color={color.brick} size={12} />;
  return <Check color={color.sage} size={12} />;
}

export function Bringup({ lines }: { lines: Line[] }) {
  const started = lines.filter((l) => l.state !== "pending");
  if (started.length === 0) return null;

  return (
    <Animated.View layout={LinearTransition.duration(220)} className="mb-4 gap-3">
      {started.map((line, i) => (
        <Animated.View
          key={line.step}
          /* Each line arrives as its event does. The stagger is small on
             purpose: this is a list assembling itself, not an animation. */
          entering={FadeInDown.delay(i * 40).duration(260)}
          layout={LinearTransition.duration(220)}
          className="flex-row items-start gap-2.5"
        >
          <View className="w-3.5 items-center pt-0.5">
            <Mark state={line.state} />
          </View>

          <View className="min-w-0 flex-1">
            <Text
              className={`font-sans text-ui ${
                line.state === "failed"
                  ? "text-brick"
                  : line.state === "running"
                    ? "text-text"
                    : "text-dim"
              }`}
            >
              {line.state === "done" ? DONE[line.step] : LABELS[line.step]}
            </Text>
            {line.detail ? (
              <Text
                numberOfLines={line.state === "failed" ? undefined : 1}
                className={`mt-0.5 font-mono text-meta ${
                  line.state === "failed" ? "text-brick" : "text-mute"
                }`}
              >
                {line.detail}
              </Text>
            ) : null}
          </View>
        </Animated.View>
      ))}
    </Animated.View>
  );
}
