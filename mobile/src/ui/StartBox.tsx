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
 * ## It moves with the keyboard, not after it
 *
 * `KeyboardStickyView` reads the keyboard's real frame every frame on the UI
 * thread, which is what `Composer` already does inside a workspace. **This box
 * did not, and that was a defect rather than an omission of polish**: on the
 * Duo's front panel the keyboard's top edge is at 376 and this sat at 578–672,
 * so it was completely covered and you could not see what you were typing.
 * Not a space problem — there was room at 280–376, which is where it goes now.
 *
 * `offset={{ closed: 0, opened: 0 }}`, the same as `Composer`, because the
 * composer **sits on the keyboard rather than on the home indicator**: the
 * bottom inset belongs to the indicator and the keyboard covers it, so holding
 * that 34pt open once the keys are up leaves a band of nothing between the box
 * and the keyboard — which `STYLE.md` names as the clearest tell that a layout
 * was written for a browser.
 *
 * ## The send control is whatever comes next
 *
 * Empty, it is the microphone — saying something is the alternative to typing
 * it, not an extra control competing for the same corner. With words in it,
 * send. That rule is `Composer`'s and this keeps it, because a person moving
 * between the two boxes should not have to learn a second one.
 */
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  ArrowUp,
  ChevronDown,
  FolderGit2,
  Mic,
  Monitor,
  Paperclip,
  Sparkles,
  UserRound,
} from "lucide-react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import * as Haptics from "expo-haptics";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

/** One unmade decision. `want` draws it as an invitation rather than a value. */
/** One still-open choice about what will run. */
export type Pick_ = { id: "agent" | "model"; label: string; onPress: () => void };

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
  picks,
  onDictate,
  onAttach,
}: {
  value: string;
  onChange: (next: string) => void;
  onStart: () => void;
  starting?: boolean;
  chips: Chip[];
  /** What the session will run, while that is still unsettled. */
  picks: Pick_[];
  onDictate?: () => void;
  onAttach?: () => void;
}) {
  const { color } = useTheme();
  const ready = value.trim().length > 0;

  return (
    /* `flex:none` under a `flex:1` scroller is the whole mechanism: the
       sections take what is left and the box does not move. It is pinned, so
       it is outside the scroller and its height does not reflow at any pose. */
    <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
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
          /**
           * **The home's box is the card, always.** The workspace composer is a
           * pill at rest and a card to write in, because there a conversation is
           * the screen and the box is furniture until you reach for it. Here the
           * box *is* the screen's purpose — the drawing has it open at every one
           * of the seven home states — so it does not morph and there is nothing
           * to morph from.
           */
          className="mx-3 gap-3 rounded-box bg-float px-3 pb-2.5 pt-4"
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
            placeholder="Start something new…"
            placeholderTextColor={color.mute}
            /* `⏎` is a newline and the button sends. Inverting that on a phone
               loses half the messages people write. */
            multiline
            className="px-1.5 font-sans text-bone"
            style={{ fontSize: size.read, maxHeight: size.read * 1.6 * 6, paddingTop: 0, paddingBottom: 0 }}
          />

          <View className="flex-row items-center gap-1.5">
            <Pressable
              testID="start-attach"
              onPress={onAttach}
              className="h-10 w-10 items-center justify-center rounded-full"
              hitSlop={6}
            >
              <Paperclip color={color.mute} size={19} />
            </Pressable>

            {/* The decisions that are still open, and **the row scrolls**: two
                pickers do not fit beside a paperclip and a send button at 390,
                and which pickers exist is not ours to fix at two. They open the
                form that collects them, the same way the shelf above does —
                drawn as what they are rather than as a control that does
                nothing, which is what these were on the desk for a while. */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              className="min-w-0 flex-1"
              contentContainerStyle={{ gap: 2, alignItems: "center" }}
            >
              {picks.map((pick) => (
                <Pressable
                  key={pick.id}
                  testID={`start-pick-${pick.id}`}
                  onPress={pick.onPress}
                  className="h-[34px] flex-row items-center gap-1.5 px-1.5"
                >
                  {pick.id === "agent" ? (
                    <UserRound color={color.mute} size={14} />
                  ) : (
                    <Sparkles color={color.mute} size={14} />
                  )}
                  <Text numberOfLines={1} className="font-sans text-dim" style={{ fontSize: size.ui }}>
                    {pick.label}
                  </Text>
                  <ChevronDown color={color.mute} size={13} />
                </Pressable>
              ))}
            </ScrollView>

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
                className="h-10 w-10 items-center justify-center rounded-full"
                hitSlop={6}
              >
                <Mic color={color.mute} size={19} />
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </KeyboardStickyView>
  );
}
