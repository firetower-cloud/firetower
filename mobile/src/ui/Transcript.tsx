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
 *
 * And one rule of its own, because the desk has no rail to fit it to: **an
 * artifact's card goes where it was published**, which inline makes it the
 * fifth thing a turn can have hanging off that hairline. See `Poster`, and
 * `place` for which of three positions each card gets.
 */
import { Fragment, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { ChevronDown, ChevronRight, FileDiff, FileText, Search, Terminal, Users } from "lucide-react-native";
import type { Item, Task } from "~/api/conversation";
import type { Artifact } from "~/api/generated/model";
import { delegated, fold, mainline, place, type Row } from "~/api/steps";
import { ArtifactCard } from "~/ui/ArtifactCard";
import { Code, Prose } from "~/ui/Prose";
import { useTheme } from "~/design/theme";

const GLYPH = {
  CommandExecution: Terminal,
  FileRead: FileText,
  FileChange: FileDiff,
  WebSearch: Search,
} as const;

/** A verb and an argument. What a tool call is, in one line. */
function Tool({ item }: { item: Item }) {
  const { color } = useTheme();
  const Icon = GLYPH[item.kind as keyof typeof GLYPH] ?? Terminal;
  const pictures = item.images ?? [];
  return (
    <View className="py-1">
      <View className="flex-row items-center gap-2">
        <Icon color={color.mute} size={12} />
        <Text numberOfLines={1} className="flex-1 font-mono text-meta text-dim">
          {item.title}
        </Text>
      </View>
      {/* What the step handed back, when it handed back a picture. Shown
          whole rather than cropped — a screenshot is captured to be read,
          and a square of the middle of one says nothing. */}
      {pictures.length > 0 ? (
        <View className="mt-1.5 gap-1.5">
          {pictures.map((picture, i) => (
            <Image
              key={i}
              source={{ uri: `data:${picture.mediaType};base64,${picture.data}` }}
              resizeMode="contain"
              className="w-full rounded-md border border-line"
              style={{ height: 200 }}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Everything hangs off one hairline, so the work reads as attached to the turn. */
function Rail({ children }: { children: React.ReactNode }) {
  const { color } = useTheme();
  return (
    <View className="my-1 border-l pl-3" style={{ borderColor: color["line-soft"] }}>
      {children}
    </View>
  );
}

function Group({ items }: { items: Item[] }) {
  const { color } = useTheme();
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
  const { color } = useTheme();
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
      <View className="max-w-[86%] rounded-said bg-raise px-3.5 py-2.5">
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

/**
 * Work handed to a subagent: its own rail, one level in.
 *
 * The phone used to draw the spawning call as a dead one-line step and then
 * interleave the subagent's own tool calls into the main rail, where they read
 * as though the agent you are talking to had made them — the exact thing the
 * `task` tag exists to prevent. Everything it did is in here now, with what it
 * came back with.
 */
function Delegated({ item, items, tasks }: { item: Item; items: Item[]; tasks: Task[] }) {
  const { color } = useTheme();
  const [open, setOpen] = useState(false);
  const task = tasks.find((t) => t.item === item.id);
  const mine = task ? delegated(items, task.id) : [];
  const input = item.input as Record<string, unknown> | undefined;
  const description =
    task?.description ??
    (typeof input?.description === "string" ? input.description : undefined) ??
    "a subagent";
  const failed = task?.status === "Failed" || item.status === "Failed";
  const running = !task?.status && !item.status;

  return (
    <Rail>
      <Pressable onPress={() => setOpen((o) => !o)} className="py-1.5" hitSlop={6}>
        <View className="flex-row items-center gap-2">
          <Users color={failed ? color.brick : color.mute} size={12} />
          <Text className="font-sans text-meta text-mute">sent</Text>
          <Text
            numberOfLines={1}
            className={`flex-1 font-mono text-meta ${failed ? "text-brick" : "text-dim"}`}
          >
            {description}
          </Text>
          {open ? <ChevronDown color={color.mute} size={12} /> : <ChevronRight color={color.mute} size={12} />}
        </View>
        {/* What it is doing now, while it is still doing it. The card is shut
            by default, so this line is the only sign of life it has. */}
        {running && task?.progress ? (
          <Text numberOfLines={1} className="mt-0.5 pl-5 font-sans text-meta text-mute">
            {task.progress}
          </Text>
        ) : null}
      </Pressable>
      {open ? (
        <View className="pb-1 pl-1">
          {mine.length > 0 ? (
            fold(mine).map((row) => (
              <Line key={row.type === "group" ? row.id : row.item.id} row={row} />
            ))
          ) : null}
          {task?.summary ? (
            <View className="mt-1.5 border-l pl-2.5" style={{ borderColor: color["line-soft"] }}>
              <Prose text={task.summary} />
            </View>
          ) : null}
          {mine.length === 0 && !task?.summary ? (
            <Text className="font-sans text-meta text-mute">Nothing back yet.</Text>
          ) : null}
        </View>
      ) : null}
    </Rail>
  );
}

function Line({ row, items, tasks }: { row: Row; items?: Item[]; tasks?: Task[] }) {
  if (row.type === "group") return <Group items={row.items} />;
  const item = row.item;
  switch (item.kind) {
    case "SubagentCall":
      return <Delegated item={item} items={items ?? []} tasks={tasks ?? []} />;
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

/**
 * The rhythm each of the three positions asks for.
 *
 * `ArtifactCard` carries no vertical margin of its own — the library's grid
 * sets its own gaps and these three set theirs, which is the only way one
 * component fits both. Inline it is 12pt each side, which with the 4pt a rail
 * row carries is 16pt clear: more than the 8pt between steps, less than the
 * gap between turns, so the card belongs to the work above it instead of
 * detaching from it.
 *
 * Only `before` has no top margin of its own: the line above it carries that,
 * and the line is drawn once however many cards are up there.
 */
const ROOM = {
  inline: "my-3 border-l pl-3",
  before: "mb-5",
  end: "mt-4",
} as const;

/**
 * An artifact's card, in whichever of the three places `place` sent it.
 *
 * **Inline, it hangs off the hairline rail**, like the rest of what a turn
 * did. This is where the phone parts company with the desk deliberately: the
 * desk draws tool work at the gutter, so it has no rail for a card to cut.
 * Drawn plain at this width the poster runs out to both edges, crosses the
 * hairline that the edit above and the folded run below both hang from, and
 * the group under it reads as attached to the card rather than to the turn.
 * On the rail it takes the same 12pt indent as everything else that turn did —
 * and it cannot be read as the agent's own illustration, because the agent's
 * prose and the screenshots it pastes both start at the gutter.
 *
 * **416pt wide at most**, which is the desk's own `max-w-[26rem]`. Nothing
 * changes at phone width; it stops a poster being 316pt tall — a third of the
 * screen, for one card — on the Duo's inner display at 951.
 */
function Poster({
  artifact,
  where,
  onOpen,
}: {
  artifact: Artifact;
  where: keyof typeof ROOM;
  onOpen: (id: string) => void;
}) {
  const { color } = useTheme();
  return (
    <View
      className={ROOM[where]}
      style={where === "inline" ? { borderColor: color["line-soft"] } : undefined}
    >
      <View className="max-w-[416px]">
        <ArtifactCard artifact={artifact} onOpen={() => onOpen(artifact.id)} />
      </View>
    </View>
  );
}

/**
 * A fragment rather than a `View`, and that is load-bearing.
 *
 * The transcript now grows at the top as well as the bottom, and the scroller
 * above it keeps somebody's place through that with
 * `maintainVisibleContentPosition` — which pins the first *direct subview* of
 * the scroll content. Wrapped in a `View`, every row was one subview's
 * children rather than subviews, so prepending moved everything inside a box
 * whose own origin never changed: nothing to pin to, and the reader was thrown
 * down the page by a page they had asked for. Flattened, each row is its own
 * subview and the pinning has something to hold.
 *
 * The `Fragment` around each row is the same bargain kept: it pairs a row with
 * whatever card was published at it without putting a box around either, so
 * both stay subviews of the scroller. A card moving from above the transcript
 * to inline — which is what paging history in does to it — is then one layout
 * pass, and the row somebody is reading stays pinned through it.
 */
export function Transcript({
  items,
  tasks = [],
  artifacts,
  onOpenArtifact,
}: {
  items: Item[];
  tasks?: Task[];
  /**
   * The artifacts this session published — not its family's.
   *
   * Required rather than defaulted, and the caller narrows the set: a
   * subagent's `firstSeenLine` is a position in a different log, and a
   * transcript handed the whole family would anchor it somewhere arbitrary
   * and confident. See the filter in `app/workspace/[id].tsx`.
   */
  artifacts: Artifact[];
  onOpenArtifact: (id: string) => void;
}) {
  /* The main rail only: a subagent's work belongs to the card that owns it,
     and drawing it here as well put the same command on the screen twice. */
  const rows = fold(mainline(items));
  const placed = place(rows, artifacts);

  return (
    <>
      {/* Published before anything on screen, so above the transcript rather
          than below it: the window is the last few exchanges, and an artifact
          older than all of them is not the newest thing that happened.

          With one line to say so. Above the oldest message and under the
          request for earlier history, a poster with no word on it reads as
          pinned — or as the newest thing at the top of a reversed list. Said
          once rather than per card, and only for this position: once a card
          moves inline the position says it. Its own subview rather than a box
          around the run, so the cards stay subviews too — see above. */}
      {placed.before.length > 0 ? (
        <Text className="mb-2 mt-4 font-sans text-meta text-mute">
          Published before the messages below.
        </Text>
      ) : null}
      {placed.before.map((artifact) => (
        <Poster key={artifact.id} artifact={artifact} where="before" onOpen={onOpenArtifact} />
      ))}

      {rows.map((row, i) => (
        <Fragment key={row.type === "group" ? row.id : row.item.id}>
          <Line row={row} items={items} tasks={tasks} />
          {(placed.at.get(i) ?? []).map((artifact) => (
            <Poster key={artifact.id} artifact={artifact} where="inline" onOpen={onOpenArtifact} />
          ))}
        </Fragment>
      ))}

      {/* The ones with nowhere to go: no line on the row, or no transcript to
          anchor against. The second of those is why this component is drawn
          even when `items` is empty — an artifact outlives the workspace that
          made it, so a session whose conversation has gone, or has not
          arrived, still has its cards to show. */}
      {placed.loose.map((artifact) => (
        <Poster key={artifact.id} artifact={artifact} where="end" onOpen={onOpenArtifact} />
      ))}
    </>
  );
}
