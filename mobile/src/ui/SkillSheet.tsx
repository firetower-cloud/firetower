/**
 * Choosing what this session's agent reads.
 *
 * The phone's half of `desktop/src/ui/SkillPicker.tsx`, and the desk's
 * arguments all survive the trip:
 *
 * **Nothing happens until it is confirmed.** Ticking edits a draft and the
 * session keeps reading what it was reading. The reason is not politeness —
 * the descriptions sit in the system prompt, so changing the set changes the
 * prompt prefix and the next turn re-bills the whole conversation as uncached
 * input. One of those per decision is affordable; one per checkbox is not.
 *
 * **Groups are about where a skill comes from, never about whether it is
 * ticked.** A default stays under *Your defaults here* when it is turned off.
 * On a phone that rule is stronger than on a desk: a row that moved when it
 * was tapped would move out from under the finger that tapped it.
 *
 * **"Always on" is drawn toggleable, and the words are provenance rather than
 * a lock.** `choose_skills` takes the whole selection and special-cases
 * nothing — it filters to what this person can see, refuses two of one name,
 * and `set_for_session` then deletes every pin outside the set. So an
 * always-on skill genuinely can be unticked for one session, on this client
 * and on the desk. A disabled tick here would make the phone refuse something
 * the desk allows, which is the worst kind of parity gap: invisible until
 * somebody needs it.
 *
 * ## What is the phone's rather than the desk's
 *
 * - **The search box appears above eight skills, and never autofocuses.** The
 *   desk always shows its own and focuses it. Eight is where the list stops
 *   fitting one screenful at 56pt rows, and a keyboard raised on open would
 *   cover the list the sheet just opened.
 * - **The tick is on the left, 22pt, bone-filled.** Deliberately not
 *   `Picker`'s right-hand sage `Check`: that one means *this is the one you
 *   chose*, and this is a draft of several that is not live yet. The whole
 *   56pt row is the target, so the small box costs nothing in reach.
 * - **There is no Cancel.** Three ways out already — drag down, the scrim, the
 *   back gesture — so a second button would only take width from the one that
 *   commits. That button is 52pt and full width and carries the count, which
 *   is the mitigation for the one real risk here: a flick discards a half-made
 *   selection silently, exactly as every other sheet in this app behaves.
 * - **The repositories the defaults switch aims at open a second `Picker`**
 *   rather than disclosing inline. A disclosure inside a scrolling sheet
 *   inside a modal is three nested scroll regions and the middle one loses.
 * - **Nowhere to go when the library is empty.** The desk offers *Open
 *   Skills*; the phone has no Skills screen and importing a skill is a folder
 *   drop. So the empty pane says *where* instead of offering to take you
 *   there, and the no-match line drops the desk's *Add one on the Skills
 *   page* and says only that nothing matched.
 *
 * The meter is sage, then `kind-data` past 80%, then brick over the limit.
 * Three existing tokens and no ember: ember means an agent is waiting on
 * somebody, and a full context window is not that.
 */
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Diamond, Search } from "lucide-react-native";
import {
  chooseSkills,
  getListSkillsQueryKey,
  getSessionSkillsQueryKey,
  setRepoDefaults,
} from "~/api/generated/skills/skills";
import type { Session, Skill } from "~/api/generated/model";
import { useSessionSkillIds, useSkills, why } from "~/data";
import { BUDGET, confirmLabel, fromDefaults, groupSkills, plan, sameSet, SMALLEST_BUDGET } from "~/skills";
import { GRABBER, Sheet, SKIRT } from "~/ui/Sheet";
import { Picker } from "~/ui/Picker";
import { Switch } from "~/ui/Switch";
import { Waiting } from "~/ui/Waiting";
import { useTheme } from "~/design/theme";

/** Above this, *All skills* is capped and the search box appears. */
const LONG = 8;
/** How many of a capped group are shown. The desk's numbers. */
const SHOWN = 6;

