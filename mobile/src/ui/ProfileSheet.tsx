/**
 * Which profile the agent wears, picked from the composer — and which team is
 * behind it.
 *
 * The desk's `ProfileMenu`, as a sheet, and it takes the same things it does
 * — the profiles, the teams, the one in force, and what to do about a choice.
 *
 * ## The same rows and the same counts as the desk, because the distinction
 * is harder here
 *
 * **You never talk to a team — you talk to its lead, with its team behind
 * it.** A team row names its lead and its size before it is picked, teams band
 * above profiles, and a profile that leads a team appears twice: once bare,
 * which cannot hand work to anybody, and once as the team, which starts that
 * same profile with its reports reachable. One agent, or eight.
 *
 * That is not a thing to soften on a phone. Starting work is within what
 * mobile may do, and the one-agent-or-eight difference is *harder* on a small
 * screen, not easier — so the rows, the counts and the sentence are the desk's
 * and nothing is dropped to save height.
 *
 * A position is never a row. A position only means something inside its tree.
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
import { Check, Search, UserRound, Users } from "lucide-react-native";
import type { Agent, AgentTeam, Role } from "~/api/generated/model";
import {
  consequence,
  searchable,
  startableIn,
  startableMatches,
  startables,
  type StartAs,
  type Startable,
} from "~/api/start";
import { AgentMark } from "~/ui/AgentMark";
import { BandLabel } from "~/ui/BandLabel";
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
  dimmed,
  onPress,
}: {
  glyph: React.ReactNode;
  title: string;
  sub?: string;
  chip?: string;
  on: boolean;
  first?: boolean;
  /**
   * A row there is nothing to start. **Dimmed, never red**: a team whose lead
   * profile is gone has not failed, it is incomplete — `STYLE.md` makes that
   * distinction load-bearing — and the second line says which.
   */
  dimmed?: boolean;
  onPress: () => void;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      /* Not merely dimmed: a row that looks pressable and silently does
         nothing is worse than one that plainly is not a control, and the
         second line is already carrying the reason. */
      disabled={dimmed}
      className={`min-h-[56px] flex-row items-center gap-3 px-5 py-2.5 ${
        first ? "" : "border-t border-line-soft"
      }`}
      style={dimmed ? { opacity: 0.4 } : undefined}
      android_ripple={dimmed ? undefined : { color: color.overlay }}
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
  teams,
  startAs,
  onPick,
  onClose,
}: {
  profiles: Role[];
  teams: AgentTeam[];
  startAs: StartAs;
  /** `null` is *Just an agent*, which is a value and not a dismissal. */
  onPick: (next: StartAs) => void;
  onClose: () => void;
}) {
  const { color } = useTheme();
  const [query, setQuery] = useState("");

  const all = useMemo(() => startables(teams, profiles), [teams, profiles]);
  const shown = useMemo(() => all.filter((s) => startableMatches(s, query)), [all, query]);
  const typed = query.trim().length > 0;
  const picked = startableIn(all, startAs);
  /* The band labels exist to tell a team from a profile of the same name.
     With no teams there is nothing to tell apart, and a label over the only
     band would be furniture claiming the list has containers. */
  const banded = teams.length > 0;

  const bands: { kind: Startable["kind"]; says: string; rows: Startable[] }[] = (
    ["team", "profile"] as const
  )
    .map((kind) => ({
      kind,
      says: kind === "team" ? "Agent teams" : "Profiles",
      rows: shown.filter((s) => s.kind === kind),
    }))
    .filter((b) => b.rows.length > 0);

  return (
    <Sheet open onClose={onClose} maxHeight="86%">
      <Text className="px-5 pb-2 pt-1 font-narrow text-micro uppercase tracking-[0.18em] text-mute">
        Profile
      </Text>

      {searchable(all.length) ? (
        <View className="h-11 flex-row items-center gap-2.5 border-b border-line-soft px-5">
          <Search color={color.mute} size={15} />
          <TextInput
            testID="profile-search"
            value={query}
            onChangeText={setQuery}
            placeholder={banded ? "Search teams and profiles" : "Search profiles"}
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
            on={!startAs}
            first
            onPress={() => onPick(null)}
          />
        ) : null}
        {bands.map((band, which) => (
          <View key={band.kind}>
            {/* `BandLabel` is where a band turns in every list in this app,
                and it carries the count — which here is how many teams there
                are to choose between, read before any of them is tapped. */}
            {banded ? (
              <BandLabel
                says={band.says}
                count={band.rows.length}
                first={typed && which === 0}
              />
            ) : null}
            {band.rows.map((s, at) => (
              <Row
                key={`${s.kind}:${s.id}`}
                glyph={
                  s.agent ? (
                    <AgentMark agent={s.agent as Agent} size={17} tone={color.dim} />
                  ) : s.kind === "team" ? (
                    <Users color={color.dim} size={17} />
                  ) : (
                    <UserRound color={color.dim} size={17} />
                  )
                }
                title={s.name}
                sub={s.blocked ?? s.does ?? undefined}
                /* **The size, before it is picked.** One agent or eight is
                    the difference this row has to carry, and the count is the
                    shortest true way to say it. `agents` is the lead and the
                    reports it can actually reach — not every seat in the
                    tree, which overstated both the depth and what this person
                    can see. */
                chip={
                  s.kind === "team"
                    ? `${s.agents} agent${s.agents === 1 ? "" : "s"}`
                    : s.delegates
                      ? "can delegate"
                      : undefined
                }
                on={s.kind === startAs?.kind && s.id === startAs.id}
                dimmed={!!s.blocked}
                first={!banded && typed && at === 0}
                onPress={() => !s.blocked && onPick({ kind: s.kind, id: s.id })}
              />
            ))}
          </View>
        ))}
        {typed && shown.length === 0 ? (
          <Text className="px-5 py-7 text-center font-sans text-meta text-mute">
            No {banded ? "team or profile" : "profile"} matches “{query.trim()}”.
          </Text>
        ) : null}
      </ScrollView>

      {/* **What picking this would do, or what they are for.** With something
          chosen it is the consequence — one agent, or a lead with its team
          reachable — which is the desk's sentence to the character. With
          nothing chosen it is what profiles and teams are for, which is what
          somebody meeting an empty list needs. */}
      <View className="border-t border-line-soft px-5 pb-1 pt-3">
        <Text className="font-sans text-meta text-dim" style={{ lineHeight: size.meta * 1.6 }}>
          {picked ? (
            consequence(picked)
          ) : (
            <>
              You can create agent profiles to divide your work across a team of agents — a
              designer, an engineer, a security advisor, a QA. Put them in an agent team and its
              lead can hand work to the rest.
              {profiles.length === 0 ? (
                <Text className="text-mute">
                  {" "}
                  You have none yet. They are made in the desktop app or the web console.
                </Text>
              ) : null}
            </>
          )}
        </Text>
      </View>
    </Sheet>
  );
}
