/**
 * The strip, horizontally scrolling.
 *
 * The active tab is marked along its top edge, where an editor marks it, and a
 * tab's dot takes the file-kind colour the tree already uses. A previewing tab
 * is italic — the one visual difference that says "this will be replaced".
 */
import { useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { MessageSquare, X } from "lucide-react-native";
import { activeId, close, keep, select, snapshot, subscribe } from "~/workspace/tabs";
import { toneOf } from "~/ui/FileGlyph";
import { color } from "~/design/tokens.generated";

export function TabStrip({ onPick }: { onPick: (id: string) => void }) {
  const tabs = useSyncExternalStore(subscribe, snapshot, snapshot);
  const active = useSyncExternalStore(subscribe, activeId, activeId);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="border-b border-line-soft bg-panel"
      /* A horizontal ScrollView in a flex column has no intrinsic height and
         stretches to fill its parent — the strip came out 250pt tall. The
         height is the tab height, stated once. */
      style={{ flexGrow: 0, flexShrink: 0, height: 44 }}
      contentContainerStyle={{ alignItems: "center" }}
    >
      {tabs.map((tab) => {
        const on = tab.id === active;
        const file = "path" in tab ? tab : null;
        const name = file ? file.path.slice(file.path.lastIndexOf("/") + 1) : "Conversation";
        return (
          <Pressable
            key={tab.id}
            onPress={() => {
              select(tab.id);
              onPick(tab.id);
            }}
            onLongPress={() => keep(tab.id)}
            className="h-full flex-row items-center gap-2 border-r px-3"
            style={{ borderRightColor: color["line-soft"], borderTopWidth: 2, borderTopColor: on ? color.bone : "transparent" }}
          >
            {file ? (
              <View className="h-2 w-2 rounded-full" style={{ backgroundColor: toneOf(file.path) }} />
            ) : (
              <MessageSquare color={on ? color.bone : color.mute} size={12} />
            )}
            <Text
              numberOfLines={1}
              className={`font-sans text-meta ${on ? "text-bone" : "text-dim"}`}
              style={file?.preview ? { fontStyle: "italic" } : undefined}
            >
              {name}
            </Text>
            {file ? (
              <Pressable onPress={() => close(tab.id)} hitSlop={8}>
                <X color={color.mute} size={12} />
              </Pressable>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
