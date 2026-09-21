/**
 * What you could work on.
 *
 * One tracker at a time, because `/tasks` answers for one source per request
 * and the two page differently — GitHub by number with a total, Linear by
 * cursor with none. Merging them into one list would mean inventing a paging
 * scheme neither side has.
 *
 * The chips and the box are **sent, not applied here**. Every one of them is a
 * query parameter the source reads in its own dialect, so what comes back is
 * already the answer; filtering it again locally is how rows go missing.
 *
 * Tapping a task starts a workspace seeded from it — and seeds the *composer*,
 * unsent. No prompt is ever sent on creation; see `app/new.tsx`.
 */
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, CircleDot, GitPullRequest, Ticket, User } from "lucide-react-native";
import { getListTasksQueryKey } from "~/api/generated/tasks/tasks";
import type { ListTasksParams, TaskKind, TaskState, TrackerStatus } from "~/api/generated/model";
import { elapsed, minutesSince } from "~/api/view";
import { useTasks, useTrackers } from "~/data";
import { Segmented } from "~/ui/Segmented";
import { color, size } from "~/design/tokens.generated";

const KIND = { issue: CircleDot, pullRequest: GitPullRequest, ticket: Ticket };

/** What each kind is called on the toggle. A tracker only offers its own. */
const KIND_LABEL: Record<TaskKind, string> = {
  issue: "Issues",
  pullRequest: "PRs",
  ticket: "Tickets",
};

const STATES: [TaskState, string][] = [
  ["open", "Open"],
  ["closed", "Closed"],
];

