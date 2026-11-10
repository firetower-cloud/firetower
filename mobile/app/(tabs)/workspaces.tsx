/**
 * Workspaces: the second destination, which was a pushed route.
 *
 * It began as the screen **N more** opens — and before that the chip was
 * drawn, pinned and measured with no destination at all, which is the kind of
 * dead control a reachability check walks straight past: landing on the screen
 * you started from is a legal transition rather than a thrown error.
 *
 * ## Why it is a tab and not a push
 *
 * The desk already keeps this list and already calls it *Workspaces* —
 * `desktop/src/ui/RailPanel.tsx:265` draws `<Head name="Workspaces">`, the
 * 252pt panel beside ⌘1. So the phone is not naming a concept the desk lacks;
 * it is giving a *place* to a thing the desk keeps as a *panel*, because a
 * phone has no rail to hang one off and at 390, 466 and 669 there is no width
 * to dock one into either. That is the band rule, not a preference.
 *
 * **One route, not two.** This file was `app/workspaces.tsx` and was pushed
 * from the home's *N more* chip. A push onto a destination is the
 * two-back-behaviours bug: the same screen arrives once with a chevron and
 * once without, and the system tab bar lights the wrong item. The chip now
 * does `router.navigate`, and there is no alias left at the old path.
 *
 * ## A destination is somewhere you land, so four states stop being edge cases
 *
 * A pushed route is entered deliberately, from a control that only exists when
 * there is something to open. A tab is somewhere you arrive — cold, with no
 * server, with nothing running, or straight into it from a notification. This
 * screen had **none** of them: it drew *0 in all, none waiting* over an empty
 * page when the server was unreachable, which is the lie `STYLE.md` says costs
 * the most trust.
 *
 * - **Reading them.** `Waiting`, centred — the wait *is* the screen — and
 *   nothing at all for the first 350ms.
 * - **None at all.** Only once something has come back. An empty state is a
 *   claim, and it is only true after an answer.
 * - **Not answering.** The home's own panel, `Unreachable`, rather than a
 *   second wording of it.
 * - **Holding a row.** `Peek`, which already shipped here.
 *
 * ## Every row carries a mark, in its own tone
 *
 * Ember blocked, brick broken, slate working, sage done. A list where one row
 * of three has a mark reads as *missing* rather than as restraint — so the
 * mark is on all of them and the tone is what differs. `BEAT_TOKEN` is the
 * shared fold that decides which, so the phone cannot come to disagree with
 * the desk about what a status means.
 *
 * **Flat and status-ordered, never status-grouped.** Grouped is the one not to
 * ship: a workspace changes state while you are looking at it, and the row you
 * reached for jumps sections under your thumb. {@link RANK} is the order, and
 * it is the same order the home's docked column draws.
 */
import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { BLEED, useEdges } from "~/ui/edges";
import Animated from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "~/api/generated/model";
import { group, lead, type Workspace } from "~/api/workspaces";
import { BEAT, BEAT_TOKEN, elapsed, minutesSince, type Beat } from "~/api/view";
import { useSessions } from "~/data";
import { useServer } from "~/native/current";
import { usePending } from "~/api/pending";
import { getListSessionsQueryKey, useAnswerRequest } from "~/api/generated/sessions/sessions";
import { Peek, usePeekable } from "~/ui/Peek";
import { Unreachable } from "~/ui/Unreachable";
import { Waiting } from "~/ui/Waiting";
import { COLUMN } from "~/ui/measure";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

/**
 * The order a list of them reads in. Not sections — an order.
 *
 * `Record<Beat, …>` rather than `Record<string, …>`, so adding a beat is a
 * build error here instead of a silent `undefined` in the comparator that
 * sorts the new one to an arbitrary place.
 */
const RANK: Record<Beat, number> = { blocked: 0, broken: 1, working: 2, done: 3, over: 4 };

