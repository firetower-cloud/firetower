/**
 * The conversation.
 *
 * Four rules taken from the desk rather than re-derived, because they are what
 * makes a long turn readable:
 *
 * - **The agent speaks onto the ground.** No container, no avatar, no bubble —
 *   its turn is long and it is the thing you came to read. **You** get a raised
 *   card. Two facing bubbles is a messaging app; this is not one.
 * - **Tool calls hang off a hairline** to the left, so a turn that touched
 *   fourteen files still reads as one paragraph with work attached.
 * - **Runs of scaffolding fold**, and an edit never does.
 * - **Thinking is collapsed** to a single line. It is context, not the answer.
 */
import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { ChevronDown, ChevronRight, FileDiff, FileText, Search, Terminal } from "lucide-react-native";
import type { Item } from "~/api/conversation";
import { fold, type Row } from "~/api/steps";
import { Code, Prose } from "~/ui/Prose";
import { color } from "~/design/tokens.generated";

const GLYPH = {
  CommandExecution: Terminal,
  FileRead: FileText,
  FileChange: FileDiff,
  WebSearch: Search,
} as const;

/** A verb and an argument. What a tool call is, in one line. */
function Tool({ item }: { item: Item }) {
  const Icon = GLYPH[item.kind as keyof typeof GLYPH] ?? Terminal;
  return (
    <View className="flex-row items-center gap-2 py-1">
      <Icon color={color.mute} size={12} />
      <Text numberOfLines={1} className="flex-1 font-mono text-meta text-dim">
        {item.title}
      </Text>
    </View>
  );
}

/** Everything hangs off one hairline, so the work reads as attached to the turn. */
function Rail({ children }: { children: React.ReactNode }) {
  return (
    <View className="my-1 border-l pl-3" style={{ borderColor: color["line-soft"] }}>
      {children}
    </View>
  );
}

function Group({ items }: { items: Item[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Rail>
      <Pressable onPress={() => setOpen((o) => !o)} className="flex-row items-center gap-2 py-1.5" hitSlop={6}>
        {open ? <ChevronDown color={color.mute} size={12} /> : <ChevronRight color={color.mute} size={12} />}
        <Text className="font-sans text-meta text-mute">{items.length} steps</Text>
      </Pressable>
      {open ? <View className="pb-1">{items.map((i) => <Tool key={i.id} item={i} />)}</View> : null}
    </Rail>
  );
}

function Thought({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen((o) => !o)} className="py-1.5">
      {open ? (
        <Text className="font-sans text-meta italic leading-[20px] text-mute">{item.text}</Text>
      ) : (
        <Text numberOfLines={1} className="font-sans text-meta italic text-mute">
          Thought for a moment
        </Text>
      )}
    </Pressable>
  );
}

function Edit({ item }: { item: Item }) {
  return (
    <Rail>
      <View className="flex-row items-center gap-2 py-1">
        <FileDiff color={color["kind-source"]} size={12} />
        <Text numberOfLines={1} className="flex-1 font-mono text-meta text-text">
          {item.title}
        </Text>
      </View>
      {item.output ? (
        <View className="mt-1">
          <Code text={item.output} tint />
        </View>
      ) : null}
    </Rail>
  );
}

function Said({ item }: { item: Item }) {
  const pictures = item.images ?? [];
  /* A raised card, and it does not run the full width — a message that fills
     the column reads as the agent's, which is the one thing this has to avoid. */
  return (
    <View className="my-2 items-end">
      <View className="max-w-[86%] rounded-lg bg-raise px-3.5 py-2.5">
        {/* The fold has carried these since the beginning and nothing drew
            them: a screenshot sent from this app appeared on the desk and
            nowhere in the app that sent it. `base64` straight into `Image`,
            which is where they already are — there is no URL to fetch. */}
        {pictures.length > 0 ? (
          /* One picture gets the width and is shown whole — a screenshot is
             sent to be read, and cropping it to a square is the one thing
             that makes it useless. Several share the row as thumbnails,
             where the point is which ones rather than what is in them. */
          <View className={`flex-row flex-wrap gap-1.5 ${item.text ? "mb-2" : ""}`}>
            {pictures.map((picture, i) => (
              <Image
                key={i}
                source={{ uri: `data:${picture.mediaType};base64,${picture.data}` }}
                resizeMode={pictures.length === 1 ? "contain" : "cover"}
                className="rounded-md border border-line"
                style={pictures.length === 1 ? { width: "100%", height: 240 } : { width: 132, height: 132 }}
              />
            ))}
          </View>
        ) : null}
        {item.text ? <Text className="font-sans text-read text-bone">{item.text}</Text> : null}
      </View>
    </View>
  );
}

function Line({ row }: { row: Row }) {
  if (row.type === "group") return <Group items={row.items} />;
  const item = row.item;
  switch (item.kind) {
    case "UserMessage":
      return <Said item={item} />;
    case "AssistantMessage":
      return (
        <View className="my-2">
          <Prose text={item.text} />
        </View>
      );
    case "Reasoning":
      return <Thought item={item} />;
    case "FileChange":
      return <Edit item={item} />;
    default:
      return (
        <Rail>
          <Tool item={item} />
        </Rail>
      );
  }
}

export function Transcript({ items }: { items: Item[] }) {
  return (
    <View>
      {fold(items).map((row) => (
        <Line key={row.type === "group" ? row.id : row.item.id} row={row} />
      ))}
    </View>
  );
}
