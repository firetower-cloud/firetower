/**
 * Which profile the agent wears, picked from the composer.
 *
 * The desk's `ProfileMenu`, as a sheet, and it takes the same three things it
 * does — the profiles, the one in force, and what to do about a choice.
 *
 * ## Why this is a `Sheet` and not a `Picker`
 *
 * `Picker` is the app's one shape for *choose one of these*, and everything
 * the composer's shelf opens is one. This is not quite one: it needs a search
 * field above the rows, a per-row chip, and a footer paragraph saying what a
 * profile is for — and `Picker` has slots for none of the three. Growing them
 * onto it would put three unused props on the four pickers that do not want
 * them.
 *
 * ## “Just an agent” is a choice, not a blank
 *
 * It is drawn in the same weight as any profile — not greyed, not italic, not
 * a placeholder — because it is not one. Most sessions are started that way,
 * it is the value the API takes when `profile` is omitted, and the desk prints
 * the same words. What steps up to `bone` is the *chip in the composer*, which
 * is where "a profile is in force" has to be legible without opening anything.
 *
 * And it is drawn **only with nothing typed**: it is not a profile and cannot
 * match a search for one.
 *
 * ## The search box does not take focus
 *
 * This is the one place the desk's behaviour must not be copied. A sheet that
 * opens with the keyboard up covers the list it just opened — on a phone the
 * keyboard is half the screen, and the first thing you would have to do is
 * dismiss it to see what you came for. It appears above three profiles, the
 * desk's own threshold, and it waits to be tapped.
 *
 * ## At nothing, it is not empty
 *
 * Zero profiles is one row — *Just an agent*, ticked — and the footer. A sheet
 * that says *nothing here* over a working choice is a lie about the only
 * option you have.
 *
 * **And the footer loses the desk's button, deliberately.** The desk offers
 * *Create a profile* and navigates to `/configuration/roles`. There is no
 * Profiles screen here and there should not be one: a profile is authored on a
 * desk, and this client reads and starts work. So the footer keeps the
 * explanation and says where one is made instead. That is a real parity gap
 * and it is the right one — the alternative is a phone screen for authoring
 * personas, which is a feature rather than a fix.
 */
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Check, Search, UserRound } from "lucide-react-native";
import type { Agent, Role } from "~/api/generated/model";
import { orderProfiles, profileMatches, searchable } from "~/api/start";
import { AgentMark } from "~/ui/AgentMark";
import { Sheet } from "~/ui/Sheet";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

/**
 * One 56pt row: glyph, two lines, an optional chip and a tick.
 *
 * The hairline is between rows rather than under every one of them, so the
 * last row does not have a line separating it from the footer's own.
 */
function Row({
  glyph,
  title,
  sub,
  chip,
  on,
  first,
  onPress,
}: {
  glyph: React.ReactNode;
  title: string;
  sub?: string;
  chip?: string;
  on: boolean;
  first?: boolean;
  onPress: () => void;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      className={`min-h-[56px] flex-row items-center gap-3 px-5 py-2.5 ${
        first ? "" : "border-t border-line-soft"
      }`}
      android_ripple={{ color: color.overlay }}
    >
      <View className="w-[22px] items-center">{glyph}</View>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="font-medium text-bone" style={{ fontSize: size.ui }}>
          {title}
        </Text>
        {sub ? (
          <Text numberOfLines={1} className="mt-0.5 font-sans text-meta text-mute">
            {sub}
          </Text>
        ) : null}
      </View>
      {/* **Never ember.** A capability is not a thing waiting on you, so the
          chip is a hairline and `dim` — which is what the desk draws too. */}
      {chip ? (
        <Text className="shrink-0 rounded-full border border-line px-2 font-sans text-micro text-dim">
          {chip}
        </Text>
      ) : null}
      {on ? <Check color={color.sage} size={17} /> : null}
    </Pressable>
  );
}

export function ProfileSheet({
  profiles,
  profileId,
  onPick,
  onClose,
}: {
  profiles: Role[];
  profileId: string | null;
  /** `null` is *Just an agent*, which is a value and not a dismissal. */
  onPick: (id: string | null) => void;
  onClose: () => void;
}) {
  const { color } = useTheme();
  const [query, setQuery] = useState("");

  const ordered = useMemo(() => orderProfiles(profiles), [profiles]);
  const shown = useMemo(() => ordered.filter((p) => profileMatches(p, query)), [ordered, query]);
  const typed = query.trim().length > 0;

  return (
    <Sheet open onClose={onClose} maxHeight="86%">
      <Text className="px-5 pb-2 pt-1 font-narrow text-micro uppercase tracking-[0.18em] text-mute">
        Profile
      </Text>

      {searchable(profiles.length) ? (
        <View className="h-11 flex-row items-center gap-2.5 border-b border-line-soft px-5">
          <Search color={color.mute} size={15} />
          <TextInput
            testID="profile-search"
            value={query}
            onChangeText={setQuery}
            placeholder="Search profiles"
            placeholderTextColor={color.mute}
            selectionColor={color.ember}
            autoCapitalize="none"
            autoCorrect={false}
            /* Deliberately not focused. See the note at the top. */
            className="min-w-0 flex-1 font-sans text-bone"
            style={{ fontSize: size.ui, paddingVertical: 0 }}
          />
        </View>
      ) : null}

      {/* No `flex-1`: this sheet has no definite height of its own — the
          surface is bounded by `maxHeight` and everything inside shrinks to
          fit — so a basis of zero would collapse the list to nothing. The
          rows contribute their height and the scroller gives it back. Same
          shape as `Picker`. */}
      <ScrollView keyboardShouldPersistTaps="handled">
        {!typed ? (
          <Row
            glyph={<UserRound color={color.dim} size={17} />}
            title="Just an agent"
            sub="No profile — a plain workspace"
            on={!profileId}
            first
            onPress={() => onPick(null)}
          />
        ) : null}
        {shown.map((p, at) => (
          <Row
            key={p.id}
            glyph={
              p.agent ? (
                <AgentMark agent={p.agent as Agent} size={17} tone={color.dim} />
              ) : (
                <UserRound color={color.dim} size={17} />
              )
            }
            title={p.name}
            sub={p.does || undefined}
            chip={p.canDelegate ? "can delegate" : undefined}
            on={p.id === profileId}
            first={typed && at === 0}
            onPress={() => onPick(p.id)}
          />
        ))}
        {typed && shown.length === 0 ? (
          <Text className="px-5 py-7 text-center font-sans text-meta text-mute">
            No profile matches “{query.trim()}”.
          </Text>
        ) : null}
      </ScrollView>

      <View className="border-t border-line-soft px-5 pb-1 pt-3">
        <Text className="font-sans text-meta text-dim" style={{ lineHeight: size.meta * 1.6 }}>
          You can create agent profiles to divide your work across a team of agents — a designer, an
          engineer, a security advisor, a QA.
          {profiles.length === 0 ? (
            <Text className="text-mute">
              {" "}
              You have none yet. They are made in the desktop app or the web console.
            </Text>
          ) : null}
        </Text>
      </View>
    </Sheet>
  );
}
