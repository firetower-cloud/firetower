/**
 * The home, which was the Inbox.
 *
 * The desk's four things, in the phone's order: a **greeting**, *agents
 * waiting for you*, *recent artifacts*, and the composer **pinned to the
 * foot**. The desk puts its box under the greeting because a cursor belongs
 * where the eye lands and a mouse reaches everywhere equally. A thumb does
 * not, so here the box goes where the thumb already rests and the two
 * sections take the room it leaves — which also lifts the only answer to
 * *what is waiting* out of the bottom third, where it used to sit 58% down.
 *
 * ## What this stopped doing, and why each one went
 *
 * - **The repository grouping.** It answered *what is this project doing*,
 *   which is a desk question. On a phone the question is *what wants me*, and
 *   grouping by repository buries the two rows that do against eleven that do
 *   not. Coverage §8 settles it: lose it.
 * - **The filter.** `All / Waiting / Working / Idle` is the dashboard's
 *   vocabulary and it was four controls to answer a question the order
 *   already answers. Ranked and labelled where the order turns, not filtered
 *   and not grouped — the docked column's list is `banded`, which is one
 *   order with a label in it and no sections. See `workspaces.tsx`.
 * - **The ember tint on a row.** Ember is the only loud thing on screen and it
 *   answers one question. A filled peach row spends it on a surface; the dot
 *   spends it on the mark, which is what it is for. The glyph stays.
 * - **The `+`.** The screen it opened is the screen you are already on.
 * - **Its own name as a heading.** A tab that says Dashboard above a page that
 *   says Inbox is the cheapest kind of incoherence; the greeting is better
 *   than either, because it is the only line on the screen that is about the
 *   person rather than about the software.
 *
 * ## The seven states
 *
 * All seven in coverage §3 are this one component with different data, which
 * is the point — `home` in the prototype is a parameter, not a screen. They
 * are: both sections, typing, nothing waiting, nothing at all, seeded from a
 * task, no repository, and not answering.
 */
