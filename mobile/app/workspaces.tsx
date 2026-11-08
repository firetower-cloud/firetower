/**
 * Workspaces: the screen **N more** opens, and it did not exist.
 *
 * The chip was drawn, pinned and measured, and its destination was the screen
 * you are already on. A dead control — and the kind a reachability check walks
 * straight past, because landing on the screen you started from is a legal
 * transition rather than a thrown error. *Reachable* was checking that a press
 * goes somewhere, not that it goes somewhere else.
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
 * reached for jumps sections under your thumb.
 */
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { router } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import type { Session } from "~/api/generated/model";
import { group, lead, type Workspace } from "~/api/workspaces";
import { BEAT, BEAT_TOKEN, elapsed, minutesSince, type Beat } from "~/api/view";
import { useSessions } from "~/data";
import { usePending } from "~/api/pending";
import { useAnswerRequest } from "~/api/generated/sessions/sessions";
import { Peek, usePeekable } from "~/ui/Peek";
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
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const { data: sessions, loading } = useSessions();
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

  return (
    <View
      className="flex-1 bg-ground"
      style={{ paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}
    >
      <View className="flex-row items-center gap-0.5 pb-1 pl-1" style={COLUMN}>
        <Pressable
          onPress={() => router.back()}
          accessibilityLabel="Back"
          className="h-11 w-11 items-center justify-center"
          hitSlop={8}
        >
          <ChevronLeft color={color.text} size={23} />
        </Pressable>
        <Text className="flex-1 font-medium text-title text-bone">Workspaces</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ ...COLUMN, paddingBottom: 30 }}>
        <View className="px-5 pb-2 pt-1.5">
          <Text className="font-medium text-dim" style={{ fontSize: size.meta }}>
            {waiting
              ? `${waiting} waiting on you · ${places.length} in all`
              : `${places.length} in all, none waiting`}
          </Text>
        </View>

        {loading && places.length === 0 ? (
          <View className="items-center py-20">
            <Waiting say="Reading your workspaces" />
          </View>
        ) : (
          places.map((p) => <Row key={p.id} place={p} onPeek={() => setPeeking(p.id)} />)
        )}
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
