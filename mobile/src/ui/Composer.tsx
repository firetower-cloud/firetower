/**
 * Saying something to the agent.
 *
 * The thing an app is judged on in the first ten seconds, so the behaviour is
 * spelled out rather than left to a library's defaults.
 *
 * ## It is two shapes, not one
 *
 * **At rest it is a pill** — one row, compact, inset from both edges, holding
 * the placeholder and the one control that matters. It is furniture; the
 * conversation is the screen and the composer should not take a sixth of it to
 * say nothing.
 *
 * **Focused it becomes a card** — the text gets a line of its own and the
 * controls drop to a second row beneath it, corners square off, and it widens
 * toward the edges. This is the moment the composer stops being furniture and
 * becomes the thing you are using, and the desk already says so: *the composer
 * is the second-heaviest object on the screen.* It is only the second-heaviest
 * while you are writing in it.
 *
 * The morph is one layout transition on the UI thread, not two components
 * swapped — the `TextInput` holds the same slot in the tree throughout, so
 * focus, selection and the software keyboard never notice it happened.
 *
 * ## The rest
 *
 * - **It moves with the keyboard, not after it.** `KeyboardStickyView` reads
 *   the keyboard's real frame every frame on the UI thread. React Native's own
 *   `KeyboardAvoidingView` animates on the JS thread against a guessed height
 *   and a guessed duration, and arriving three frames late is precisely the
 *   tell.
 * - **It grows to six lines, then scrolls.**
 * - **Enter is a newline; the button sends.** `⏎ send` is a hardware-keyboard
 *   convention and inverting it on a phone loses half the messages people
 *   write. With a hardware keyboard attached, `⌘⏎` sends.
 * - **Send becomes stop while the agent works.** The same button in the same
 *   place — reaching for a different one while something is running is the
 *   wrong moment to make somebody aim.
 */
