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
import { GestureDetector } from "react-native-gesture-handler";
import { router } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import type { Session } from "~/api/generated/model";
import { group, lead, type Workspace } from "~/api/workspaces";
import { BEAT, BEAT_TOKEN, elapsed, minutesSince } from "~/api/view";
import { useSessions } from "~/data";
import { Peek, usePeekGesture } from "~/ui/Peek";
import { Waiting } from "~/ui/Waiting";
import { COLUMN } from "~/ui/measure";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

/** The order a list of them reads in. Not sections — an order. */
const RANK: Record<string, number> = { blocked: 0, broken: 1, working: 2, done: 3, over: 4 };

function Row({ place, onPeek }: { place: Workspace; onPeek: () => void }) {
  const { color } = useTheme();
  const speaker = lead(place);
  const beat = BEAT[speaker.status];
  const token = BEAT_TOKEN[beat];
  const tone = token === "mute" ? color.dim : token === "ember" ? color["ember-ink"] : color[token];
  const soft = beat === "done" || beat === "over";
  const hold = usePeekGesture(onPeek);

  return (
    <GestureDetector gesture={hold}>
      <Pressable
        testID="workspace-row"
        onPress={() => router.push(`/workspace/${place.id}`)}
        className="min-h-[54px] flex-row items-center gap-3 px-5 active:bg-raise"
        android_ripple={{ color: color.raise }}
      >
        <View className="h-2 w-2 rounded-full" style={{ backgroundColor: tone }} />
        <Text
          numberOfLines={1}
          className={`min-w-0 flex-1 font-sans ${soft ? "text-dim" : "text-bone"}`}
          style={{ fontSize: 19, letterSpacing: -0.23 }}
        >
          {place.name}
        </Text>
        <Text className="font-sans text-meta text-mute">{elapsed(minutesSince(speaker.updatedAt))}</Text>
      </Pressable>
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
          <Text className="font-medium text-dim" style={{ fontSize: 14.5 }}>
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
          onChanges={() => router.push(`/workspace/repo?id=${peeked.id}`)}
          onEnd={() => setPeeking(null)}
        />
      ) : null}
    </View>
  );
}
