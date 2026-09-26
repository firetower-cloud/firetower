/**
 * One choice, from a list that does not fit inline.
 *
 * A phone has no room for six radio rows per field, and a native `<select>`
 * has no equivalent here worth using — so a field shows what is chosen and
 * opens a panel to change it. The panel is the platform's shape: it comes up
 * from the bottom, it is dismissed by tapping away or by the back gesture, and
 * it never traps you.
 */
import { useEffect } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, ChevronDown, Plus } from "lucide-react-native";
import { Waiting } from "~/ui/Waiting";
import { color } from "~/design/tokens.generated";

export type Choice = {
  id: string;
  label: string;
  detail?: string;
  /** Shown, but not choosable, and it says why. */
  blocked?: string;
  /**
   * Changes what the agent may do unsupervised.
   *
   * The contract marks these and says they should be drawn apart. Carried
   * through rather than flattened away: a list where "ask me first" and
   * "never ask me again" look identical is the one place in a picker where
   * getting it wrong costs something.
   */
  grave?: boolean;
};

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-2">
      {/* The hint is the one that gives way. Both sides sized naturally and
          the row was a hair from colliding once the phone scale went up — and
          the label is the half you have to be able to read. */}
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="font-sans text-ui text-dim">{label}</Text>
        {hint ? (
          <Text numberOfLines={1} className="shrink font-sans text-meta text-mute">
            {hint}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

export function Trigger({
  value,
  placeholder,
  onPress,
}: {
  value?: string;
  placeholder: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{ minHeight: 48 }}
      className="flex-row items-center justify-between rounded-xl border border-line bg-ground px-3.5 py-3"
      android_ripple={{ color: color.overlay }}
    >
      <Text numberOfLines={1} className={`flex-1 font-sans text-ui ${value ? "text-bone" : "text-mute"}`}>
        {value ?? placeholder}
      </Text>
      <ChevronDown color={color.mute} size={15} />
    </Pressable>
  );
}

export function Picker({
  open,
  title,
  choices,
  chosen,
  onPick,
  onClose,
  action,
  waiting,
  empty,
}: {
  open: boolean;
  title: string;
  choices: Choice[];
  chosen?: string | string[];
  onPick: (id: string) => void;
  onClose: () => void;
  /**
   * The way out, for what the list cannot hold.
   *
   * *Connect a repository* is not a choice — picking it picks nothing and
   * leaves for another screen — so it sits under the rows, behind a hairline,
   * and never looks like one of them. A panel wants one of these whenever the
   * honest answer to "which one" can be *none of these yet*, and a picker that
   * could only offer what already existed is how this app ended up unable to
   * add a repository at all.
   */
  action?: { label: string; onPress: () => void };
  /**
   * What is being fetched, while there is nothing to choose from yet.
   *
   * An empty panel is a claim — *there are none* — and every one of these
   * lists arrives over the network. Said only when the list is empty, so a
   * refetch behind a panel somebody is already reading changes nothing under
   * them.
   */
  waiting?: string;
  /**
   * What an empty list means, once something has come back.
   *
   * Separate from [`waiting`] because they are different sentences — *none
   * yet* and *not here yet* — and a panel that says the first while the
   * second is true is the empty state that costs the most trust. A list with
   * an `action` under it can afford to be empty; it still has to say so.
   */
  empty?: string;
}) {
  const insets = useSafeAreaInsets();
  const has = (id: string) =>
    Array.isArray(chosen) ? chosen.includes(id) : chosen === id;

  /**
   * Dragged down to dismiss, because the grabber was a picture of a handle.
   *
   * A bar drawn at the top of a sheet is a promise on iOS: it says *pull me*.
   * Drawing one over a sheet that only closes by tapping the scrim is worse
   * than drawing nothing — it teaches the gesture and then refuses it.
   *
   * The whole sheet moves, not just the handle, and it follows the finger
   * rather than waiting for the gesture to finish. Let go past a third of the
   * way, or with any real speed, and it goes.
   */
  const down = useSharedValue(0);
  useEffect(() => {
    if (open) down.value = 0;
  }, [open, down]);

  const leave = () => {
    down.value = withTiming(900, { duration: 180, easing: Easing.in(Easing.quad) });
    onClose();
  };

  const drag = Gesture.Pan()
    .activeOffsetY(8)
    .onChange((e) => {
      down.value = Math.max(0, down.value + e.changeY);
    })
    .onEnd((e) => {
      if (e.translationY > 120 || e.velocityY > 700) {
        down.value = withTiming(900, { duration: 160 });
        runOnJS(onClose)();
      } else {
        down.value = withTiming(0, { duration: 180 });
      }
    });

  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: down.value }] }));

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      {/* Tapping away closes it too. A panel with only one way out is one
          people get stuck in. */}
      <Pressable className="flex-1 bg-black/60" onPress={leave} />
      <GestureDetector gesture={drag}>
      <Animated.View
        className="rounded-t-2xl border-t border-line bg-panel"
        style={[{ paddingBottom: insets.bottom + 8, maxHeight: "72%" }, slide]}
      >
        {/* A generous target: the bar is 9pt tall and the grab is 28. */}
        <View className="items-center pb-2 pt-3">
          <View className="h-1 w-9 rounded-full bg-mute" />
        </View>
        <Text className="px-5 pb-2 pt-1 font-narrow text-micro uppercase tracking-[0.18em] text-mute">
          {title}
        </Text>
        <ScrollView>
          {choices.length === 0 && waiting ? (
            <View className="px-5">
              <Waiting say={waiting} align="left" />
            </View>
          ) : choices.length === 0 && empty ? (
            <Text className="px-5 py-3 font-sans text-ui text-mute">{empty}</Text>
          ) : null}
          {choices.map((c) => (
            <Pressable
              key={c.id}
              disabled={!!c.blocked}
              onPress={() => onPick(c.id)}
              className="flex-row items-center gap-3 px-5 py-3.5"
              android_ripple={{ color: color.overlay }}
            >
              <View className="min-w-0 flex-1">
                <Text
                  numberOfLines={1}
                  className={`font-medium text-title ${
                    c.blocked ? "text-mute" : c.grave ? "text-ember" : "text-bone"
                  }`}
                >
                  {c.label}
                </Text>
                {c.detail || c.blocked ? (
                  <Text numberOfLines={1} className="mt-0.5 font-sans text-meta text-mute">
                    {c.blocked ?? c.detail}
                  </Text>
                ) : null}
              </View>
              {has(c.id) ? <Check color={color.sage} size={17} /> : null}
            </Pressable>
          ))}

          {action ? (
            <Pressable
              testID="picker-action"
              onPress={action.onPress}
              className="mt-1 flex-row items-center gap-3 border-t border-line-soft px-5 py-3.5"
              android_ripple={{ color: color.overlay }}
            >
              <Plus color={color.dim} size={16} />
              <Text className="font-medium text-title text-dim">{action.label}</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </Animated.View>
      </GestureDetector>
    </Modal>
  );
}
