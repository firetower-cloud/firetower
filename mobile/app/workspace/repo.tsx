/**
 * What the agent did to the repository — the whole screen.
 *
 * The desk puts this in a rail beside the conversation, on the argument that
 * reviewing a diff must not hide the conversation explaining it. That argument
 * does not survive the trip to a phone, and the first attempt here proved it:
 * as a sheet over the chat it left three lines of conversation visible, which
 * is not context, and it squeezed the diff into a third of the screen while
 * pushing the one control that ships the work below the fold.
 *
 * So it is a page. A phone has no *beside*; what it has is a stack and a back
 * gesture, and a diff wants every pixel of a 390pt screen.
 */
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { useDiff, useSession } from "~/data";
import { Diff } from "~/ui/Diff";
import { Files } from "~/ui/Files";
import { Segmented } from "~/ui/Segmented";
import { Ship } from "~/ui/Ship";
import { Waiting } from "~/ui/Waiting";
import { color } from "~/design/tokens.generated";

type TabId = "diff" | "files" | "ship";
const TABS: [TabId, string][] = [
  ["diff", "Diff"],
  ["files", "Files"],
  ["ship", "Commit"],
];

export default function Repo() {
  const insets = useSafeAreaInsets();
  const { id, tab: want } = useLocalSearchParams<{ id: string; tab?: TabId }>();
  const [tab, setTab] = useState<TabId>(want ?? "diff");

  const { data: session } = useSession(id ?? null);
  const { data: files, loading } = useDiff(session);

  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  /* Workspace-relative, which is what the tree is keyed on. */
  const touched = useMemo(() => new Set(files.map((f) => f.at)), [files]);

  const open = (path: string) =>
    router.push({ pathname: "/workspace/file", params: { id: id ?? "", path } });

  if (!session) {
    return (
      <View className="flex-1 items-center justify-center bg-ground">
        <Waiting say="Opening the workspace" />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-ground" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-1 pb-2 pl-1">
        <Pressable
          onPress={() => router.back()}
          className="h-10 w-10 items-center justify-center"
          hitSlop={8}
        >
          <ChevronLeft color={color.bone} size={22} />
        </Pressable>
        <View className="min-w-0 flex-1 pr-3">
          <Text numberOfLines={1} className="font-medium text-title text-bone">
            {session.name}
          </Text>
          <View className="mt-0.5 flex-row items-center gap-2">
            <Text className="font-sans text-meta text-dim">
              {files.length} {files.length === 1 ? "file" : "files"}
            </Text>
            {added ? <Text className="font-mono text-meta text-sage">+{added}</Text> : null}
            {removed ? <Text className="font-mono text-meta text-brick">−{removed}</Text> : null}
          </View>
        </View>
      </View>

      <View className="px-3 pb-2">
        <Segmented options={TABS} value={tab} onChange={setTab} />
      </View>

      {tab === "ship" ? (
        <Ship session={session} files={files.length} bottom={insets.bottom} />
      ) : tab === "files" ? (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
          <Files sessionId={session.id} touched={touched} onOpen={open} />
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32, flexGrow: 1 }}>
          {loading && files.length === 0 ? (
            <View className="flex-1 items-center justify-center py-20">
              <Waiting say="Reading the changes" />
            </View>
          ) : files.length === 0 ? (
            <View className="items-center px-8 py-20">
              <Text className="text-center font-sans text-ui text-mute">
                Nothing has changed yet.
              </Text>
            </View>
          ) : (
            <Diff files={files} onOpen={open} />
          )}
        </ScrollView>
      )}
    </View>
  );
}