export default function Tasks() {
  const insets = useSafeAreaInsets();
  const cache = useQueryClient();

  const { data: trackers, loading: findingTrackers } = useTrackers();
  const [picked, setPicked] = useState<string | null>(null);
  const [kind, setKind] = useState<TaskKind | null>(null);
  const [state, setState] = useState<TaskState>("open");
  const [mine, setMine] = useState(false);
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  /* The cursors spent getting here, one per page. Its length is the depth, so
     a source that pages by number reads the same state as one that pages by
     cursor and Previous is a pop either way. */
  const [trail, setTrail] = useState<string[]>([]);

  /* Derived rather than stored, so the first connected tracker is the answer
     from the first render — an effect would show GitHub's empty list for a
     frame to somebody who only has Linear. */
  const source: TrackerStatus | undefined =
    trackers.find((t) => t.id === picked) ?? trackers.find((t) => t.connected) ?? trackers[0];

  const kinds = source?.kinds ?? [];
  const showing = kind && kinds.includes(kind) ? kind : kinds[0];
  const connected = !!source?.connected;

  /* The box is not the request. It is sent once somebody stops typing, so a
     six-word query is one call rather than six. */
  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const ask: ListTasksParams = useMemo(() => {
    const at = trail.at(-1);
    return {
      source: source?.id,
      kind: showing,
      state,
      ...(mine ? { mine: true } : {}),
      ...(q ? { q } : {}),
      ...(at ? { cursor: at } : {}),
      ...(trail.length > 0 ? { page: trail.length + 1 } : {}),
    };
  }, [source?.id, showing, state, mine, q, trail]);

  const feed = useTasks(ask, connected && !!source);

  /* A different question is a different first page. Without this, narrowing
     while three pages deep asks for page four of a list that has one. */
  const question = `${source?.id}|${showing}|${state}|${mine}|${q}`;
  useEffect(() => setTrail([]), [question]);

  const count = feed.total ?? feed.data.length;

  return (
    <View className="flex-1 bg-ground" style={{ paddingTop: insets.top }}>
      <View className="px-4 pb-3 pt-2">
        <Text className="font-semibold text-display text-bone">Tasks</Text>
        <Text className="mt-0.5 font-sans text-ui text-dim">
          {connected ? `${count} to pick from. Starting one opens a workspace.` : "Read from your trackers."}
        </Text>
      </View>

      {/* Which tracker. A mark rather than a word on the desk, because two
          glyphs fit where "GitHub | Linear" pushes the filters onto a second
          row — and on 390pt that is more true, not less. */}
      {trackers.length > 1 ? (
        <View className="flex-row gap-2 px-4 pb-2">
          {trackers.map((t) => (
            <Pressable
              key={t.id}
              onPress={() => {
                setPicked(t.id);
                setKind(null);
              }}
              className={`rounded-md px-3 py-1.5 ${t.id === source?.id ? "bg-overlay" : "bg-raise"}`}
            >
              <Text className={`font-medium text-meta ${t.id === source?.id ? "text-bone" : "text-dim"}`}>
                {t.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {connected ? (
        <>
          {kinds.length > 1 ? (
            <View className="px-4 pb-2">
              <Segmented
                options={kinds.map((k) => [k, KIND_LABEL[k]] as [TaskKind, string])}
                value={showing as TaskKind}
                onChange={setKind}
              />
            </View>
          ) : null}

          <View className="flex-row items-center gap-2 px-4 pb-3">
            <View className="flex-1">
              <Segmented options={STATES} value={state} onChange={setState} />
            </View>
            <Pressable
              onPress={() => setMine((m) => !m)}
              style={{ height: 36 }}
              className={`flex-row items-center gap-1.5 rounded-lg px-3 ${mine ? "bg-overlay" : "bg-ground"}`}
            >
              <User color={mine ? color.bone : color.mute} size={13} />
              <Text className={`font-medium text-ui ${mine ? "text-bone" : "text-dim"}`}>Mine</Text>
            </Pressable>
          </View>

          <View className="px-4 pb-2">
            <TextInput
              value={typed}
              onChangeText={setTyped}
              placeholder="Search"
              placeholderTextColor={color.mute}
              selectionColor={color.ember}
              className="rounded-lg bg-raise px-3.5 py-2.5 font-sans text-bone"
              style={{ fontSize: size.ui }}
            />
          </View>
        </>
      ) : null}

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 24, flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={false}
            tintColor={color.mute}
            onRefresh={() => cache.invalidateQueries({ queryKey: getListTasksQueryKey(ask) })}
          />
        }
      >
        {findingTrackers ? (
          <View className="flex-1 items-center justify-center py-20">
            <ActivityIndicator color={color.mute} />
          </View>
        ) : !source ? (
          <Empty
            title="No trackers connected"
            detail="Connect GitHub or Linear on the desktop or the web console, and what you could work on shows up here."
          />
        ) : !connected ? (
          <Empty
            title={`${source.label} is not connected`}
            detail="It needs authorising before it can be read."
          />
        ) : feed.error ? (
          <Empty title="That didn't work" detail={feed.error} />
        ) : feed.loading && feed.data.length === 0 ? (
          <View className="flex-1 items-center justify-center py-20">
            <ActivityIndicator color={color.mute} />
          </View>
        ) : feed.data.length === 0 ? (
          <Empty title="Nothing here" detail={q ? `Nothing matches “${q}”.` : "No open work on this tracker."} />
        ) : (
          <>
            {feed.data.map((task) => {
              const Glyph = KIND[task.kind] ?? CircleDot;
              return (
                <Pressable
                  key={task.id}
                  onPress={() =>
                    router.push({
                      pathname: "/new",
                      params: { title: task.title, repo: task.repo ?? "", taskKey: task.key, taskUrl: task.url },
                    })
                  }
                  className="flex-row items-start gap-3 px-4 py-3.5"
                  android_ripple={{ color: color.overlay }}
                >
                  <View className="pt-0.5">
                    <Glyph color={task.state === "open" ? color.sage : color.mute} size={15} />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text numberOfLines={2} className="font-medium text-title text-bone">
                      {task.title}
                    </Text>
                    <View className="mt-1 flex-row items-center gap-2">
                      <Text className="font-mono text-meta text-mute">{task.key}</Text>
                      {task.repo ? (
                        <Text numberOfLines={1} className="min-w-0 shrink font-mono text-meta text-mute">
                          {task.repo}
                        </Text>
                      ) : null}
                      <Text className="font-sans text-meta text-mute">
                        {elapsed(minutesSince(task.updatedAt))}
                      </Text>
                    </View>
                  </View>
                </Pressable>
              );
            })}

            {/* Paging is a trail, not a number: a source that pages by cursor
                and one that pages by number read the same state here. */}
            {(trail.length > 0 || feed.more) && (
              <View className="flex-row justify-between px-4 py-4">
                <Pressable
                  disabled={trail.length === 0}
                  onPress={() => setTrail((t) => t.slice(0, -1))}
                  className={`flex-row items-center gap-1.5 rounded-lg px-3 py-2.5 ${trail.length ? "bg-raise" : ""}`}
                >
                  <ArrowLeft color={trail.length ? color.dim : color.mute} size={14} />
                  <Text className={`font-medium text-ui ${trail.length ? "text-text" : "text-mute"}`}>
                    Previous
                  </Text>
                </Pressable>
                <Pressable
                  disabled={!feed.more}
                  onPress={() => setTrail((t) => [...t, feed.next ?? ""])}
                  className={`flex-row items-center gap-1.5 rounded-lg px-3 py-2.5 ${feed.more ? "bg-raise" : ""}`}
                >
                  <Text className={`font-medium text-ui ${feed.more ? "text-text" : "text-mute"}`}>Next</Text>
                  <ArrowRight color={feed.more ? color.dim : color.mute} size={14} />
                </Pressable>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-2 px-8 py-16">
      <Text className="text-center font-medium text-title text-bone">{title}</Text>
      <Text className="text-center font-sans text-meta text-mute">{detail}</Text>
    </View>
  );
}