import { Fragment, useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { BLEED, useEdges, useRail } from "~/ui/edges";
import Animated from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { router } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { getListSessionsQueryKey } from "~/api/generated/sessions/sessions";
import { useListArtifacts } from "~/api/generated/artifacts/artifacts";
import type { Session } from "~/api/generated/model";
import { banded, childrenElsewhere, fleetLine, group, lead, useSettled, useVanished, type Workspace } from "~/api/workspaces";
import { elapsed, minutesSince, needsYou } from "~/api/view";
import { useAgents, useRepos, useSessions } from "~/data";
import { useServer } from "~/native/current";
import { ServerChip } from "~/ui/ServerChip";
import { ArtifactCard } from "~/ui/ArtifactCard";
import { useAnswering } from "~/api/answering";
import { useEndWorkspace } from "~/ui/end";
import { BandLabel } from "~/ui/BandLabel";
import { Peek, usePeekable } from "~/ui/Peek";
import { Servers } from "~/ui/Servers";
import { Unreachable } from "~/ui/Unreachable";
import { WorkspaceRow } from "~/ui/WorkspaceRow";
import { StartBox, type Chip, type Pick_ } from "~/ui/StartBox";
import { Waiting } from "~/ui/Waiting";
import { COLUMN, dottedChips, posterColumns } from "~/ui/measure";
import { usePose } from "~/ui/pose";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

/**
 * Late night takes *Good evening* rather than a fourth greeting.
 *
 * A greeting is a salutation, not a clock. Three is what a person would say.
 */
function partOfDay(now = new Date()): "morning" | "afternoon" | "evening" {
  const h = now.getHours();
  return h < 5 ? "evening" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

const GREETING = {
  morning: "Good morning",
  afternoon: "Good afternoon",
  evening: "Good evening",
} as const;

/** One waiting agent, as a chip you can hold. */
function WaitingChip({
  place,
  onOpen,
  onPeek,
}: {
  place: Workspace;
  onOpen: () => void;
  onPeek: () => void;
}) {
  const speaker = lead(place);
  const { gesture, pressed } = usePeekable(onPeek, onOpen);

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        testID="waiting-chip"
        accessibilityRole="button"
        className="h-11 flex-row items-center gap-2.5 rounded-full bg-raise px-4"
        style={pressed}
      >
        {/* The ember dot, and it is the only saturated thing on the screen. */}
        <View className="h-2 w-2 rounded-full bg-ember" />
        <Text numberOfLines={1} className="max-w-[190px] font-sans text-bone" style={{ fontSize: size.body }}>
          {place.name}
        </Text>
        <Text className="font-sans text-meta text-mute">{elapsed(minutesSince(speaker.updatedAt))}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

function Heading({ text, all }: { text: string; all?: () => void }) {
  const { color } = useTheme();
  return (
    <View className="flex-row items-baseline gap-2.5 px-5 pb-2.5 pt-5">
      <Text className="font-medium text-dim" style={{ fontSize: size.meta }}>
        {text}
      </Text>
      {all ? (
        <>
          <View className="flex-1" />
          <Pressable onPress={all} hitSlop={8} className="flex-row items-center gap-0.5">
            <Text className="font-sans text-ui text-dim">View all</Text>
            <ChevronRight color={color.dim} size={14} />
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

export default function Home() {
  const { color } = useTheme();
  const edges = useEdges({ gutter: BLEED });
  const pose = usePose();
  const rail = useRail();
  const here = useServer();
  const cache = useQueryClient();

  const { data: sessions, loading, error } = useSessions();
  const { data: repos } = useRepos();
  const { data: agents } = useAgents();
  const { data: artifacts = [] } = useListArtifacts();

  const [draft, setDraft] = useState("");
  const [peeking, setPeeking] = useState<string | null>(null);
  const [servers, setServers] = useState(false);

  const live = sessions.filter((s: Session) => s.status !== "Ended");
  const { groups } = useMemo(
    () => group(live),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live.map((s: Session) => s.id + s.status).join()],
  );
  /* Flat and ranked, not grouped by repository. `group` is still what knows
     how to assemble a workspace out of its runs — that fold is shared with
     the other two clients — so this takes its output and throws the
     *repository* grouping away rather than re-deriving what a workspace is. */
  const places = useMemo(() => groups.flatMap(([, inRepo]) => inRepo), [groups]);
  /* The docked column's rows, which are the destination's rows — one call to
     `banded`, shared, so the preview and the place cannot come to disagree
     about the order or about which band a row reads under. A Duo rotating
     from 669 to 951 reveals a column; it must not reveal a list that reads
     differently.

     Still one continuous order with a label where the band turns, and still
     not sections — see `workspaces.tsx`, which carries that argument, and
     `banded`, which is handed the whole fleet because a family cannot be read
     out of a list its children have been taken out of. */
  const rows = useMemo(() => banded(places), [places]);
  /* **Off `places`, not off `rows`.** A chip in *Agents waiting for you* can
     be held too, and a blocked child has a chip and no row — so what is
     peekable here is every workspace and not only the ones with rows. */
  const peeked = places.find((p) => p.id === peeking) ?? null;
  const close = useCallback(() => setPeeking(null), []);
  /* A workspace that ends elsewhere takes its peek away by unmounting it, so
     nothing dismisses it and the id stays set. Let it go, or the hold below
     has nothing left to end it. */
  useVanished(peeking, peeked, close);
  /* And it holds its order while a row is held, for the same reason and in
     the same window: the peek a press becomes. **`peeked`, not `peeking`** —
     a hold on an id that no longer names anything never releases, and the
     list stays in last week's order with nothing on screen to dismiss. */
  const shown = useSettled(rows, peeked !== null);

  /* Blocked, not `needsYou`. The wider grouping also covers finished and
     broken, which belong on the list but are not the thing that is asking —
     and a chip is an invitation to answer.

     Still every workspace rather than the drawn rows: a chip is how a waiting
     agent is reached from the home, and a child with no row needs one more,
     not fewer. */
  const blocked = places.filter((p) => p.runs.some((r) => r.status === "NeedsYou"));
  const fits = dottedChips(pose.content);
  const dotted = blocked.slice(0, fits);
  const rest = blocked.length - dotted.length;

  const cols = posterColumns(pose.content, pose.docked);
  const posters = artifacts.slice(0, cols);

  const noRepo = repos.length === 0;

  /**
   * **The session id, not the workspace id.**
   *
   * `Workspace.id` is `session.workspaceId ?? session.id` — so for anything
   * that belongs to a workspace it is the *workspace's* id, and the routes
   * below want a *session's*. Passing `peeked.id` to the conversation meant
   * asking for one that does not exist, which is how the peek once drew an
   * ember dot over buttons that never arrived.
   *
   * `lead()` is what picks the run whose transcript a person means, and it is
   * what `[id].tsx` opens against. The peek has to agree with the screen it is
   * a preview of, or it opens a different session than the one it is showing.
   */
  const blockedRun = peeked?.runs.find((r) => r.status === "NeedsYou");
  /* **The blocked run, not the lead.** `lead()` answers "whose transcript do
     I open" and reports the *busy* run when a workspace has one running
     beside one that is stopped — so it is the wrong target for a question.
     The run that is asking is the run to read and the run to answer.

     This place's own, deliberately: it is what *What it changed* opens, and a
     parent's diff is the parent's. The family's questions are `useAnswering`,
     which is a different question with a different answer. */
  const speakerId = peeked ? (blockedRun?.id ?? lead(peeked).id) : null;
  const answering = useAnswering(peeked, places);

  /* The same teardown the workspace's own menu asks for, asked from the row —
     and the count beside the label is the number that goes with it. `places`
     is the whole list, children included, because only the whole list knows
     which ones are this one's. */
  const endWorkspace = useEndWorkspace();
  const endPeeked = useCallback(() => {
    if (!peeked) return;
    void endWorkspace(peeked, childrenElsewhere(peeked, places).length);
  }, [endWorkspace, peeked, places]);

  const refresh = useCallback(
    () => cache.invalidateQueries({ queryKey: getListSessionsQueryKey() }),
    [cache],
  );

  /* The decisions that are genuinely unmade. With no repository at all the
     chip is an invitation rather than a value — it is the only setting a
     phone owns, and it is two taps. */
  const chips: Chip[] = [
    noRepo
      ? { id: "repo", label: "Connect a repository", icon: "repo", want: true, onPress: () => router.push("/repos") }
      : { id: "repo", label: repos[0]?.slug ?? "Repository", icon: "repo", onPress: () => router.push("/config") },
    { id: "host", label: "Firetower’s machine", icon: "host", onPress: () => router.push("/new") },
  ];

  const header = (
    /* `z-index: 20` in the drawing, the same rung as the composer:
       both are chrome the content scrolls under, and both have to sit
       above it to do that.

       **`pt-0.5` stays, and it is 2 pt on top of the root's own air rather
       than instead of it.** It was the whole of the air above this chip on
       any surface that reserves nothing — the Duo's inner display sat the
       server chip 2 pt from the frame — and the fix for that is `TOP_AIR` in
       `edges.ts`, a floor on the root's resolved total, because fourteen
       screen roots go through that hook and only one of them is this one.
       Raising the 2 here instead would have fixed the home and left Tasks,
       Artifacts, You and Workspaces exactly as they were. */
    <View className="flex-row items-center px-2 pb-2 pt-0.5" style={[COLUMN, { zIndex: 20 }]}>
      <ServerChip
        org={here?.org ?? "—"}
        reach={error ? "unreachable" : "live"}
        onPress={() => setServers(true)}
      />
    </View>
  );

  /* **Not answering.** Said as its own screen rather than as an empty list —
     see `Unreachable`, which the Workspaces destination draws too. */
  if (error && live.length === 0) {
    return (
      <View
        className="flex-1 bg-ground"
        onLayout={pose.onLayout}
        style={edges}
      >
        {header}
        <Unreachable org={here?.org ?? "That server"} onRetry={refresh} />
        {servers ? <Servers onClose={() => setServers(false)} /> : null}
      </View>
    );
  }

  const bare = noRepo;
  const greeting = bare
    ? "Nothing to cut from yet."
    : `${GREETING[partOfDay()]}, what should we work on?`;

  /* The greeting scrolls. It is a salutation, read once on arrival, and
     pinning it would spend on a fixed line the space the sections want. At
     390 nothing scrolls in the resting state anyway, so the choice only bites
     once there is more to show — which is exactly when the sections are what
     you want on screen.

     44 of air above it, not the desk's 192. The same *proportion* of a 390pt
     phone would be 194pt of nothing on the scarce axis and the page would not
     then fit. */
  /* **The greeting stops holding it open** once there is nothing under it.
     The 44 of air is there to let the greeting breathe *above the sections*;
     with no sections it is 44pt of nothing on the scarce axis, holding a
     salutation away from the only other thing on screen. Two states collapse
     it — no repository at all, and a repository with nothing waiting and
     nothing made. */
  const nothing = dotted.length === 0 && posters.length === 0;
  const head = (
    <View
      className="px-5 pb-5"
      style={{
        minHeight: bare || nothing ? 0 : 44,
        paddingTop: bare || nothing ? 28 : 16,
        justifyContent: "flex-end",
      }}
    >
      <Text
        className="font-medium text-bone"
        style={{ fontSize: size.display, lineHeight: size.display * 1.16, letterSpacing: size.display * -0.024 }}
      >
        {greeting}
      </Text>
    </View>
  );

  const waiting =
    dotted.length > 0 ? (
      <View>
        <Heading text="Agents waiting for you" />
        {/* The chips scroll and **the count does not**. At 390 two chips do
            not fit side by side, and wrapping makes each one a full-width
            pill — a row wearing a chip's shape. Scrolling keeps the shape and
            costs no height, which is the scarce axis here. But *N more* is
            the mechanism that makes the ember budget legible, and at this
            width it scrolls off the end where it says nothing. So it is
            pinned outside the strip: the dotted chips scroll, the count
            stays. Two dots and one number, always both on screen. */}
        <View className="flex-row items-center gap-2 px-5 pb-0.5">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="min-w-0 flex-1"
            contentContainerStyle={{ gap: 8 }}
          >
            {dotted.map((p) => (
              <WaitingChip
                key={p.id}
                place={p}
                onOpen={() => router.push(`/workspace/${p.id}`)}
                onPeek={() => setPeeking(p.id)}
              />
            ))}
          </ScrollView>
          {rest > 0 ? (
            <Pressable
              testID="more-waiting"
              /* **`navigate`, not `push`.** Workspaces is a destination now,
                 and pushing one puts a second copy on the stack with a back
                 chevron the tab has no use for — the same screen arriving two
                 ways with two back behaviours, while the system tab bar
                 lights the wrong item. */
              onPress={() => router.navigate("/(tabs)/workspaces")}
              className="h-11 flex-row items-center rounded-full border border-line px-4"
              android_ripple={{ color: color.overlay }}
            >
              <Text className="font-sans text-dim" style={{ fontSize: size.body }}>
                {rest} more
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    ) : null;

  const made =
    posters.length > 0 ? (
      <View>
        <Heading text="Recent artifacts" all={() => router.push("/artifacts")} />
        <View className="flex-row gap-4 px-5">
          {posters.map((a) => (
            <View key={a.id} className="mt-4 min-w-0 flex-1">
              <ArtifactCard artifact={a} onOpen={() => router.push(`/workspace/artifact?id=${a.id}`)} />
            </View>
          ))}
        </View>
      </View>
    ) : null;

  /* **Nothing yet**, which is a different sentence from *nothing waiting*. A
     workspace is cut from a repository and this Firetower has none, so there
     is nothing to be waiting and nothing to have been made. */
  const under = bare ? (
    <Text
      className="px-5 pt-5 font-sans text-mute"
      style={{ fontSize: size.body, lineHeight: size.body * 1.6 }}
    >
      A workspace is cut from a repository, and this Firetower has none connected. Connecting one is
      two taps and it is the only setting a phone owns.
    </Text>
  ) : (
    <>
      {waiting}
      {made}
    </>
  );

  /* What will run, while it is still unsettled. The drawing puts these in the
     composer's control row rather than on the shelf: the shelf carries *where*
     the work happens — a repository and a machine — and these carry *what does
     it*. They open the form that collects them, same as the shelf chips. */
  const picks: Pick_[] = [
    { id: "agent", label: "Just an agent", onPress: () => router.push("/new") },
    { id: "model", label: agents[0]?.label ?? "Choose an agent", onPress: () => router.push("/new") },
  ];

  const box = (
    <StartBox
      value={draft}
      picks={picks}
      onChange={setDraft}
      /* The shelf cannot carry a task's key and URL, so starting still goes
         through the form — seeded with what has been typed. */
      onStart={() => router.push(`/new?title=${encodeURIComponent(draft.trim())}`)}
      chips={chips}
    />
  );

  const scroller = (
    <ScrollView
      className="flex-1"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ flexGrow: 1, ...COLUMN }}
      refreshControl={
        <RefreshControl refreshing={false} tintColor={color.mute} onRefresh={refresh} />
      }
    >
      {head}
      {loading && live.length === 0 ? (
        <View className="items-center justify-center py-20">
          <Waiting say="Reading your workspaces" />
        </View>
      ) : (
        under
      )}
      <View style={{ height: 16 }} />
    </ScrollView>
  );

  /**
   * At 951 landscape the home splits, and the measurement is why.
   *
   * It is the only pose with room for two things and the only one that is
   * *short* — 669 against the others' 844 to 951. The composer is pinned to
   * the foot of the left column, where a thumb is on a device held in two
   * hands, and the second column sits beside it rather than under it.
   *
   * The greeting **sinks to meet the box** rather than floating at the top of
   * a column with 280pt of nothing under it. It is a salutation *to the
   * composer*, so the two read as one thing; at every other pose the sections
   * fill that gap and the question does not arise.
   *
   * ## The right column is Workspaces, and that is a change
   *
   * It used to wrap `under` — the waiting chips and *Recent artifacts*, which
   * is what the single-column home puts *below* the greeting, moved sideways.
   * Below a greeting that is a section; in a 307pt column 669 tall it was two
   * posters and then roughly 1,200pt of floor.
   *
   * So it is the destination, previewed: head, count, and the one
   * status-ordered list with a label where the band turns, scrolling on its
   * own and filling the column however many there are. Which is exactly what
   * the desk does — the rail panel beside ⌘1 *is* this list, labels included.
   *
   * **The waiting chips fold into it rather than sitting above it.** The
   * order already puts what wants you first and every row already carries its
   * beat mark, so the top rows of the column, with their ember marks, *are*
   * the chips. A chip strip above a list whose first rows are the same
   * workspaces draws one object twice and spends the ember budget twice to say
   * one thing. That argument finishes with the bands: the labels are what the
   * chips' legend would have been, and *Waiting on you · 3* over those rows is
   * the strip's whole content in one line of furniture.
   *
   * **And the count line gives way to them, not the other way round.** At
   * 307pt the column has a head, a count line and three 12.5pt labels, and the
   * first label would have sat directly under a line saying nearly the same
   * thing — so the line drops its waiting clause while that label is drawn.
   * `fleetLine` carries the reason; it is not only the repetition, it is that
   * the two numbers disagree in both directions.
   *
   * **`Recent artifacts` moves to the head of the left column** rather than
   * being deleted. The alternative was to drop it here — Artifacts is its own
   * destination — and it loses on continuity: rotating from 669 to 951 would
   * make a whole section vanish, and rotating changes where a panel lands,
   * never what is on the screen. At 560 of left column its two posters are
   * 252pt each, against 167 on a 390pt phone.
   *
   * ## And the column runs to the frame
   *
   * `width: panel + rail, marginRight: -rail, paddingRight: rail` — the fill
   * and the divider reach the edge of the display while every row, press
   * highlight and timestamp stays inside the reserved 84. See `useRail`. The
   * left column is unaffected: it is still `content − panel` = 560, exactly
   * `READING_MAX`, and `pose.ts` still measures the frame.
   */
  if (pose.docked && !bare) {
    return (
      <View
        className="flex-1 bg-ground"
        onLayout={pose.onLayout}
        style={edges}
      >
        {header}
        <View className="min-h-0 flex-1 flex-row">
          <View className="min-w-0 flex-1 flex-col">
            <ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1, justifyContent: "flex-end" }}>
              {made}
              {/* The posters sit at the head and the greeting at the foot, so
                  the 280pt the greeting used to float above is what separates
                  them rather than nothing. */}
              <View className="flex-1" />
              {head}
            </ScrollView>
            {box}
          </View>
          {/* `ground`, not a fill of its own: one page colour, and space
              separates the two columns — STYLE.md's rule, no cards. The
              divider is what says where the column starts. */}
          <View
            className="min-h-0 border-l border-line-soft"
            style={{ width: pose.panel + rail, marginRight: -rail, paddingRight: rail }}
          >
            {/* Its own head rather than `Heading`: this is a panel's head and
                not one of the home's sections, and at 307pt the control says
                *All* where a full-width section says *View all*. */}
            <View className="flex-row items-baseline gap-2.5 px-5 pb-1 pt-3.5">
              <Text className="font-medium text-dim" style={{ fontSize: size.meta }}>
                Workspaces
              </Text>
              <View className="flex-1" />
              <Pressable
                testID="all-workspaces"
                onPress={() => router.navigate("/(tabs)/workspaces")}
                hitSlop={8}
                className="flex-row items-center gap-0.5"
              >
                <Text className="font-sans text-dim" style={{ fontSize: size.meta }}>
                  All
                </Text>
                <ChevronRight color={color.dim} size={13} />
              </Pressable>
            </View>
            {/* The count waits for an answer. *0 in all, none waiting* over a
                list that has not arrived is the same lie the destination was
                drawing before it had a loading state — it just costs less
                here, because the left column still has the composer on it. */}
            {loading && places.length === 0 ? (
              <View className="flex-1 items-center justify-center px-5">
                <Waiting say="Reading your workspaces" />
              </View>
            ) : (
              <>
                {/* `micro` and `mute` where the destination's is `meta` and
                    `dim`, which it already was — so it now sits one step
                    quieter than the labels under it. The head names the panel,
                    the labels organise the rows, this is a footnote about the
                    fleet. */}
                <View className="px-5 pb-1.5">
                  <Text className="font-sans text-mute" style={{ fontSize: size.micro }}>
                    {fleetLine(places, shown)}
                  </Text>
                </View>
                <ScrollView
                  className="min-h-0 flex-1"
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={{ paddingBottom: 20 }}
                >
                  {shown.map((row, at) => (
                    <Fragment key={row.place.id}>
                      {row.turn ? (
                        <BandLabel says={row.turn.says} count={row.turn.count} first={at === 0} />
                      ) : null}
                      <WorkspaceRow
                        place={row.place}
                        places={places}
                        onPeek={() => setPeeking(row.place.id)}
                      />
                    </Fragment>
                  ))}
                </ScrollView>
              </>
            )}
          </View>
        </View>
        {peeked ? (
          /* **The same peek the other two poses get, including the answer.**
             This branch was passing neither `pending` nor `onAnswer`, so
             holding a row at 951 previewed a blocked run and then offered no
             way to unblock it — coverage §5's P4 failing in exactly the pose
             that has the most room for it. Now that the column is the
             workspaces list the peek is the main thing it is held for. */
          <Peek
            place={peeked}
            places={places}
            onClose={close}
            onOpen={() => router.push(`/workspace/${peeked.id}`)}
            /* Where the children went: one tap from the list before, three
               after, so the peek pays it back. */
            onChildren={() => router.push(`/workspace/overview?id=${peeked.id}`)}
            /* `repo.tsx` reads its param with `useSession`, so this is the
               session id — unlike `/workspace/{id}`, which resolves a
               workspace. Two routes, two kinds of id, one field name. */
            onChanges={() => router.push(`/workspace/repo?id=${speakerId}`)}
            asks={answering.asks}
            waiting={answering.waiting}
            onAnswer={answering.onAnswer}
            onEnd={endPeeked}
          />
        ) : null}
        {servers ? <Servers onClose={() => setServers(false)} /> : null}
      </View>
    );
  }

  return (
    <View
      className="flex-1 bg-ground"
      onLayout={pose.onLayout}
      style={edges}
    >
      {header}
      {scroller}
      {box}

      {peeked ? (
        <Peek
          place={peeked}
          places={places}
          onClose={close}
          onOpen={() => router.push(`/workspace/${peeked.id}`)}
          /* Where the children went: one tap from the list before, three
             after, so the peek pays it back. */
          onChildren={() => router.push(`/workspace/overview?id=${peeked.id}`)}
          /* `repo.tsx` reads its param with `useSession`, so this is the
             session id — unlike `/workspace/{id}`, which resolves a workspace.
             Two routes, two kinds of id, one field name. */
          onChanges={() => router.push(`/workspace/repo?id=${speakerId}`)}
          asks={answering.asks}
          waiting={answering.waiting}
          onAnswer={answering.onAnswer}
          onEnd={endPeeked}
        />
      ) : null}
      {servers ? <Servers onClose={() => setServers(false)} /> : null}
    </View>
  );
}
