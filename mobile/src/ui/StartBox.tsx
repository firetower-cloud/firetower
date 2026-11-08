/**
 * The composer on the home, and the shelf of decisions above it.
 *
 * **This is what `/new` used to be.** The desk merged its new-workspace form
 * into the home composer and the phone follows: the screen the `+` opened is
 * the screen you are already on, so the `+` goes with it. A six-field form was
 * the wrong shape for the thing it was asking — *what should we work on* — and
 * on a phone it was a page of pickers between you and a sentence.
 *
 * What is left is the sentence, and a **shelf** carrying only the decisions
 * that are genuinely unmade: which repository, and which machine. They sit on
 * the page *above* the card, which is where the desk puts them, and they
 * scroll — three chips do not fit 390 and which three is the server's
 * business. There is no shelf inside a workspace: those choices are settled
 * there, and furniture repeating them implies they are still open.
 *
 * `/new` is still a route, because a task seeds it with a key and a URL and
 * the shelf has nowhere to put those. Nothing links to it from here.
 *
 * ## The send control is whatever comes next
 *
 * Empty, it is the microphone — saying something is the alternative to typing
 * it, not an extra control competing for the same corner. With words in it,
 * send. That rule is `Composer`'s and this keeps it, because a person moving
 * between the two boxes should not have to learn a second one.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ArrowUp, ChevronDown, FolderGit2, Mic, Monitor, Paperclip } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

/** One unmade decision. `want` draws it as an invitation rather than a value. */
export type Chip = {
  id: string;
  label: string;
  icon: "repo" | "host";
  /** Nothing chosen yet, and choosing is the point. Outlined, not filled. */
  want?: boolean;
  onPress: () => void;
};

export function Shelf({ chips }: { chips: Chip[] }) {
  const { color } = useTheme();
  if (chips.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingHorizontal: 14, gap: 8, paddingBottom: 10 }}
    >
      {chips.map((c) => {
        const Icon = c.icon === "repo" ? FolderGit2 : Monitor;
        return (
          <Pressable
            key={c.id}
            testID={`shelf-${c.id}`}
            onPress={c.onPress}
            className={`h-10 flex-row items-center gap-2 rounded-full px-3.5 ${
              c.want ? "border border-line" : "bg-raise"
            }`}
            android_ripple={{ color: color.overlay }}
          >
            <Icon color={c.want ? color.dim : color.text} size={15} />
            <Text
              numberOfLines={1}
              className={`font-sans ${c.want ? "text-dim" : "text-text"}`}
              style={{ fontSize: size.body }}
            >
              {c.label}
            </Text>
            <ChevronDown color={color.mute} size={13} />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function StartBox({
  value,
  onChange,
  onStart,
  starting,
  chips,
  onDictate,
  onAttach,
}: {
  value: string;
  onChange: (next: string) => void;
  onStart: () => void;
  starting?: boolean;
  chips: Chip[];
  onDictate?: () => void;
  onAttach?: () => void;
}) {
  const { color } = useTheme();
  const [focused, setFocused] = useState(false);
  const ready = value.trim().length > 0;

  return (
    /* `flex:none` under a `flex:1` scroller is the whole mechanism: the
       sections take what is left and the box does not move. It is pinned, so
       it is outside the scroller and its height does not reflow at any pose. */
    <View
      className="pb-1.5"
      style={{
        flexShrink: 0,
        /* The drawing gives the composer `z-index: 20`, and on the Duo's
           front panel it is load-bearing rather than cosmetic: the system's
           floating tab bar declares a container the full size of the screen,
           and without a stacking order of its own the composer and its shelf
           fall behind it — they draw correctly and then cannot be reached, by
           a finger or by VoiceOver. */
        zIndex: 20,
      }}
    >
      <Shelf chips={chips} />

      <View
        className="mx-5 flex-row items-center gap-2 rounded-pill bg-float py-1.5 pl-5 pr-1.5"
        style={{
          /* Lit from above. React Native has no inset shadow, so per-side
             border colours say the same thing in one hairline — the box reads
             as raised rather than as a rectangle of a slightly different
             grey, with no gradient and no new native module. */
          borderTopWidth: 1,
          borderTopColor: color.line,
          borderLeftWidth: 1,
          borderRightWidth: 1,
          borderBottomWidth: 1,
          borderLeftColor: color["line-soft"],
          borderRightColor: color["line-soft"],
          borderBottomColor: color["line-soft"],
          shadowColor: "#000",
          shadowOpacity: 0.18,
          shadowRadius: 20,
          shadowOffset: { width: 0, height: 10 },
        }}
      >
        <TextInput
          testID="start-text"
          value={value}
          onChangeText={onChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Start something new…"
          placeholderTextColor={color.mute}
          /* `⏎` is a newline and the button sends. Inverting that on a phone
             loses half the messages people write. */
          multiline
          className="min-w-0 flex-1 font-sans text-bone"
          style={{ fontSize: size.read, maxHeight: size.read * 1.6 * 5, paddingTop: 6, paddingBottom: 6 }}
        />

        {onAttach && focused ? (
          <Pressable
            testID="start-attach"
            onPress={onAttach}
            className="h-10 w-10 items-center justify-center rounded-full"
            hitSlop={6}
          >
            <Paperclip color={color.mute} size={19} />
          </Pressable>
        ) : null}

        {starting ? (
          <View className="h-10 w-10 items-center justify-center">
            <ActivityIndicator color={color.mute} />
          </View>
        ) : ready ? (
          <Pressable
            testID="start-send"
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              onStart();
            }}
            className="h-10 w-10 items-center justify-center rounded-full bg-bone"
            hitSlop={6}
          >
            <ArrowUp color={color.ground} size={20} />
          </Pressable>
        ) : (
          <Pressable
            testID="start-dictate"
            onPress={onDictate}
            className="h-[38px] w-[38px] items-center justify-center rounded-full"
            hitSlop={6}
          >
            <Mic color={color.mute} size={19} />
          </Pressable>
        )}
      </View>
    </View>
  );
}
