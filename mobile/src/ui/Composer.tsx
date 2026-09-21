/**
 * Saying something to the agent.
 *
 * The thing an app is judged on in the first ten seconds, so the behaviour is
 * spelled out rather than left to a library's defaults.
 *
 * ## It is two shapes, not one
 *
 * **At rest it is a pill** — one row, compact, inset from both edges. It is
 * furniture; the conversation is the screen and the composer should not take a
 * sixth of it to say nothing.
 *
 * **Writing in it, it is a card** — the text gets a line of its own, the
 * controls drop to a second row, corners square off, and it widens toward the
 * edges. The desk says *the composer is the second-heaviest object on the
 * screen*; it is only the second-heaviest while you are using it.
 *
 * The morph is one layout transition on the UI thread, not two components
 * swapped — the `TextInput` holds the same slot in the tree throughout, so
 * focus, selection and the keyboard never notice it happened.
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
 * - **It grows to six lines, then scrolls.**
 * - **Enter is a newline; the button sends.** `⏎ send` is a hardware-keyboard
 *   convention and inverting it on a phone loses half the messages people
 *   write. `⌘⏎` sends when a hardware keyboard is attached.
 * - **Send becomes stop while the agent works** — the same button in the same
 *   place, because reaching for a different one while something is running is
 *   the wrong moment to make somebody aim.
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
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { ArrowUp, Camera, ChevronDown, FileText, Image as ImageIcon, Mic, Paperclip, Plus, Square, X } from "lucide-react-native";
import type { Attached } from "~/api/generated/model";
import { megabytes, pickFiles, pickImages, takePhoto, type Picked } from "~/ui/attach";
import { useDictation } from "~/ui/useDictation";
import { takeDraft } from "~/workspace/draft";
import { color, size } from "~/design/tokens.generated";

/** One line at rest, six before it scrolls. */
const LINE = 22;
const MIN = LINE;
const MAX = LINE * 6;

