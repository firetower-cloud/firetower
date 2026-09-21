/**
 * One file, with the strip above it.
 *
 * Wanting the file under discussion is the commonest thing anybody does here,
 * so there are several ways in: the tree, the diff's own control, and — once
 * the transcript is wired for it — a `read` in the conversation.
 */
import { useEffect, useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { useFileText } from "~/api/text";
import { useDiff, useSession } from "~/data";
import { addedLines } from "~/api/patch";
import { TabStrip } from "~/ui/TabStrip";
import { open as openTab } from "~/workspace/tabs";
import { color } from "~/design/tokens.generated";

const ROW = 19;

export default function FileScreen() {
  const { id, path } = useLocalSearchParams<{ id: string; path: string }>();
  const insets = useSafeAreaInsets();

  const { data: session } = useSession(id ?? null);
  const { data: changed } = useDiff(session);
  const file = useFileText(id ?? "", path ?? "");

  useEffect(() => {
    if (path) openTab(path);
  }, [path]);

  const lines = useMemo(() => {
    const held = file.data;
    if (held?.kind !== "text") return [];
    return held.text.replace(/\n$/, "").split("\n");
  }, [file.data]);

  /**
   * Which of these lines this session wrote.
   *
   * `addedLines` numbers lines in the file as it now stands, which is the same
   * numbering this view uses — so unlike a reconstruction from the patch, the
   * gutter and the count agree by construction.
   */
  const touched = useMemo(() => {
    const mine = changed.find((c) => c.at === path || c.path === path);
    return mine ? addedLines(mine.patch) : new Set<number>();
  }, [changed, path]);

  return (
    <View className="flex-1 bg-ground" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-1 pb-1 pl-1">
        <Pressable onPress={() => router.back()} className="h-10 w-10 items-center justify-center" hitSlop={8}>
          <ChevronLeft color={color.bone} size={22} />
        </Pressable>
        <Text numberOfLines={1} className="flex-1 pr-3 font-mono text-meta text-dim">
          {path}
        </Text>
      </View>

      <TabStrip onPick={(t) => t === "chat" && router.back()} />

      {/* The count is clamped to the file: a header reading "33 lines, 40
          touched" is the kind of small lie that makes a reader stop trusting
          the rest of the screen. */}
      <View className="flex-row items-center gap-3 border-b border-line-soft px-4 py-2">
        <Text className="font-sans text-meta text-mute">{lines.length} lines</Text>
        {touched.size ? (
          <Text className="font-sans text-meta text-sage">
            {[...touched].filter((n) => n <= lines.length).length} touched
          </Text>
        ) : null}
      </View>

      {file.isPending ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={color.mute} />
        </View>
      ) : file.error ? (
        <View className="items-center px-8 py-16">
          <Text className="text-center font-sans text-ui text-mute">{file.error.message}</Text>
        </View>
      ) : file.data && file.data.kind !== "text" ? (
        /* A tab is for reading, and a repository always contains something
           that is not. Said, rather than drawn badly. */
        <View className="items-center px-8 py-16">
          <Text className="text-center font-sans text-ui text-mute">
            {file.data.kind === "image"
              ? "A picture — the viewer for these is still to come."
              : file.data.kind === "huge"
                ? `Too big to read here (${Math.round(file.data.bytes / 1024)} KB).`
                : "A binary file — nothing to draw."}
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
          <View className="flex-row">
            <View className="border-r border-line-soft">
              {lines.map((_, i) => (
                <View
                  key={i}
                  style={{ height: ROW, justifyContent: "center" }}
                  className={touched.has(i + 1) ? "bg-sage-tint" : ""}
                >
                  <Text
                    className="px-2 text-right font-mono"
                    style={{ fontSize: 10, color: touched.has(i + 1) ? color.sage : color.mute }}
                  >
                    {i + 1}
                  </Text>
                </View>
              ))}
            </View>

            {/* Code scrolls; it never wraps. */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1">
              <View>
                {lines.map((line, i) => (
                  <View
                    key={i}
                    style={{ height: ROW, justifyContent: "center", minWidth: 340 }}
                    className={touched.has(i + 1) ? "bg-sage-tint" : ""}
                  >
                    <Text numberOfLines={1} className="px-2 font-mono text-text" style={{ fontSize: 11.5 }}>
                      {line || " "}
                    </Text>
                  </View>
                ))}
              </View>
            </ScrollView>
          </View>
        </ScrollView>
      )}
    </View>
  );
}