/**
 * How much of the screen the sheet may take, and the floor under its list.
 *
 * **The list carries the ceiling, not the sheet.** `Sheet`'s `maxHeight` is a
 * percentage, and React Native resolves one by clamping the sheet's own box —
 * it does not hand the clamp back to the children, so nothing inside shrinks.
 * A library of three hundred would therefore lay out three hundred rows and
 * push the switch and the footer past the bottom edge, which with a pinned
 * footer is not a cosmetic overflow: the one button that commits anything
 * would be below the screen. Bounding the scrolling part instead keeps every
 * fixed part on screen and gives the list whatever is left, which is what
 * "pinned" was supposed to mean.
 *
 * The floor is so that a very long head or a very short phone still leaves
 * something to scroll rather than a sliver.
 */
const CEILING = 86;
const LIST_FLOOR = 180;

export function SkillSheet({
  session,
  onClose,
}: {
  /**
   * The session, as the desk's `SkillPicker` takes it — narrowed to the two
   * fields this reads, the way `useDiff` narrows it in `data.ts`. The id is
   * what is being changed and the agent is what the meter is drawn against,
   * and the composer has only ever been handed those two.
   */
  session: Pick<Session, "id" | "agent">;
  onClose: () => void;
}) {
  const { color } = useTheme();
  const { height: screen } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const all = useSkills();
  const live = useSessionSkillIds(session.id);
  const cache = useQueryClient();

  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /* The defaults switch. `null` until touched, so it can show what is already
     true; `targets` is which of the session's repositories it applies to. */
  const [want, setWant] = useState<boolean | null>(null);
  const [targets, setTargets] = useState<Set<string> | null>(null);
  const [listing, setListing] = useState(false);
  /* Everything in the sheet that is not the list, measured rather than
     guessed: the eyebrow, the head and the search row above it, the switch
     and the footer below. **All of it, and the eyebrow is the one that is
     easy to forget** — leave a block out and the list is handed that much
     more room than there is. None of these depends on how tall the list is,
     so there is no loop here; see the composer's docblock for what one of
     those costs. */
  const [brow, setBrow] = useState(0);
  const [above, setAbove] = useState(0);
  const [below, setBelow] = useState(0);
  const measure = (set: (n: number) => void) => (e: LayoutChangeEvent) => set(e.nativeEvent.layout.height);
  const listMax = Math.max(
    LIST_FLOOR,
    (screen * CEILING) / 100 - GRABBER - SKIRT - insets.bottom - brow - above - below,
  );

  /* The draft starts as whatever the session is running, once that has
     arrived. Seeded in an effect rather than at first render, because the
     answer is a request and an empty set is indistinguishable from "none
     yet". */
  useEffect(() => {
    if (draft === null && !live.loading) setDraft(new Set(live.data));
  }, [draft, live.loading, live.data]);

  const picked = draft ?? new Set<string>();
  /* The floor, not Claude Code's 3,000: an agent this table does not know is
     one whose real limit we cannot name, and overstating it is what hides the
     cliff. See `BUDGET`. */
  const budget = BUDGET[session.agent] ?? SMALLEST_BUDGET;

  const defaultsHere = useMemo(
    () => new Set([...live.repos.flatMap((r) => r.defaults), ...live.alwaysOn]),
    [live.repos, live.alwaysOn],
  );

  const groups = useMemo(() => groupSkills(all.data, defaultsHere, query), [all.data, defaultsHere, query]);

  const repos = live.repos;
  const aimedAt = targets ?? new Set(repos.map((r) => r.repoId));
  const p = plan({ all: all.data, picked, live: live.data, budget, repos, aimedAt, want });

  const confirm = async () => {
    // Nothing to send is still an answer: the sheet closes as it would have.
    if (p.nothingToDo) return onClose();
    setSaving(true);
    setFailed(null);
    try {
      if (p.dirty) await chooseSkills(session.id, { selected: [...picked] });
      if (p.setsDefaults) for (const r of p.aimed) await setRepoDefaults(r.repoId, { skills: [...picked] });
      if (p.clearsDefaults)
        for (const r of p.aimed)
          await setRepoDefaults(r.repoId, { skills: r.defaults.filter((id) => !picked.has(id)) });
      await cache.invalidateQueries({ queryKey: getSessionSkillsQueryKey(session.id) });
      if (p.writesDefaults) await cache.invalidateQueries({ queryKey: getListSkillsQueryKey() });
      onClose();
    } catch (e) {
      /* It stays open with the reason in the status line and nothing lost. A
         sheet that closed on a failure would have thrown the selection away
         and said so somewhere nobody was looking. */
      setFailed(why(e));
      setSaving(false);
    }
  };

  const toggle = (id: string) =>
    setDraft((d) => {
      const next = new Set(d ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const status = failed ? (
    <Text numberOfLines={1} className="min-w-0 flex-1 font-sans text-micro text-brick">
      {failed}
    </Text>
  ) : p.clash ? (
    <Text numberOfLines={1} className="min-w-0 flex-1 font-sans text-micro text-brick">
      Two are called {p.clash}. Only one can be on.
    </Text>
  ) : p.over ? (
    <Text numberOfLines={1} className="min-w-0 flex-1 font-sans text-micro text-brick">
      Over the limit. Past it the agent drops every skill.
    </Text>
  ) : p.dirty ? (
    <Text numberOfLines={1} className="min-w-0 flex-1 font-sans text-micro text-bone">
      {[p.added ? `+${p.added}` : "", p.gone ? `−${p.gone}` : ""].filter(Boolean).join(" ")}
    </Text>
  ) : (
    <Text numberOfLines={1} className="min-w-0 flex-1 font-sans text-micro text-mute">
      {p.clearsDefaults
        ? "No longer the default once saved"
        : p.setsDefaults
          ? "The default once saved"
          : `${picked.size} on`}
    </Text>
  );

  /* The desk's chip carries "Which skills this agent is reading: your
     firetower defaults" on hover. A phone has no hover, so that sentence is
     the subtitle here — a tooltip given a home is this app's standing answer
     to a tooltip. */
  const from = fromDefaults(live.data, repos, live.alwaysOn);
  const repoWord = repos.length === 1 ? repos[0]!.slug.split("/").pop()! : `${aimedAt.size} repos`;
  /* An empty library is a *claim*, and a claim needs something to have come
     back. `Picker`'s own docblock makes this argument about its two props and
     the desk's window does not: "none yet" and "we could not ask" are
     different sentences, and saying the first while the second is true is the
     empty state that costs the most trust. */
  const empty = !all.loading && !all.error && all.data.length === 0;

  /* Sticky group heads want flat children at known indices, so the list is
     built as one array rather than nested per group. Same reason
     `BandLabel`'s docblock gives for where this would go on the dashboard. */
  const rows: React.ReactNode[] = [];
  const sticky: number[] = [];
  for (const g of groups) {
    const capped = g.at === "all" && !query && !showAll && g.rows.length > LONG;
    const shown = capped ? g.rows.slice(0, SHOWN) : g.rows;
    sticky.push(rows.length);
    rows.push(
      <View key={`head-${g.at}`} className="flex-row items-baseline gap-[7px] bg-float px-5 pb-[5px] pt-3">
        <Text className="font-sans text-micro text-dim">{g.title}</Text>
        <Text className="font-sans text-micro text-mute" style={{ fontVariant: ["tabular-nums"] }}>
          {g.rows.length}
        </Text>
      </View>,
    );
    shown.forEach((s, at) =>
      rows.push(
        /* The hairline separates rows from each other, so the first one under
           a head does not draw one — a rule immediately under a heading reads
           as the heading's underline rather than as a list. */
        <Row key={s.id} skill={s} on={picked.has(s.id)} first={at === 0} onToggle={() => toggle(s.id)} />,
      ),
    );
    if (capped) {
      rows.push(
        <Pressable
          key={`more-${g.at}`}
          testID="skills-show-all"
          onPress={() => setShowAll(true)}
          className="justify-center border-t border-line-soft px-5"
          style={{ minHeight: 56 }}
        >
          <Text className="font-sans text-meta text-mute">Show {g.rows.length - SHOWN} more</Text>
        </Pressable>,
      );
    }
  }

  return (
    <>
      {/* **Stood down while the repositories are being chosen.** Two `Modal`s
          presented at once is not a stack on iOS — the second never appears,
          which is what the simulator showed — and a sheet that swaps for
          another and comes back is the platform's own answer anyway. Nothing
          is lost: this component stays mounted, so the draft, the search and
          the switch are all exactly where they were. */}
      <Sheet open={!listing} onClose={onClose} maxHeight={`${CEILING}%`}>
        {/* Drawn in every state — loading, empty, failed and full — so it is
            measured on its own rather than folded into the head below. */}
        <View onLayout={measure(setBrow)}>
          <Text className="px-5 pb-2 pt-1 font-narrow text-micro uppercase tracking-[0.18em] text-mute">
            Skills
          </Text>
        </View>

        {all.loading ? (
          <View className="px-5 pb-7">
            <Waiting say="Reading your skills" align="left" />
          </View>
        ) : all.error ? (
          <View className="px-5 pb-8 pt-1">
            <Text className="font-sans text-ui text-bone">Your skills could not be read</Text>
            <Text className="mt-1 font-sans text-meta text-brick">{all.error}</Text>
          </View>
        ) : empty ? (
          /* Keeps the shape and the glyph and says where a skill comes from,
             because there is no Skills screen here to send anybody to. */
          <View className="items-center gap-2.5 px-7 pb-8 pt-2">
            <View className="h-11 w-11 items-center justify-center rounded-full border border-line bg-raise">
              <Diamond color={color.dim} size={18} />
            </View>
            <Text className="font-sans text-ui text-bone">Your library has no skills yet</Text>
            <Text className="max-w-[300px] text-center font-sans text-meta text-mute">
              Skills are imported from the desktop app or the web console. Come back here once there are
              some.
            </Text>
          </View>
        ) : (
          <>
            <View onLayout={measure(setAbove)}>
            <View className="px-5 pb-2.5 pt-0.5">
              <Text className="font-sans text-ui text-bone">Skills for this session</Text>
              <Text numberOfLines={1} className="mt-0.5 font-sans text-meta text-mute">
                {from ? `Your ${from}` : "Each one stays in the model's context on every turn"}
              </Text>
            </View>

            {all.data.length > LONG ? (
              <View
                className="flex-row items-center gap-2.5 border-b border-line-soft px-5"
                style={{ height: 44 }}
              >
                <Search color={color.mute} size={15} />
                <TextInput
                  testID="skills-search"
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search skills"
                  placeholderTextColor={color.mute}
                  accessibilityLabel="Search skills"
                  className="min-w-0 flex-1 font-sans text-ui text-bone"
                />
              </View>
            ) : null}
            </View>

            <ScrollView
              style={{ maxHeight: listMax }}
              stickyHeaderIndices={sticky}
              keyboardShouldPersistTaps="handled"
            >
              {groups.length === 0 ? (
                <Text className="px-5 py-8 text-center font-sans text-meta text-mute">
                  No skill matches “{query}”.
                </Text>
              ) : (
                rows
              )}
            </ScrollView>

            <View onLayout={measure(setBelow)}>
            {repos.length > 0 && picked.size > 0 ? (
              /* "Defaults are set here, because this is when somebody knows."
                 Choosing skills for a session on a repository is deciding what
                 that repository needs. The whole set, not additions —
                 otherwise unticking never carries over. */
              <View
                className="flex-row items-center gap-3 border-t border-line-soft px-5"
                style={{ flexShrink: 0, minHeight: 56 }}
              >
                <Switch
                  on={p.on}
                  onFlip={() => setWant(!p.on)}
                  label={`Use these by default in ${repoWord}`}
                />
                <Pressable
                  testID="skills-targets"
                  disabled={repos.length < 2}
                  onPress={() => setListing(true)}
                  className="min-w-0 flex-1 justify-center"
                  style={{ minHeight: 44 }}
                >
                  <Text numberOfLines={1} className="font-sans text-meta text-dim">
                    {p.already && want === null ? "Default in " : "Use these by default in "}
                    <Text className={repos.length === 1 ? "font-mono text-text" : "text-text"}>
                      {repoWord}
                    </Text>
                    {repos.length > 1 ? " ›" : ""}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            <View className="border-t border-line px-5 pt-3" style={{ flexShrink: 0 }}>
              <View className="h-[3px] overflow-hidden rounded-full bg-raise">
                <View
                  className={`h-full rounded-full ${
                    p.over ? "bg-brick" : p.spend > budget * 0.8 ? "bg-kind-data" : "bg-sage"
                  }`}
                  style={{ width: `${Math.min(100, (p.spend / budget) * 100)}%` }}
                />
              </View>
              <View className="mt-[7px] flex-row items-baseline gap-2.5">
                <Text
                  className="shrink-0 font-sans text-micro text-mute"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {p.spend.toLocaleString()} / {budget.toLocaleString()} tokens
                </Text>
                {status}
              </View>
              <Pressable
                testID="skills-confirm"
                disabled={p.blocked || saving}
                onPress={confirm}
                className={`mt-3 items-center justify-center rounded-field ${
                  p.blocked || saving ? "bg-overlay" : "bg-bone"
                }`}
                style={{ height: 52 }}
              >
                <Text
                  className={`font-semibold text-title ${p.blocked || saving ? "text-mute" : "text-ground"}`}
                >
                  {saving
                    ? "Saving…"
                    : confirmLabel({
                        clash: p.clash,
                        over: p.over,
                        dirty: p.dirty,
                        writesDefaults: p.writesDefaults,
                        count: picked.size,
                      })}
                </Text>
              </Pressable>
            </View>
            </View>
          </>
        )}
      </Sheet>

      {/* Which repositories the switch aims at. A second `Picker` rather than
          a disclosure inside the list, and it is the same shape as every other
          "choose from these" in the app. Multi-select, so it stays open. */}
      <Picker
        open={listing}
        title="Default in"
        choices={repos.map((r) => ({
          id: r.repoId,
          label: r.slug,
          detail: sameSet(r.defaults, picked) ? "already the default" : undefined,
        }))}
        chosen={[...aimedAt]}
        onPick={(id) =>
          setTargets(() => {
            const next = new Set(aimedAt);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        onClose={() => setListing(false)}
      />
    </>
  );
}

/**
 * One skill on one 56pt row.
 *
 * The name is mono — it is what the agent answers to, which makes it a
 * key rather than a title — and the second line is the description, or the
 * words *always on* where it came from everywhere.
 */
function Row({
  skill,
  on,
  first,
  onToggle,
}: {
  skill: Skill;
  on: boolean;
  /** The first row under a group head, which draws no rule above it. */
  first: boolean;
  onToggle: () => void;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={skill.name}
      testID={`skill-${skill.id}`}
      onPress={onToggle}
      className={`flex-row items-center gap-3 px-5 py-2 ${first ? "" : "border-t border-line-soft"}`}
      android_ripple={{ color: color.overlay }}
      style={{ minHeight: 56 }}
    >
      <View
        className={`h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm ${
          on ? "border border-bone bg-bone" : "border border-line"
        }`}
      >
        {on ? <Check color={color.ground} size={14} strokeWidth={3} /> : null}
      </View>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className={`font-mono text-ui ${on ? "text-bone" : "text-text"}`}>
          {skill.name}
        </Text>
        <Text numberOfLines={1} className="mt-0.5 font-sans text-meta text-mute">
          {skill.alwaysOn ? "always on" : skill.description}
        </Text>
      </View>
    </Pressable>
  );
}