/** `--ease-swift`, and the web build's duration — in-content motion. */
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
  const [text, setText] = useState("");
  const [height, setHeight] = useState(MIN);
  const [focused, setFocused] = useState(false);
  /* Put away on purpose, with words still in the box. Cleared by touching it
     again, so the drag is a dismissal and not a mode. */
  const [stowed, setStowed] = useState(false);
  const [chips, setChips] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const field = useRef<TextInput>(null);

  const dictation = useDictation();

  const open = !stowed && (focused || text.length > 0 || chips.length > 0);

  const shape = useSharedValue(0);
  const skin = useAnimatedStyle(() => ({
    borderRadius: PILL + (CARD - PILL) * shape.value,
    marginHorizontal: 12 - 4 * shape.value,
  }));
  const morph = (to: number) => {
    shape.value = withTiming(to, SWIFT);
  };
  useEffect(() => morph(open ? 1 : 0), [open]);

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
    if (dictation.listening && dictation.heard) setText(dictation.heard);
  }, [dictation.listening, dictation.heard]);

  useEffect(() => {
    if (dictation.trouble) Alert.alert("Dictation", dictation.trouble);
  }, [dictation.trouble]);

  /* An empty composer is one line, whatever the last measurement said. */
  const tall = text.length === 0 ? MIN : height;

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

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSend(said, images);
    setText("");
    setChips([]);
    setHeight(MIN);
    /* Sending is the end of your turn, so the composer goes back to being
       furniture rather than sitting open with a keyboard over the reply. */
    field.current?.blur();
    Keyboard.dismiss();
    setStowed(false);
  };

  /** A file goes to the workspace now and is only named in the message. */
  const carry = async (picked: Picked[]) => {
    setMore(false);
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

  const Action = () =>
    working ? (
      <Pressable
        testID="stop"
        onPress={onInterrupt}
        className="h-9 w-9 items-center justify-center rounded-full bg-bone"
        hitSlop={6}
      >
        <Square color={color.ground} size={12} fill={color.ground} />
      </Pressable>
    ) : dictation.listening ? (
      /* While it is listening the send control is a stop, because stopping is
         the only thing anybody wants next. */
      <Pressable
        onPress={dictation.stop}
        className="h-9 w-9 items-center justify-center rounded-full bg-ember"
        hitSlop={6}
      >
        <Square color={color.ground} size={12} fill={color.ground} />
      </Pressable>
    ) : text.trim() || chips.length ? (
      <Pressable
        testID="send"
        onPress={send}
        className="h-9 w-9 items-center justify-center rounded-full bg-bone"
        hitSlop={6}
      >
        <ArrowUp color={color.ground} size={18} />
      </Pressable>
    ) : (
      /* Nothing written: the microphone is what the button is for. Saying
         something is the alternative to typing it, not an extra control
         competing for the same corner. */
      <Pressable
        testID="mic"
        onPress={() => void dictation.start()}
        className="h-9 w-9 items-center justify-center rounded-full bg-overlay"
        hitSlop={6}
      >
        <Mic color={color.dim} size={17} />
      </Pressable>
    );

  const Attach = () => (
    <Pressable
      testID="attach"
      onPress={() => setMore((m) => !m)}
      className="h-9 w-9 items-center justify-center rounded-full"
      hitSlop={6}
      disabled={busy}
    >
      {busy ? <ActivityIndicator color={color.dim} size="small" /> : <Plus color={color.dim} size={20} />}
    </Pressable>
  );

  return (
    <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
      <View style={{ paddingTop: 6, paddingBottom: Math.max(insets.bottom, 8) }}>
        {above}

        {/* What the `+` opens. Three ways in, because a picture and a file go
            to different places and the choice is the point. */}
        {more ? (
          <Animated.View
            layout={LinearTransition.duration(200)}
            className="mx-3 mb-2 flex-row gap-2 rounded-xl bg-raise p-2"
          >
            {[
              { id: "photos", label: "Photos", icon: ImageIcon, run: pickImages },
              { id: "camera", label: "Camera", icon: Camera, run: takePhoto },
              { id: "files", label: "Files", icon: FileText, run: pickFiles },
            ].map(({ id, label, icon: Icon, run }) => (
              <Pressable
                key={id}
                onPress={async () => carry(await run())}
                className="flex-1 items-center gap-1.5 rounded-lg py-3"
                android_ripple={{ color: color.overlay }}
              >
                <Icon color={color.dim} size={18} />
                <Text className="font-medium text-meta text-dim">{label}</Text>
              </Pressable>
            ))}
          </Animated.View>
        ) : null}

        <GestureDetector gesture={drag}>
          <Animated.View
            layout={LinearTransition.duration(200)}
            style={[
              {
                backgroundColor: color.raise,
                paddingHorizontal: 6,
                paddingVertical: 6,
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
                    <View key={`${c.name}-${i}`} className="flex-row items-center gap-2 rounded-lg bg-overlay py-1.5 pl-1.5 pr-2">
                      {c.kind === "image" ? (
                        <Image source={{ uri: c.uri }} className="h-7 w-7 rounded-md" />
                      ) : (
                        <View className="h-7 w-7 items-center justify-center rounded-md bg-raise">
                          <Paperclip color={color.mute} size={13} />
                        </View>
                      )}
                      <View>
                        <Text numberOfLines={1} className="max-w-[120px] font-sans text-meta text-text">
                          {c.name}
                        </Text>
                        <Text className="font-sans text-mute" style={{ fontSize: 10 }}>
                          {c.kind === "file" ? "in the workspace" : megabytes(c.bytes)}
                        </Text>
                      </View>
                      <Pressable onPress={() => setChips(chips.filter((_, j) => j !== i))} hitSlop={8}>
                        <X color={color.mute} size={13} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              </ScrollView>
            ) : null}

            {/* Slot order never changes: the input is always the middle child,
                so React keeps the same instance and focus survives the morph. */}
            <View className={`flex-row ${open ? "items-end" : "items-center"}`}>
              {!open ? <Attach /> : null}

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
                onContentSizeChange={(e) => {
                  if (!text.length) return;
                  setHeight(Math.min(MAX, Math.max(MIN, e.nativeEvent.contentSize.height)));
                }}
                placeholder={dictation.listening ? "Listening…" : "Answer the agent"}
                placeholderTextColor={dictation.listening ? color.ember : color.mute}
                selectionColor={color.ember}
                className="flex-1 font-sans text-bone"
                /* The asymmetric padding is what a multiline field needs once
                   it has grown; at rest it is what pushed the placeholder off
                   the pill's centre line. */
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

            {open ? (
              <Animated.View
                layout={LinearTransition.duration(200)}
                className="flex-row items-center gap-1 pt-1"
              >
                <Attach />
                <View className="flex-1" />
                {model ? (
                  <Pressable className="flex-row items-center gap-1 px-2 py-2" hitSlop={4}>
                    <Text numberOfLines={1} className="font-medium text-meta text-dim">
                      {model}
                    </Text>
                    <ChevronDown color={color.mute} size={12} />
                  </Pressable>
                ) : null}
                {mode ? (
                  <Pressable className="flex-row items-center gap-1 px-2 py-2" hitSlop={4}>
                    <Text className="font-medium text-meta text-dim">{mode}</Text>
                    <ChevronDown color={color.mute} size={12} />
                  </Pressable>
                ) : null}
                <Action />
              </Animated.View>
            ) : null}
          </Animated.View>
        </GestureDetector>
      </View>
    </KeyboardStickyView>
  );
}
