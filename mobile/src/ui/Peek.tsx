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
import { ChevronRight } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { useWindowDimensions } from "react-native";
import { type Ask } from "~/api/answering";
import type { Workspace } from "~/api/workspaces";
import { childrenElsewhere, lastMoved, familyOf, placeBeat, placeOf, rowLabel } from "~/api/workspaces";
import { elapsed, minutesSince } from "~/api/view";
import { Blocks } from "~/ui/Blocks";
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

type Answer = { label: string; run: () => void; tone?: "loud" | "quiet"; count?: number; go?: boolean };

/**
 * What one agent asked, and both answers to it.
 *
 * **Clamped to three lines.** A peek is a preview and the whole question is in
 * the conversation; two unclamped questions on one card is taller than the
 * phone, and this has no scroll in it.
 */
function Asking({
  ask,
  at,
  onAnswer,
  close,
}: {
  ask: Ask;
  at: number;
  onAnswer?: (ask: Ask, yes: boolean) => void;
  close: () => void;
}) {
  /* The agent's own note is better than anything derivable, and it is what
     the row already shows. The request's detail is the fallback once it has
     been read. */
  const said = ask.run.note ?? ask.asked?.detail;
  /* Only once the request it is blocked on has actually been read: answering
     needs its `req`, and a button that cannot carry one does nothing. */
  const answerable = !!ask.asked && !!onAnswer;
  const suffix = at === 0 ? "" : `-${at}`;

  return (
    <>
      {said ? (
        <Text
          numberOfLines={3}
          className="font-sans text-bone"
          style={{ fontSize: size.read, lineHeight: size.read * 1.62 }}
        >
          {said}
        </Text>
      ) : null}

      {answerable ? (
        <View className="mt-0.5 flex-row gap-3">
          <Pressable
            testID={`peek-no${suffix}`}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onAnswer?.(ask, false);
              close();
            }}
            className="h-12 flex-1 items-center justify-center rounded-field bg-ground"
          >
            <Text className="font-medium text-bone" style={{ fontSize: size.read }}>
              No
            </Text>
          </Pressable>
          <Pressable
            testID={`peek-yes${suffix}`}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              onAnswer?.(ask, true);
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
    </>
  );
}

