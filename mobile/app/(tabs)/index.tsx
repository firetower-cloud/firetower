/**
 * The inbox: every workspace on the current server.
 *
 * One screen doing what the desk splits between the rail and the dashboard,
 * because a phone has room for one. `group()` and `doing()` decide what it
 * says — shared with the other two clients rather than re-derived, so three
 * screens cannot come to disagree about what a workspace is up to.
 *
 * The list is fed by the socket, not by a poll: `BackendProvider` folds every
 * `sessions` event into this query's cache as it arrives.
 */
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Plus } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { getListSessionsQueryKey } from "~/api/generated/sessions/sessions";
import { doing, group, shortRepo } from "~/api/workspaces";
import { needsYou } from "~/api/view";
import { useSessions } from "~/data";
import { useServer } from "~/native/current";
import { Segmented } from "~/ui/Segmented";
import { ServerChip } from "~/ui/ServerChip";
import { WorkspaceRow } from "~/ui/WorkspaceRow";
import { color } from "~/design/tokens.generated";

type Filter = "all" | "waiting" | "working" | "idle";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["waiting", "Waiting"],
  ["working", "Working"],
  ["idle", "Idle"],
];

export default function Inbox() {
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<Filter>("all");
  const here = useServer();
  const cache = useQueryClient();
  const { data: sessions, loading, error } = useSessions();

  const live = sessions.filter((s) => s.status !== "Ended");
  const { groups } = useMemo(() => group(live), [live.map((s) => s.id + s.status).join()]);
  const waiting = live.filter(needsYou).length;

  const shown = groups
    .map(([repo, places]) => [repo, places.filter((p) => filter === "all" || doing(p) === filter)] as const)
    .filter(([, places]) => places.length > 0);

  return (
    <View className="flex-1 bg-ground" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center justify-between px-4 pb-3 pt-2">
        <ServerChip org={here?.org ?? "—"} reach={error ? "unreachable" : "live"} onPress={() => router.push("/you")} />
        <Pressable
          onPress={() => router.push("/new")}
          className="h-9 w-9 items-center justify-center rounded-md bg-raise"
          hitSlop={6}
          android_ripple={{ color: color.overlay, borderless: true }}
        >
          <Plus color={color.bone} size={18} />
        </Pressable>
      </View>

      <View className="px-4 pb-3">
        <Text className="font-semibold text-display text-bone">Inbox</Text>
        {waiting > 0 ? (
          <Text className="mt-0.5 font-medium text-ui text-ember">{waiting} waiting on you</Text>
        ) : (
          <Text className="mt-0.5 font-sans text-ui text-dim">Nothing is waiting on you</Text>
        )}
      </View>

      <View className="px-4 pb-2">
        <Segmented options={FILTERS} value={filter} onChange={setFilter} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 24, paddingHorizontal: 8, flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={false}
            tintColor={color.mute}
            colors={[color.dim]}
            progressBackgroundColor={color.raise}
            onRefresh={() => cache.invalidateQueries({ queryKey: getListSessionsQueryKey() })}
          />
        }
      >
        {shown.map(([repo, places]) => (
          <View key={repo} className="mb-1 mt-3">
            {/* `.eyebrow` is the map-legend voice: column headers and section
                legends, and nothing else on this screen. */}
            <Text className="mb-1 px-3 font-narrow text-micro uppercase tracking-[0.18em] text-mute">
              {shortRepo(repo)}
            </Text>
            {places.map((place) => (
              <WorkspaceRow
                key={place.id}
                place={place}
                onPress={() => router.push(`/workspace/${place.id}`)}
              />
            ))}
          </View>
        ))}

        {/* Three absences, said apart. Reading "nothing is running" when the
            server is unreachable is the lie that costs the most trust. */}
        {loading && live.length === 0 ? (
          <View className="flex-1 items-center justify-center py-20">
            <ActivityIndicator color={color.mute} />
          </View>
        ) : error ? (
          <View className="items-center gap-2 px-8 py-16">
            <Text className="text-center font-medium text-title text-bone">
              {here?.org ?? "That server"} is not answering
            </Text>
            <Text className="text-center font-sans text-meta text-mute">{error}</Text>
          </View>
        ) : shown.length === 0 ? (
          <View className="items-center gap-2 px-8 py-16">
            <Text className="text-center font-sans text-ui text-dim">
              {live.length === 0
                ? "No workspaces yet."
                : `Nothing here is ${filter === "all" ? "running" : filter}.`}
            </Text>
            {live.length === 0 ? (
              <Pressable onPress={() => router.push("/new")} className="mt-2 rounded-lg bg-raise px-4 py-2.5">
                <Text className="font-medium text-ui text-bone">Start one</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