function Row({ place, onPeek }: { place: Workspace; onPeek: () => void }) {
  const { color } = useTheme();
  const speaker = lead(place);
  const beat = BEAT[speaker.status];
  const token = BEAT_TOKEN[beat];
  const tone = token === "mute" ? color.dim : token === "ember" ? color["ember-ink"] : color[token];
  const soft = beat === "done" || beat === "over";
  const { gesture, pressed } = usePeekable(onPeek, () => router.push(`/workspace/${place.id}`));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        testID="workspace-row"
        accessibilityRole="button"
        className="min-h-[54px] flex-row items-center gap-3 px-5"
        style={pressed}
      >
        <View className="h-2 w-2 rounded-full" style={{ backgroundColor: tone }} />
        <Text
          numberOfLines={1}
          className={`min-w-0 flex-1 font-sans ${soft ? "text-dim" : "text-bone"}`}
          style={{ fontSize: size.title, letterSpacing: size.title * -0.012 }}
        >
          {place.name}
        </Text>
        <Text className="font-sans text-meta text-mute">{elapsed(minutesSince(speaker.updatedAt))}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

export default function Workspaces() {
  const edges = useEdges({ gutter: BLEED });
  const here = useServer();
  const cache = useQueryClient();
  const { data: sessions, loading, error } = useSessions();
  const [peeking, setPeeking] = useState<string | null>(null);

  const live = sessions.filter((s: Session) => s.status !== "Ended");
  const { groups } = useMemo(
    () => group(live),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live.map((s: Session) => s.id + s.status).join()],
  );
  const places = useMemo(
    () =>
      groups
        .flatMap(([, inRepo]) => inRepo)
        .slice()
        .sort((a, b) => RANK[BEAT[lead(a).status]] - RANK[BEAT[lead(b).status]]),
    [groups],
  );

  const waiting = places.filter((p) => p.runs.some((r) => r.status === "NeedsYou")).length;
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

  /**
   * The title takes the destination's size, and there is no chevron.
   *
   * A destination has nowhere to go back to, and a back control on one is the
   * same defect `artifacts.tsx` still has. Without the chevron there is no
   * 44pt target to optically align against either, so the title sits on the
   * gutter the rows below it sit on — `px-5`, which is what `STYLE.md` means
   * by the gutter being one number.
   */
  const head = (
    <View className="px-5 pb-1 pt-0.5" style={COLUMN}>
      <Text
        className="font-medium text-bone"
        style={{
          fontSize: size.display,
          lineHeight: size.display * 1.16,
          letterSpacing: size.display * -0.024,
        }}
      >
        Workspaces
      </Text>
    </View>
  );

  /* **Not answering outranks everything below it.** A list that empties
     itself reads as work being lost, so the panel replaces the content
     rather than sitting above an honest-looking zero. `live.length` is not
     consulted the way the home consults it: the home has a composer worth
     keeping on screen under a stale list, and this screen is the list. */
  if (error && places.length === 0) {
    return (
      <View className="flex-1 bg-ground" style={edges}>
        {head}
        <Unreachable org={here?.org ?? "That server"} onRetry={refresh} />
      </View>
    );
  }

  /* **The wait is the screen**, so it centres rather than sitting under the
     count. The count is a claim about data that has not arrived. */
  if (loading && places.length === 0) {
    return (
      <View className="flex-1 bg-ground" style={edges}>
        {head}
        <View className="flex-1 items-center justify-center px-9">
          <Waiting say="Reading your workspaces" />
        </View>
      </View>
    );
  }

  /* **None at all**, and only once something has come back — an empty state
     is a claim, and above it the two states that are not it have already
     returned. The sentence says where a workspace comes from, because the
     answer to "nothing is running" is an action and not an apology. */
  if (places.length === 0) {
    return (
      <View className="flex-1 bg-ground" style={edges}>
        {head}
        <View className="flex-1 items-center justify-center gap-2.5 px-9">
          <Text
            className="text-center font-medium text-bone"
            style={{ fontSize: size.title, lineHeight: size.title * 1.3 }}
          >
            Nothing is running.
          </Text>
          <Text
            className="max-w-[34ch] text-center font-sans text-mute"
            style={{ fontSize: size.read, lineHeight: size.read * 1.6 }}
          >
            A workspace is cut from a repository. Start one from the Dashboard, or pick a task.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View
      className="flex-1 bg-ground"
      style={edges}
    >
      {head}

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ ...COLUMN, paddingBottom: 30 }}>
        <View className="px-5 pb-2 pt-1.5">
          <Text className="font-medium text-dim" style={{ fontSize: size.meta }}>
            {waiting
              ? `${waiting} waiting on you · ${places.length} in all`
              : `${places.length} in all, none waiting`}
          </Text>
        </View>

        {places.map((p) => (
          <Row key={p.id} place={p} onPeek={() => setPeeking(p.id)} />
        ))}
      </ScrollView>

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
    </View>
  );
}
