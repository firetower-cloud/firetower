/**
 * The overview, on a screen that has no room to put it beside.
 *
 * The desk keeps this in a rail next to the conversation and so does the Duo
 * when it is open — see `app/workspace/[id].tsx`, which draws the same
 * component in a column when the display is wide enough. This route is what
 * the same thing becomes when it is not: pushed, full width, one back gesture
 * from where you were.
 *
 * It re-derives rather than receives. A pushed route cannot be handed React
 * state, and everything here comes from queries the conversation screen has
 * already warmed — the session list, the fold, the artifact list — so this
 * costs a render and not a round trip.
 */
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import type { Session } from "~/api/generated/model";
import { useListArtifacts } from "~/api/generated/artifacts/artifacts";
import { useConversation } from "~/api/conversation";
import { group, lead } from "~/api/workspaces";
import { useSession, useSessions } from "~/data";
import { Overview } from "~/ui/Overview";
import { Waiting } from "~/ui/Waiting";
import { useTheme } from "~/design/theme";

export default function OverviewScreen() {
  const { color } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { data: sessions, loading } = useSessions();

  const place = useMemo(() => {
    const { groups } = group(sessions.filter((s) => s.status !== "Ended"));
    return groups.flatMap(([, places]) => places).find((p) => p.id === id) ?? null;
  }, [sessions, id]);

  const speaker = place ? lead(place) : null;
  const { data: session } = useSession(speaker?.id ?? "");
  const { conversation } = useConversation(speaker?.id ?? "");
  const { data: everyArtifact } = useListArtifacts();

  const above = useMemo(
    () => (speaker?.parentId ? (sessions.find((s: Session) => s.id === speaker.parentId) ?? null) : null),
    [sessions, speaker?.parentId],
  );
  const managerId = above?.id ?? speaker?.id ?? "";
  const team = useMemo(
    () => sessions.filter((s: Session) => s.parentId === managerId),
    [sessions, managerId],
  );
  const family = useMemo(() => new Set([managerId, ...team.map((t) => t.id)]), [managerId, team]);
  const artifacts = useMemo(
    () => (everyArtifact ?? []).filter((a) => a.fromSessionId && family.has(a.fromSessionId)),
    [everyArtifact, family],
  );
  /* The plan is the manager's. `lead()` picks whichever run is *speaking*,
     which once a team exists is often a subagent — and a subagent keeps no
     plan, so reading it there emptied the panel exactly when there was a
     team to show one for. */
  const plan =
    conversation.plan.length > 0 ? conversation.plan : ((above ?? session)?.plan ?? []);

  return (
    <View
      className="flex-1 bg-ground"
      style={{ paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}
    >
      <View className="flex-row items-center gap-1 border-b border-line-soft pb-2 pl-1">
        <Pressable onPress={() => router.back()} className="h-10 w-10 items-center justify-center" hitSlop={8}>
          <ChevronLeft color={color.bone} size={22} />
        </Pressable>
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="font-medium text-title text-bone">
            {place?.name ?? "Overview"}
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        {!place ? (
          <View className="items-center justify-center py-20">
            {loading ? (
              <Waiting say="Finding this workspace" />
            ) : (
              <Text className="font-sans text-ui text-mute">That workspace is not here any more.</Text>
            )}
          </View>
        ) : session ? (
          <Overview
            session={session}
            lead={above}
            team={team}
            plan={plan}
            artifacts={artifacts}
            onOpenArtifact={(a) => router.push({ pathname: "/workspace/artifact", params: { id: a } })}
          />
        ) : (
          <View className="items-center justify-center py-20">
            <Waiting say="Reading the workspace" />
          </View>
        )}
      </ScrollView>
    </View>
  );
}