import { useEffect, useRef, useState } from "react";
import { Keyboard, Platform, Pressable, TextInput, View } from "react-native";
import Animated, {
  Easing,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { ArrowUp, ChevronDown, Plus, Square } from "lucide-react-native";
import { takeDraft } from "~/workspace/draft";
import { color, size } from "~/design/tokens.generated";

/** One line at rest, six before it scrolls. */
const LINE = 22;
const MIN = LINE;
const MAX = LINE * 6;

/** `--ease-swift`, and the web build's duration — this is in-content motion,
    not a screen transition, so it uses our curve rather than the platform's. */
const SWIFT = { duration: 200, easing: Easing.bezier(0.16, 1, 0.3, 1) };

const PILL = 26;
const CARD = 20;

export function Composer({
  sessionId,
  working,
  model,
  mode,
  above,
  onSend,
  onInterrupt,
}: {
  /** Whose composer this is — the key a seeded draft was left under. */
  sessionId: string;
  working: boolean;
  /**
   * What the agent has said it is running.
   *
   * Absent until it says so, and drawn as absent rather than as a default:
   * "Opus 5" under a session running something else is a lie the picker tells
   * for as long as nobody speaks. The desk makes the same call about effort —
   * a control that does not know should stay quiet.
   */
  model?: string;
  mode?: string;
  /**
   * What rides up with the composer.
   *
   * The approval card goes here rather than in the page beneath, because it is
   * not something that happened — it is something waiting to, and the answer
   * goes immediately below it. Left in the page it was buried by the keyboard
   * the moment you tapped the composer, which hides the question at exactly
   * the moment you are answering it.
   */
  above?: React.ReactNode;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [height, setHeight] = useState(MIN);
  const [focused, setFocused] = useState(false);
  const field = useRef<TextInput>(null);

  /* A workspace started from a task arrives with its issue waiting. Taken
     once, so coming back does not put it on top of what has since been
     typed. */
  useEffect(() => {
    const seeded = takeDraft(sessionId);
    if (seeded) setText(seeded);
  }, [sessionId]);

  /* Open while you are writing *or* while there is something written: a draft
     collapsed back into a pill and truncated is a message you cannot re-read
     before you send it. */
  const open = focused || text.length > 0;

  const shape = useSharedValue(0);
  const skin = useAnimatedStyle(() => ({
    borderRadius: PILL + (CARD - PILL) * shape.value,
    marginHorizontal: 12 - 4 * shape.value,
  }));

  const morph = (to: number) => {
    shape.value = withTiming(to, SWIFT);
  };

  /* An empty composer is one line, whatever the last measurement said.
     Without this the measured height feeds the style being measured, and the
     box walks itself to the cap on the first layout pass and stays there. */
  const tall = text.length === 0 ? MIN : height;

  /**
   * Sending is the end of your turn.
   *
   * So the composer goes back to being furniture: it blurs, the keyboard goes
   * away, and the card collapses to the pill. Leaving it open and focused
   * said "your move" while the agent was working, and kept a keyboard over
   * the reply you were waiting for.
   */
  const send = () => {
    const said = text.trim();
    if (!said) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSend(said);
    setText("");
    setHeight(MIN);
    field.current?.blur();
    Keyboard.dismiss();
    morph(0);
  };

  const Action = () =>
    working ? (
      <Pressable
        onPress={onInterrupt}
        className="h-9 w-9 items-center justify-center rounded-full bg-bone"
        hitSlop={6}
      >
        <Square color={color.ground} size={12} fill={color.ground} />
      </Pressable>
    ) : (
      <Pressable
        testID="send"
        onPress={send}
        disabled={!text.trim()}
        className={`h-9 w-9 items-center justify-center rounded-full ${text.trim() ? "bg-bone" : "bg-overlay"}`}
        hitSlop={6}
      >
        <ArrowUp color={text.trim() ? color.ground : color.mute} size={18} />
      </Pressable>
    );

  const Attach = () => (
    <Pressable className="h-9 w-9 items-center justify-center rounded-full" hitSlop={6}>
      <Plus color={color.dim} size={20} />
    </Pressable>
  );

  return (
    <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
      <View style={{ paddingTop: 6, paddingBottom: Math.max(insets.bottom, 8) }}>
        {above}
        <Animated.View
          layout={LinearTransition.duration(200)}
          style={[
            {
              backgroundColor: color.raise,
              paddingHorizontal: 6,
              paddingVertical: 6,
              /* The floating shadow the desk gives it. Only once it is the
                 thing you are using — a pill at rest is furniture. */
              shadowColor: "#000",
              shadowOpacity: open ? 0.5 : 0,
              shadowRadius: 20,
              shadowOffset: { width: 0, height: 10 },
            },
            skin,
          ]}
        >
          {/* Slot order never changes: the input is always the middle child,
              so React keeps the same instance and focus survives the morph. */}
          <View className={`flex-row ${open ? "items-end" : "items-center"}`}>
            {!open ? <Attach /> : null}

            <TextInput
              testID="composer"
              multiline
              value={text}
              onChangeText={setText}
              onFocus={() => {
                setFocused(true);
                morph(1);
              }}
              onBlur={() => {
                setFocused(false);
                if (text.length === 0) morph(0);
              }}
              onContentSizeChange={(e) => {
                if (!text.length) return;
                setHeight(Math.min(MAX, Math.max(MIN, e.nativeEvent.contentSize.height)));
              }}
              placeholder="Answer the agent"
              placeholderTextColor={color.mute}
              selectionColor={color.ember}
              className="flex-1 font-sans text-bone"
              /* The asymmetric padding is what a multiline `TextInput` needs
                 to sit right once it has grown; at rest it is the thing that
                 pushed the placeholder off the pill's centre line. So the
                 pill gets neither padding nor extra height — one line, one
                 line's worth of box, centred by the row. */
              style={{
                height: open ? tall + (Platform.OS === "ios" ? 14 : 18) : LINE + 8,
                paddingHorizontal: 10,
                paddingTop: open ? (Platform.OS === "ios" ? 8 : 4) : 0,
                paddingBottom: open ? (Platform.OS === "ios" ? 6 : 4) : 0,
                fontSize: size.read,
                lineHeight: LINE,
                textAlignVertical: "center",
              }}
              onKeyPress={(e) => {
                const native = e.nativeEvent as unknown as { key: string; metaKey?: boolean };
                if (native.key === "Enter" && native.metaKey) send();
              }}
            />

            {!open ? <Action /> : null}
          </View>

          {/* The second row exists only while you are writing. Model and mode
              are drawn from what the agent reports it can change, never from a
              list kept here — a Codex session must not be offered Opus. */}
          {open ? (
            <Animated.View
              layout={LinearTransition.duration(200)}
              className="flex-row items-center gap-1 pl-0 pr-0 pt-1"
            >
              <Attach />
              <View className="flex-1" />
              {model ? (
                <Pressable className="flex-row items-center gap-1 px-2 py-2" hitSlop={4}>
                  <Animated.Text numberOfLines={1} className="font-medium text-meta text-dim">
                    {model}
                  </Animated.Text>
                  <ChevronDown color={color.mute} size={12} />
                </Pressable>
              ) : null}
              {mode ? (
                <Pressable className="flex-row items-center gap-1 px-2 py-2" hitSlop={4}>
                  <Animated.Text className="font-medium text-meta text-dim">{mode}</Animated.Text>
                  <ChevronDown color={color.mute} size={12} />
                </Pressable>
              ) : null}
              <Action />
            </Animated.View>
          ) : null}
        </Animated.View>
      </View>
    </KeyboardStickyView>
  );
}
