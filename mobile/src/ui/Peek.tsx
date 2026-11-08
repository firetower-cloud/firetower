/**
 * The peek: a phone's answer to the desktop rail's hover preview.
 *
 * Hold a row and the question comes to you, with both answers on it. It is the
 * only thing in the app that makes four waiting agents cheaper than four round
 * trips — without it, answering four is four pushes, four reads and four back
 * gestures, and the inbox's whole job is to be the place you do that from.
 *
 * `docs/mobile-redesign-coverage.md` §8 asks whether this is worth a component
 * of its own and answers yes, for exactly that reason. If it is ever cut, the
 * fallback is the plain context menu in `docs/mobile.md` and nothing else
 * changes.
 *
 * ## Why it is a peek and not a sheet
 *
 * A sheet is the task. This is *about* the row you are still looking at, so it
 * grows out of the list rather than arriving from the bottom edge, and the
 * scrim blurs rather than dims — the inbox stays legible behind it because
 * which row you are on is part of what you are deciding.
 *
 * ## The gesture
 *
 * **420ms, and any movement cancels.** The number is the drawing's. It has to
 * be long enough not to fire while somebody is starting a scroll and short
 * enough that holding feels answered rather than ignored; `maxDist` is what
 * actually protects the list, because a press that drifts is a scroll that
 * has not got going yet. The list's own vertical pan always wins a race.
 *
 * **Not verified under touch.** This is one of the six gestures in coverage §7
 * that a browser cannot test, and it had never been run on a device before
 * this build.
 */
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  ZoomIn,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import * as Haptics from "expo-haptics";
import { useWindowDimensions } from "react-native";
import type { Asked } from "~/api/conversation";
import type { Workspace } from "~/api/workspaces";
import { lead } from "~/api/workspaces";
import { elapsed, minutesSince } from "~/api/view";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

/** How long a finger has to be still before the row answers. The drawing's. */
export const PEEK_MS = 420;

/**
 * Hold to peek, tap to open — **both gestures in one place**.
 *
 * The first version wrapped a `Pressable` in a `GestureDetector` and put only
 * the long press in gesture-handler. That does not work: `Pressable` claims
 * the touch through React Native's own responder system, so the RNGH long
 * press never activates. It did not throw and it did not log — the press
 * simply did nothing, which is the hardest kind of failure to notice in a
 * screenshot and the reason this was reported as "component complete".
 *
 * So the tap moves into gesture-handler too and the row is a plain `View`.
 * `Gesture.Exclusive` makes them race properly: a long press wins if the
 * finger stays, a tap wins if it leaves first, and neither fires twice.
 *
 * Returned as one object from one place because the two call sites — the
 * home's chips and the Workspaces list — had already drifted once. Two copies
 * of a gesture composition is how three sheets ended up drawing a grabber
 * none of them honoured.
 */
export function usePeekable(onPeek: () => void, onOpen: () => void) {
  const held = useSharedValue(0);

  const hold = Gesture.LongPress()
    .minDuration(PEEK_MS)
    /* Any movement cancels. A press that drifts is a scroll that has not got
       going yet, and stealing it is what makes a list feel like it is
       fighting you. */
    .maxDistance(10)
    .onBegin(() => {
      held.value = withTiming(1, { duration: PEEK_MS });
    })
    .onFinalize(() => {
      held.value = withTiming(0, { duration: 140 });
    })
    .onStart(() => {
      /* On the press, not on the release — latency is the thing that kills
         directness, and this is the only confirmation the gesture gives. */
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      onPeek();
    })
    /**
     * **On the JS thread, and this crashed the app without it.**
     *
     * In gesture-handler 3 a gesture callback is a *worklet* on the UI thread
     * by default, and this one calls a native module and a React `setState`.
     * Unmarshalled, that throws inside the worklet runtime and escapes as an
     * uncaught C++ exception — `EXC_CRASH / SIGABRT`, not a red screen.
     *
     * The whole callback goes to JS because nothing in it animates. Where a
     * callback *does* drive a shared value, as `Sheet`'s pan does, the worklet
     * stays and only the JS call is wrapped in `runOnJS`. Which pattern applies
     * is decided by whether the callback animates anything.
     *
     * `onBegin`/`onFinalize` above stay worklets — they only touch `held`.
     */
    .runOnJS(true);

  const tap = Gesture.Tap().maxDuration(PEEK_MS).onEnd(onOpen).runOnJS(true);

  /* The row sinks slightly while a press is being held, so the gesture is
     visibly *being considered* rather than ignored for 420ms. */
  const pressed = useAnimatedStyle(() => ({ opacity: 1 - held.value * 0.35 }));

  return { gesture: Gesture.Exclusive(hold, tap), pressed };
}

type Answer = { label: string; run: () => void; tone?: "loud" | "quiet" };

