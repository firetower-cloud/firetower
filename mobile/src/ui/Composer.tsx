/**
 * Saying something to the agent.
 *
 * The thing an app is judged on in the first ten seconds, so the behaviour is
 * spelled out rather than left to a library's defaults.
 *
 * ## It is two shapes, not one
 *
 * **At rest it is a pill** — one row, compact. It is furniture; the
 * conversation is the screen and the composer should not take a sixth of it to
 * say nothing.
 *
 * **Writing in it, it is a card** — the text gets lines of its own and the
 * controls drop to a second row. The desk says *the composer is the
 * second-heaviest object on the screen*; it is only the second-heaviest while
 * you are using it.
 *
 * The morph is one layout transition on the UI thread, not two components
 * swapped — the `TextInput` holds the same slot in the tree throughout, so
 * focus, selection and the keyboard never notice it happened. It keeps the
 * same inset from both edges in both shapes: sliding the card outward on focus
 * put two things in motion where one would do, and the extra 8pt bought
 * nothing you could read.
 *
 * ## Three ways out, because a card you cannot put away is a trap
 *
 * Sending, blurring, and **dragging it down**. The drag is the one people
 * reach for without being told, and it works with a draft in the box: the
 * words are kept and shown in the pill, and tapping brings them back.
 *
 * ## The rest
 *
 * - **It moves with the keyboard, not after it.** `KeyboardStickyView` reads
 *   the keyboard's real frame every frame on the UI thread.
 * - **It grows with the text**, smoothly — the measured content height drives
 *   an animated wrapper rather than the field itself, so the box eases open a
 *   line at a time without the caret ever jumping.
 * - **Six lines, then it scrolls.**
 * - **Enter is a newline; the button sends.** `⏎ send` is a hardware-keyboard
 *   convention and inverting it on a phone loses half the messages people
 *   write. `⌘⏎` sends when a hardware keyboard is attached.
 * - **Send becomes stop while the agent works** — the same button in the same
 *   place, because reaching for a different one while something is running is
 *   the wrong moment to make somebody aim.
 * - **Dictating replaces the controls with a wave**, and the words appear
 *   above it as they are heard. See `Waveform`.
 */
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Image, Keyboard, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import Animated, {
  Easing,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { KeyboardStickyView, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { ArrowUp, ChevronDown, Mic, Paperclip, Plus, Square, X } from "lucide-react-native";
import type { Attached } from "~/api/generated/model";
import { megabytes, type Picked } from "~/ui/attach";
import { AttachMenu } from "~/ui/AttachMenu";
import { Waveform } from "~/ui/Waveform";
import { useDictation } from "~/ui/useDictation";
import { takeDraft } from "~/workspace/draft";
import { color, size } from "~/design/tokens.generated";

/**
 * One line at rest, six before it scrolls.
 *
 * `--text-read` is 18px on a 1.6 lead; 28 is that, rounded to an even number
 * so six of them is a whole box. A chat box is the one place in the app that
 * is pure reading.
 */
const LINE = 28;
const LINES = 6;

/** What a multiline field needs above and below its text, per platform. */
const PAD = Platform.OS === "ios" ? 14 : 18;

/** `--ease-swift`, and the web build's duration — in-content motion. */
const SWIFT = { duration: 200, easing: Easing.bezier(0.16, 1, 0.3, 1) };

const PILL = 28;
const CARD = 26;

/** Big enough to hit without looking. */
const TAP = "h-10 w-10 items-center justify-center rounded-full";

export function Composer({
  sessionId,
  working,
  model,
  mode,
  above,
  onSend,
  onAttach,
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
   * for as long as nobody speaks.
   */
  model?: string;
  mode?: string;
  /** What rides up with the composer — the approval card. */
  above?: React.ReactNode;
  onSend: (text: string, images: Attached[]) => void;
  /** A file for the workspace. Named in the message, not carried in it. */
  onAttach: (name: string, data: string) => Promise<void>;
  onInterrupt: () => void;
}) {
  const insets = useSafeAreaInsets();
  /* How far the keyboard is up, 0 to 1, on the UI thread. The composer's own
     bottom padding is the home indicator's — but only while the home
     indicator is visible. Once the keyboard covers it, holding the space open
     leaves a 34pt band of nothing between the box and the keys. */
  const { progress } = useReanimatedKeyboardAnimation();
  const rest = Math.max(insets.bottom, 8);
  const skirt = useAnimatedStyle(() => ({
    paddingBottom: rest - (rest - 8) * progress.value,
  }));
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  /* Put away on purpose, with words still in the box. Cleared by touching it
     again, so the drag is a dismissal and not a mode. */
  const [stowed, setStowed] = useState(false);
  const [chips, setChips] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const field = useRef<TextInput>(null);
  /** The draft dictation is sitting on top of, in case you cancel. */
  const before = useRef("");

  const dictation = useDictation();
  const { listening } = dictation;

  const open = !stowed && (focused || text.length > 0 || chips.length > 0);

  const shape = useSharedValue(0);
  const skin = useAnimatedStyle(() => ({
    borderRadius: PILL + (CARD - PILL) * shape.value,
  }));
  useEffect(() => {
    shape.value = withTiming(open ? 1 : 0, SWIFT);
  }, [open]);

  /* A workspace started from a task arrives with its issue waiting. Taken
     once, so coming back does not put it on top of what has since been
     typed. */
  useEffect(() => {
    const seeded = takeDraft(sessionId);
    if (seeded) setText(seeded);
  }, [sessionId]);

  /* What is being dictated goes into the box as it is heard, so it reads as
     writing rather than as waiting. */
  useEffect(() => {
    if (listening && dictation.heard) setText(dictation.heard);
  }, [listening, dictation.heard]);

  useEffect(() => {
    if (dictation.trouble) Alert.alert("Dictation", dictation.trouble);
  }, [dictation.trouble]);

  const put = () => {
    field.current?.blur();
    Keyboard.dismiss();
    setStowed(true);
    // Putting the composer away puts everything hanging off it away too.
    setMore(false);
  };

  /**
   * Drag it down to put it away.
   *
   * The gesture people reach for without being told. It keeps whatever is in
   * the box — a draft truncated into the pill is still there when you tap it.
   */
  const drag = Gesture.Pan()
    .activeOffsetY(12)
    .failOffsetY(-12)
    .onEnd((e) => {
      if (e.translationY > 28 || e.velocityY > 500) {
        Haptics.selectionAsync();
        put();
      }
    })
    .runOnJS(true);

  const send = () => {
    const said = text.trim();
    const images: Attached[] = chips
      .filter((c): c is Extract<Picked, { kind: "image" }> => c.kind === "image")
      .map((c) => ({ data: c.data, mediaType: c.mediaType }));
    if (!said && images.length === 0) return;

    /* Stop listening before emptying the box, or the final transcript lands
       in a composer you have already sent. */
    if (listening) dictation.cancel();

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSend(said, images);
    setText("");
    setChips([]);
    /* Sending is the end of your turn, so the composer goes back to being
       furniture rather than sitting open with a keyboard over the reply. */
    field.current?.blur();
    Keyboard.dismiss();
    setStowed(false);
  };

  const listen = () => {
    before.current = text;
    setStowed(false);
    setMore(false);
    /* The keyboard is in the way of a wave and of nothing else. */
    field.current?.blur();
    Keyboard.dismiss();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void dictation.start();
  };

  const drop = () => {
    dictation.cancel();
    setText(before.current);
  };

  /** A file goes to the workspace now and is only named in the message. */
  const carry = async (picked: Picked[]) => {
    if (picked.length === 0) return;
    setBusy(true);
    try {
      for (const one of picked) {
        if (one.kind === "file") await onAttach(one.name, one.data);
      }
      setChips((held) => [...held, ...picked]);
    } catch (e) {
      Alert.alert("That didn't attach", (e as Error)?.message ?? "The workspace refused it.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Rendered by calling these, not as `<Action />`.
   *
   * A component declared inside another component is a *new type* on every
   * render, so React unmounts and remounts its whole subtree. For a button
   * that is invisible waste; for the wave, whose trail and timer live in the
   * subtree, it would wipe the history ten times a second.
   */
  const Action = () =>
    working ? (
      <Pressable testID="stop" onPress={onInterrupt} className={`${TAP} bg-bone`} hitSlop={6}>
        <Square color={color.ground} size={13} fill={color.ground} />
      </Pressable>
    ) : text.trim() || chips.length ? (
      <Pressable testID="send" onPress={send} className={`${TAP} bg-bone`} hitSlop={6}>
        <ArrowUp color={color.ground} size={20} />
      </Pressable>
    ) : (
      /* Nothing written: the microphone is what the button is for. Saying
         something is the alternative to typing it, not an extra control
         competing for the same corner. */
      <Pressable testID="mic" onPress={listen} className={`${TAP} bg-overlay`} hitSlop={6}>
        <Mic color={color.dim} size={19} />
      </Pressable>
    );

  const Attach = () => (
    <Pressable
      testID="attach"
      onPress={() => {
        Haptics.selectionAsync();
        setMore((m) => !m);
      }}
      className={TAP}
      hitSlop={6}
      disabled={busy}
    >
      {busy ? <ActivityIndicator color={color.dim} size="small" /> : <Plus color={color.dim} size={22} />}
    </Pressable>
  );

  /** While it is listening, the controls are the wave and the two ways out. */
  const Hearing = () => (
    <View className="flex-row items-center gap-2">
      <Pressable testID="dictate-cancel" onPress={drop} className={`${TAP} bg-overlay`} hitSlop={6}>
        <X color={color.dim} size={18} />
      </Pressable>
      <Waveform level={dictation.level} />
      <Pressable testID="dictate-stop" onPress={dictation.stop} className={`${TAP} bg-overlay`} hitSlop={6}>
        <Square color={color.bone} size={13} fill={color.bone} />
      </Pressable>
      {text.trim() ? (
        <Pressable testID="send" onPress={send} className={`${TAP} bg-bone`} hitSlop={6}>
          <ArrowUp color={color.ground} size={20} />
        </Pressable>
      ) : null}
    </View>
  );

  return (
    <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
      <Animated.View style={[{ paddingTop: 6 }, skirt]}>
        {above}

        {more ? <AttachMenu onPick={carry} onClose={() => setMore(false)} /> : null}

        <GestureDetector gesture={drag}>
          <Animated.View
            layout={LinearTransition.duration(200)}
            style={[
              {
                backgroundColor: color.raise,
                marginHorizontal: 12,
                paddingHorizontal: 8,
                paddingVertical: 8,
                shadowColor: "#000",
                shadowOpacity: open ? 0.5 : 0,
                shadowRadius: 20,
                shadowOffset: { width: 0, height: 10 },
              },
              skin,
            ]}
          >
            {/* What is going with the message. A chip appears the moment you
                pick, so ten files read as ten things happening. */}
            {chips.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-2 px-1">
                <View className="flex-row gap-2">
                  {chips.map((c, i) => (
                    <View key={`${c.name}-${i}`} className="flex-row items-center gap-2 rounded-xl bg-overlay py-1.5 pl-1.5 pr-2.5">
                      {c.kind === "image" ? (
                        <Image source={{ uri: c.uri }} className="h-8 w-8 rounded-lg" />
                      ) : (
                        <View className="h-8 w-8 items-center justify-center rounded-lg bg-raise">
                          <Paperclip color={color.mute} size={14} />
                        </View>
                      )}
                      <View>
                        <Text numberOfLines={1} className="max-w-[120px] font-sans text-ui text-text">
                          {c.name}
                        </Text>
                        <Text className="font-sans text-micro text-mute">
                          {c.kind === "file" ? "in the workspace" : megabytes(c.bytes)}
                        </Text>
                      </View>
                      <Pressable onPress={() => setChips(chips.filter((_, j) => j !== i))} hitSlop={8}>
                        <X color={color.mute} size={14} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              </ScrollView>
            ) : null}

            {listening ? (
              <>
                {/* The words so far, above the wave. Read-only: editing what
                    is still being revised would fight the recogniser. */}
                {text ? (
                  <Text
                    numberOfLines={6}
                    className="px-2.5 pb-2 font-sans text-bone"
                    style={{ fontSize: size.read, lineHeight: LINE }}
                  >
                    {text}
                  </Text>
                ) : null}
                {Hearing()}
              </>
            ) : (
              <>
                {/* Slot order never changes: the input is always the middle
                    child, so React keeps the same instance and focus survives
                    the morph. */}
                <View className={`flex-row ${open ? "items-end" : "items-center"}`}>
                  {!open ? Attach() : null}

                  {/* The field sizes itself.
                      It measured its own content and fed the answer back into
                      its own height until today, which deadlocks: once a
                      `TextInput` has an explicit height, iOS reports that
                      height as its `contentSize`, the measurement can never
                      exceed the box, and the event stops firing entirely. The
                      box stays two lines and everything past that scrolls out
                      of sight. Bounds do the same job with no feedback in
                      them at all — and the wrapper holds `flex` so the field
                      itself is free to be exactly as tall as its text. */}
                  <View style={{ flex: 1 }}>
                  <TextInput
                    testID="composer"
                    ref={field}
                    multiline
                    value={text}
                    onChangeText={setText}
                    onFocus={() => {
                      setStowed(false);
                      setFocused(true);
                    }}
                    onBlur={() => setFocused(false)}
                    placeholder="Answer the agent"
                    placeholderTextColor={color.mute}
                    selectionColor={color.ember}
                    className="font-sans text-bone"
                    style={{
                      ...(open
                        ? { minHeight: LINE + PAD, maxHeight: LINE * LINES + PAD }
                        : { height: LINE + 10 }),
                      paddingHorizontal: 10,
                      paddingTop: open ? (Platform.OS === "ios" ? 8 : 4) : 0,
                      paddingBottom: open ? (Platform.OS === "ios" ? 6 : 4) : 0,
                      fontSize: size.read,
                      lineHeight: LINE,
                      /* Centred in the pill, where one line has room to sit
                         low; top-aligned in the card, where the second line
                         has to land under the first. */
                      textAlignVertical: open ? "top" : "center",
                    }}
                    onKeyPress={(e) => {
                      const native = e.nativeEvent as unknown as { key: string; metaKey?: boolean };
                      if (native.key === "Enter" && native.metaKey) send();
                    }}
                  />
                  </View>

                  {!open ? Action() : null}
                </View>

                {open ? (
                  <Animated.View
                    layout={LinearTransition.duration(200)}
                    className="flex-row items-center gap-1 pt-1"
                  >
                    {Attach()}
                    <View className="flex-1" />
                    {model ? (
                      <Pressable className="flex-row items-center gap-1 px-2 py-2" hitSlop={4}>
                        <Text
                          numberOfLines={1}
                          className="max-w-[140px] font-medium text-ui text-dim"
                        >
                          {model.replace(/^claude-/, "")}
                        </Text>
                        <ChevronDown color={color.mute} size={13} />
                      </Pressable>
                    ) : null}
                    {mode ? (
                      <Pressable className="flex-row items-center gap-1 px-2 py-2" hitSlop={4}>
                        <Text className="font-medium text-ui text-dim">{mode}</Text>
                        <ChevronDown color={color.mute} size={13} />
                      </Pressable>
                    ) : null}
                    {/* Dictating from the card, where the send button is
                        already spoken for by the draft. */}
                    {!text.trim() && !chips.length ? null : (
                      <Pressable testID="mic-card" onPress={listen} className={TAP} hitSlop={6}>
                        <Mic color={color.dim} size={19} />
                      </Pressable>
                    )}
                    {Action()}
                  </Animated.View>
                ) : null}
              </>
            )}
          </Animated.View>
        </GestureDetector>
      </Animated.View>
    </KeyboardStickyView>
  );
}
