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
 * the shelf has nowhere to put those. **Nothing links to it from here**, and
 * that sentence was aspirational for a release: the `host` chip, the two picks
 * and the send button all pushed the form, so the modal was not an edge case
 * — it was the whole start flow wearing a composer as a façade. Every control
 * on this box now resolves in place and the send button creates the session.
 * `(tabs)/tasks.tsx` is the one thing that still opens the form, which is what
 * the form is now for.
 *
 * ## Where the shelf ends and the picks begin
 *
 * The shelf carries **where** the work happens — a repository and a machine.
 * The picks, inside the card, carry **what does it** — the profile, then the
 * run: engine, account, model, effort, permissions. That lines up one for one
 * with the desk's footer bar, and it is why the profile is a pick rather than
 * a third chip: a persona is not a place, putting it on the shelf would
 * separate it from the engine it pins, and the strip already admits that two
 * chips do not fit 390.
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
 *
 * **And it sends.** The box used to hand what you typed to `/new` as a title;
 * it now creates the workspace and the sentence travels with it as the first
 * prompt, which is what the desk does. A filled ↑ that does not send is the
 * single most surprising control a phone can draw, and this was the only
 * place in the app that drew one. See the head of `app/new.tsx`, which
 * carries the rest of that argument and the half of it that did not change.
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
import type { Agent } from "~/api/generated/model";
import { AgentMark } from "~/ui/AgentMark";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

/**
 * One still-open choice about what will run.
 *
 * It was `{ id: "agent" | "model" }` with a bare `onPress`, which is as much
 * as a control that pushed a form needed to know. A control that resolves in
 * place has to say what it resolved *to*: hence the glyph, which carries an
 * engine's mark when there is one, and `set`, which is how *a profile is in
 * force* is legible without opening anything.
 */
export type Pick_ = {
  id: string;
  /**
   * The mark on the left. An `Agent` draws that engine's own mark; `person` is
   * the unset profile, which is a choice rather than a blank; `none` is a
   * control whose subject this server has not named yet.
   */
  glyph: Agent | "person" | "none";
  label: string;
  /**
   * What the label is *in*, dimmed after it — the agent team behind a lead.
   *
   * **You never talk to a team, you talk to its lead**, so the label is the
   * lead's name and this is what stands behind it. A second `Text` in `mute`
   * rather than a middle dot joined onto the label, which `STYLE.md` rules
   * out for exactly this; both truncate, and the lead's name is the one that
   * gets the room because it is who answers.
   */
  sub?: string;
  /**
   * Chosen rather than resolved. `bone` against `dim` — the desk's `data-set`
   * said in weight, which is the only way a phone has to say it.
   */
  set?: boolean;
  /**
   * Shown, not chosen: something upstream decided it. No chevron and no
   * press, because a control that looks like one and refuses is worse than a
   * sentence.
   *
   * Nothing on the home sets this yet — the lock that exists today is the
   * Agent row *inside* `RunSheet`, where a profile's pinned engine lands. The
   * slot is here because whether a pick is a control is a property of the
   * pick, not of the sheet behind it.
   */
  locked?: boolean;
  onPress: () => void;
};

/**
 * Why the composer cannot send, said once, between the shelf and the card.
 *
 * Which is where the desk puts `create.isError`. **Brick for a failure and
 * dim for an absence** — a machine that is not there has not failed, and
 * `STYLE.md` makes that distinction load-bearing. Neither is ember: ember
 * answers *is an agent waiting on you*, and this is a thing you have not done
 * yet.
 *
 * Nothing goes *under* the box. The bottom of the screen belongs to the
 * message.
 */
export type Notice = { tone: "brick" | "dim"; say: string };

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
  ready,
  chips,
  picks,
  notice,
  onDictate,
  onAttach,
}: {
  value: string;
  onChange: (next: string) => void;
  onStart: () => void;
  starting?: boolean;
  /**
   * Whether the workspace could actually be made.
   *
   * The ↑ appears as soon as there are words — that rule is the composer's and
   * it does not bend — but it is live only when there is a machine, an agent
   * it can run and an account to spend. Otherwise it is `overlay` and the
   * notice above says which of the three is missing, so a dead button is
   * never the only thing on screen explaining itself.
   */
  ready?: boolean;
  chips: Chip[];
  /** What the session will run, while that is still unsettled. */
  picks: Pick_[];
  /** Why it will not send, when it will not. */
  notice?: Notice | null;
  onDictate?: () => void;
  onAttach?: () => void;
}) {
  const { color } = useTheme();
  const typed = value.trim().length > 0;
  const live = ready !== false;

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

        {/* Between the shelf and the card, and only once there is something
            to send: it answers *why can't I send this* rather than
            announcing itself at rest. */}
        {notice && typed ? (
          <Text
            testID="start-notice"
            className={`pb-2 font-sans ${notice.tone === "brick" ? "text-brick" : "text-dim"}`}
            /* 18, between the shelf's 14 and the card's 24, so the line sits
               under the chips and over the box rather than with either. */
            style={{ paddingHorizontal: 18, fontSize: size.meta, lineHeight: size.meta * 1.5 }}
          >
            {notice.say}
          </Text>
        ) : null}

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
                and which pickers exist is not ours to fix at two. They open a
                sheet each and resolve in place — drawn as what they are rather
                than as a control that does nothing, which is what these were
                on the desk for a while and what they were here until the
                sheets existed. */}
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
                  disabled={pick.locked}
                  onPress={pick.onPress}
                  className="h-[34px] max-w-[190px] flex-row items-center gap-1.5 px-1.5"
                >
                  {pick.glyph === "person" ? (
                    <UserRound color={pick.set ? color.bone : color.mute} size={14} />
                  ) : pick.glyph === "none" ? (
                    <Sparkles color={color.mute} size={14} />
                  ) : (
                    <AgentMark agent={pick.glyph} size={14} tone={pick.set ? color.bone : color.mute} />
                  )}
                  <Text
                    numberOfLines={1}
                    className={`shrink font-sans ${pick.set ? "text-bone" : "text-dim"}`}
                    style={{ fontSize: size.ui }}
                  >
                    {pick.label}
                  </Text>
                  {pick.sub ? (
                    <Text
                      numberOfLines={1}
                      className="shrink font-sans text-mute"
                      style={{ fontSize: size.ui }}
                    >
                      in {pick.sub}
                    </Text>
                  ) : null}
                  {pick.locked ? null : <ChevronDown color={color.mute} size={13} />}
                </Pressable>
              ))}
            </ScrollView>

            {starting ? (
              <View className="h-10 w-10 items-center justify-center">
                <ActivityIndicator color={color.mute} />
              </View>
            ) : typed ? (
              <Pressable
                testID="start-send"
                disabled={!live}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  onStart();
                }}
                className={`h-10 w-10 items-center justify-center rounded-full ${live ? "bg-bone" : "bg-overlay"}`}
                hitSlop={6}
              >
                <ArrowUp color={live ? color.ground : color.mute} size={20} />
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