export function Peek({
  place,
  onClose,
  onOpen,
  onChanges,
  pending,
  reading,
  onAnswer,
  onEnd,
}: {
  place: Workspace;
  onClose: () => void;
  onOpen: () => void;
  onChanges: () => void;
  /**
   * What it is blocked on, read without opening the workspace.
   *
   * `undefined` while the one request is in flight, `null` when there is
   * nothing pending or it could not be read. The buttons appear only on a
   * real `Asked`, because that is the only state in which pressing one does
   * anything — see `api/pending.ts`.
   */
  pending?: Asked | null;
  reading?: boolean;
  onAnswer?: (yes: boolean) => void;
  onEnd: () => void;
}) {
  const { color } = useTheme();
  const { height } = useWindowDimensions();
  const speaker = lead(place);

  /* Blocked is a narrower question than "wants a human": `needsYou` also
     covers finished and broken, and neither of those has an answer to give.
     Only a genuine block gets the two buttons — and only once the request it
     is blocked on has actually been read, because answering needs its `req`. */
  const run = place.runs.find((r) => r.status === "NeedsYou");
  const blocked = Boolean(run);
  /* The agent's own note is better than anything derivable, and it is what
     the row already shows. The request's detail is the fallback once it has
     been read. */
  const said = run?.note ?? pending?.detail ?? place.runs.find((r) => r.note)?.note;
  const answerable = blocked && !!pending && !!onAnswer;

  const close = useCallback(() => onClose(), [onClose]);

  const items: Answer[] = [
    { label: "Open the conversation", run: onOpen },
    { label: "What it changed", run: onChanges },
    { label: "End this workspace", run: onEnd, tone: "loud" },
  ];

  return (
    <>
      {/* The scrim blurs rather than dims: which row you are on is part of
          what you are deciding, so the inbox stays legible behind it. */}
      <Animated.View
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(140)}
        style={{ position: "absolute", inset: 0, backgroundColor: color.scrim, zIndex: 45 }}
      >
        <Pressable accessibilityLabel="Dismiss" onPress={close} style={{ flex: 1 }} />
      </Animated.View>

      <Animated.View
        /* From the row, not from nothing: 220ms and a scale from .93, which is
           what makes it read as the row enlarging rather than a panel
           arriving. */
        entering={ZoomIn.duration(220).springify().damping(18)}
        exiting={FadeOut.duration(140)}
        className="absolute overflow-hidden rounded-peek bg-float"
        style={{
          left: 16,
          right: 16,
          top: Math.round(height * 0.16),
          zIndex: 47,
          /* Light's device. In dark the `float` fill is what draws the edge —
             see `phone.css` on why a shadow renders nothing down there. */
          shadowColor: "#000",
          shadowOpacity: 0.5,
          shadowRadius: 26,
          shadowOffset: { width: 0, height: 18 },
        }}
      >
        <View className="gap-3 px-5 pb-5 pt-5">
          <View className="flex-row items-center gap-3">
            {blocked ? <View className="h-2 w-2 rounded-full bg-ember" /> : null}
            <Text numberOfLines={1} className="min-w-0 flex-1 font-medium text-title text-bone">
              {place.name}
            </Text>
            <Text className="font-sans text-meta text-mute">
              {elapsed(minutesSince(speaker.updatedAt))}
            </Text>
          </View>

          {/* The question, at reading size. It is the whole reason the peek
              saves a round trip: you can answer without opening anything. */}
          {said ? (
            <Text className="font-sans text-bone" style={{ fontSize: size.read, lineHeight: size.read * 1.62 }}>
              {said}
            </Text>
          ) : null}

          {answerable ? (
            <View className="mt-0.5 flex-row gap-3">
              <Pressable
                testID="peek-no"
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  onAnswer?.(false);
                  close();
                }}
                className="h-12 flex-1 items-center justify-center rounded-field bg-ground"
              >
                <Text className="font-medium text-bone" style={{ fontSize: size.read }}>
                  No
                </Text>
              </Pressable>
              <Pressable
                testID="peek-yes"
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  onAnswer?.(true);
                  close();
                }}
                className="h-12 flex-1 items-center justify-center rounded-field bg-bone"
              >
                <Text className="font-medium text-ground" style={{ fontSize: size.read }}>
                  Allow
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        <View className="h-px bg-line-soft" />

        {items.map(({ label, run, tone }, i) => (
          <View key={label}>
            {tone === "loud" && i > 0 ? <View className="my-2 h-px bg-line-soft" /> : null}
            <Pressable
              testID={`peek-${label.split(" ")[0].toLowerCase()}`}
              onPress={() => {
                run();
                close();
              }}
              className="min-h-[54px] flex-row items-center px-5 active:bg-raise"
              android_ripple={{ color: color.raise }}
            >
              <Text
                className={`font-sans ${tone === "loud" ? "text-brick" : "text-text"}`}
                style={{ fontSize: size.title }}
              >
                {label}
              </Text>
            </Pressable>
          </View>
        ))}
      </Animated.View>
    </>
  );
}

export { GestureDetector };