export function Peek({
  place,
  places,
  onClose,
  onOpen,
  onChildren,
  onChanges,
  asks = [],
  waiting = 0,
  onAnswer,
  onEnd,
}: {
  place: Workspace;
  /** The whole fleet, children included. See `WorkspaceRow`'s `places`. */
  places: Workspace[];
  onClose: () => void;
  onOpen: () => void;
  /** The pushed overview, which is where the children are. */
  onChildren: () => void;
  onChanges: () => void;
  /**
   * What the family is blocked on, read without opening anything — **capped
   * at `ANSWERS`**, and each one is an agent, not a workspace.
   *
   * It used to be one `Asked` for one blocked run of this place. A child with
   * a workspace of its own no longer has a row, so its question has nowhere
   * else to be asked: a long press on the parent is now the only way to
   * answer it without three taps and a screen.
   *
   * `asked` is `undefined` while the one request is in flight and `null` when
   * there is nothing pending or it could not be read. The buttons appear only
   * on a real `Asked`, because that is the only state in which pressing one
   * does anything — see `api/pending.ts`.
   */
  asks?: Ask[];
  /** Everyone waiting, including the ones past the cap. */
  waiting?: number;
  onAnswer?: (ask: Ask, yes: boolean) => void;
  /**
   * End the place, and everything it started.
   *
   * It used to dismiss the peek and do nothing else, at every call site —
   * which was true on `main` as well, and this branch had given that dead
   * control a count of what it would take with it. Both call sites now ask
   * `useEndWorkspace`, the same flow the workspace's own menu asks, so the
   * count means what it was drawn to mean.
   */
  onEnd: () => void;
}) {
  const { color } = useTheme();
  const { height } = useWindowDimensions();
  const family = familyOf(place, places);
  const kids = childrenElsewhere(place, places);
  const blocked = placeBeat(place, places) === "blocked";
  /* Past the two it offers buttons for. The rest are in the workspace. */
  const rest = waiting - asks.length;

  /* Two questions and a four-row menu is taller than a phone. When the peek
     is carrying more than one answer, **answering wins** and the rest of the
     menu stays in the workspace — it is the navigation that gives way, because
     answering is what this is for. */
  const crowded = asks.length > 1;
  const toChildren: Answer | null = kids.length
    ? {
        label: kids.length === 1 ? "The agent it started" : `The ${kids.length} agents it started`,
        run: onChildren,
        go: true,
      }
    : null;
  /* What goes with it. A parent's children are ended with it and they are no
     longer rows you could have seen first, so the count beside the label is
     the only place anybody is told — which is why it had to become true
     rather than go. `ui/end.ts` is what makes it so.

     Left out rather than shown refused where ending the place is not yours:
     `may_share`, server side, and `mayWrite !== false` because a control
     plane older than this app sends no such field. */
  const toEnd: Answer | null = place.runs.some((r) => r.mayWrite !== false)
    ? { label: "End this workspace", run: onEnd, tone: "loud", count: kids.length }
    : null;

  const close = useCallback(() => onClose(), [onClose]);

  const items: Answer[] = (
    crowded
      ? [{ label: "Open the conversation", run: onOpen }, toChildren]
      : [
          { label: "Open the conversation", run: onOpen },
          toChildren,
          { label: "What it changed", run: onChanges },
          toEnd,
        ]
  ).filter((item): item is Answer => !!item);

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
        <View className={`gap-3 px-5 pt-5 ${asks.length > 0 ? "pb-[18px]" : "pb-3.5"}`}>
          <View className="flex-row items-center gap-3">
            {blocked ? <View className="h-2 w-2 rounded-full bg-ember" /> : null}
            <Text numberOfLines={1} className="min-w-0 flex-1 font-medium text-title text-bone">
              {rowLabel(place, places)}
            </Text>
            <Text className="font-sans text-meta text-mute">
              {elapsed(minutesSince(lastMoved(family)))}
            </Text>
          </View>

          {/* The place's own question stays under the header, where it has
              always been: it belongs to the row you are holding and needs
              nothing to say whose it is. */}
          {asks.map((ask, i) =>
            place.runs.some((r) => r.id === ask.run.id) ? (
              <Asking key={ask.run.id} ask={ask} at={i} onAnswer={onAnswer} close={close} />
            ) : null,
          )}
        </View>

        {/* A child's question is a block of its own, divided off and named.
            Whose question it is is the thing the row no longer says. */}
        {asks.map((ask, i) =>
          place.runs.some((r) => r.id === ask.run.id) ? null : (
            <View key={ask.run.id} className="gap-3 border-t border-line-soft px-5 pb-[18px] pt-4">
              <View className="flex-row items-center gap-2">
                <Blocks beat="blocked" />
                <Text numberOfLines={1} className="min-w-0 flex-1 font-medium text-ui text-bone">
                  {rowLabel(placeOf(places, ask.run.id) ?? place, places)}
                </Text>
                <Text className="font-sans text-micro text-mute">
                  {elapsed(minutesSince(ask.run.updatedAt))}
                </Text>
              </View>
              <Asking ask={ask} at={i} onAnswer={onAnswer} close={close} />
            </View>
          ),
        )}

        {/* The ones past the cap. They are answered in the workspace; saying
            how many stops the peek reading as the whole of it. */}
        {rest > 0 ? (
          <View className="border-t border-line-soft px-5 pb-3 pt-3">
            <Text className="font-sans text-meta text-dim">
              {rest === 1 ? "1 more is waiting." : `${rest} more are waiting.`}
            </Text>
          </View>
        ) : null}

        <View className="h-px bg-line-soft" />

        {items.map(({ label, run, tone, count, go }, i) => (
          <View key={label}>
            {tone === "loud" && i > 0 ? <View className="my-2 h-px bg-line-soft" /> : null}
            <Pressable
              testID={`peek-${label.split(" ")[0].toLowerCase()}`}
              onPress={() => {
                run();
                close();
              }}
              className="min-h-[54px] flex-row items-center gap-2.5 px-5 active:bg-raise"
              android_ripple={{ color: color.raise }}
            >
              <Text
                className={`font-sans ${tone === "loud" ? "text-brick" : "text-text"}`}
                style={{ fontSize: size.title }}
              >
                {label}
              </Text>
              {count ? <Text className="font-sans text-meta text-mute">{`(${count})`}</Text> : null}
              {go ? <ChevronRight color={color.mute} size={16} style={{ marginLeft: "auto" }} /> : null}
            </Pressable>
          </View>
        ))}
      </Animated.View>
    </>
  );
}

export { GestureDetector };
