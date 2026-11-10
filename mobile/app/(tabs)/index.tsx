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
 *   already answers. Ranked, not grouped and not filtered.
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
import { useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { BLEED, useEdges } from "~/ui/edges";
import Animated from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { router } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { getListSessionsQueryKey } from "~/api/generated/sessions/sessions";
import { useListArtifacts } from "~/api/generated/artifacts/artifacts";
import type { Session } from "~/api/generated/model";
import { group, lead, type Workspace } from "~/api/workspaces";
import { elapsed, minutesSince, needsYou } from "~/api/view";
import { useAgents, useRepos, useSessions } from "~/data";
import { useServer } from "~/native/current";
import { ServerChip } from "~/ui/ServerChip";
import { ArtifactCard } from "~/ui/ArtifactCard";
import { usePending } from "~/api/pending";
import { useAnswerRequest } from "~/api/generated/sessions/sessions";
import { Peek, usePeekable } from "~/ui/Peek";
import { Servers } from "~/ui/Servers";
import { Unreachable } from "~/ui/Unreachable";
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
  /* Flat and ranked, not grouped. `group` is still what knows how to assemble
     a workspace out of its runs — that fold is shared with the other two
     clients — so this takes its output and throws the grouping away rather
     than re-deriving what a workspace is. */
  const places = useMemo(() => groups.flatMap(([, inRepo]) => inRepo), [groups]);

  /* Blocked, not `needsYou`. The wider grouping also covers finished and
     broken, which belong on the list but are not the thing that is asking —
     and a chip is an invitation to answer. */
  const blocked = places.filter((p) => p.runs.some((r) => r.status === "NeedsYou"));

  const fits = dottedChips(pose.content);
  const dotted = blocked.slice(0, fits);
  const rest = blocked.length - dotted.length;

  const cols = posterColumns(pose.content, pose.docked);
  const posters = artifacts.slice(0, cols);

  const noRepo = repos.length === 0;
  const peeked = places.find((p) => p.id === peeking) ?? null;

  /**
   * What the peeked workspace is blocked on, read without opening it.
   *
   * One bounded request on long-press and nothing ongoing — see
   * `api/pending.ts`. Without it the peek can preview but not answer, which
   * is coverage §5's **P4** and the whole reason the component exists.
   */
  /**
   * **The session id, not the workspace id.**
   *
   * `Workspace.id` is `session.workspaceId ?? session.id` — so for anything
   * that belongs to a workspace it is the *workspace's* id, and
   * `getConversation` wants a *session's*. Passing `peeked.id` meant the fetch
   * asked for a conversation that does not exist, `pending` never resolved,
   * and the Allow/No buttons never rendered — while the ember dot showed,
   * because `blocked` is read off the runs and was right all along.
   *
   * `lead()` is what picks the run whose transcript a person means, and it is
   * what `[id].tsx` opens and answers against. The peek has to agree with the
   * screen it is a preview of, or it answers a different session than the one
   * it is showing.
   */
  const blockedRun = peeked?.runs.find((r) => r.status === "NeedsYou");
  /* **The blocked run, not the lead.** `lead()` answers "whose transcript do
     I open" and reports the *busy* run when a workspace has one running
     beside one that is stopped — so it is the wrong target for a question.
     The run that is asking is the run to read and the run to answer. */
  const speakerId = peeked ? (blockedRun?.id ?? lead(peeked).id) : null;
  const pending = usePending(speakerId, !!blockedRun);
  const answer = useAnswerRequest();

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
            <View key={a.id} className="min-w-0 flex-1">
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
   * hands, and the sections sit beside it rather than under it.
   *
   * The greeting **sinks to meet the box** rather than floating at the top of
   * a column with 280pt of nothing under it. It is a salutation *to the
   * composer*, so the two read as one thing; at every other pose the sections
   * fill that gap and the question does not arise.
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
              {head}
            </ScrollView>
            {box}
          </View>
          <View className="border-l border-line-soft" style={{ width: pose.panel }}>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 8 }}>
              {under}
              <View style={{ height: 20 }} />
            </ScrollView>
          </View>
        </View>
        {peeked ? (
          <Peek
            place={peeked}
            onClose={() => setPeeking(null)}
            onOpen={() => router.push(`/workspace/${peeked.id}`)}
            /* `repo.tsx` reads its param with `useSession`, so this is the
             session id — unlike `/workspace/{id}`, which resolves a workspace.
             Two routes, two kinds of id, one field name. */
          onChanges={() => router.push(`/workspace/repo?id=${speakerId}`)}
            onEnd={() => setPeeking(null)}
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
          onClose={() => setPeeking(null)}
          onOpen={() => router.push(`/workspace/${peeked.id}`)}
          /* `repo.tsx` reads its param with `useSession`, so this is the
             session id — unlike `/workspace/{id}`, which resolves a workspace.
             Two routes, two kinds of id, one field name. */
          onChanges={() => router.push(`/workspace/repo?id=${speakerId}`)}
          pending={pending.asked}
          reading={pending.reading}
          onAnswer={(yes) => {
            if (!pending.asked || !speakerId) return;
            answer.mutate({
              id: speakerId,
              data: {
                req: pending.asked.req,
                decision: yes ? { decision: "Allow" } : { decision: "Deny", reason: null },
              },
            });
          }}
          onEnd={() => setPeeking(null)}
        />
      ) : null}
      {servers ? <Servers onClose={() => setServers(false)} /> : null}
    </View>
  );
}
