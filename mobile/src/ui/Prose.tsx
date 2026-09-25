/**
 * What the agent wrote, drawn.
 *
 * A walk over the mdast `remark-parse` and `remark-gfm` produce, which is the
 * same tree the desk and the web render — so a nested list, a fenced block or
 * a table means the same thing on all three clients rather than whatever each
 * one's own parser happened to do.
 *
 * What was here before handled four constructs and printed the rest as typed.
 * A heading arrived as `## Heading`, a link kept its brackets, and a table was
 * a wall of pipes — on the client where the screen is smallest and a wall of
 * pipes is least readable.
 *
 * Two rules worth keeping in mind while reading this:
 *
 * - **Anything with a picture in it becomes a column.** An `Image` inside a
 *   `Text` is laid out as a glyph on the line, which is not what a screenshot
 *   is.
 * - **Tables scroll rather than wrap.** A phone is narrower than any table
 *   worth drawing, and a wrapped cell stops being a row you can read across.
 */
import { useState } from "react";
import { Clipboard, Image, Linking, Pressable, ScrollView, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { Check, Copy } from "lucide-react-native";
import { highlight, langNamed, TONE } from "~/api/syntax";
import { color } from "~/design/tokens.generated";
import { isWorkspaceSrc, WorkspaceImage } from "~/ui/WorkspaceImage";
import { columns, flatten, parse, type PhrasingContent, type RootContent } from "~/ui/markdown";

/** A heading's size. `display` is for a page; this is somebody talking. */
const HEADING = ["text-title", "text-title", "text-body", "text-read", "text-read", "text-read"];

/**
 * A run of inline nodes, as things that can sit inside one `Text`.
 *
 * Images are not among them — a paragraph carrying one is split by `Blocks`
 * before it gets here, so anything reaching this point is text-shaped.
 */
function inline(nodes: PhrasingContent[], key: string): React.ReactNode[] {
  return nodes.map((node, i) => {
    const at = `${key}-${i}`;
    switch (node.type) {
      case "text":
        return node.value;
      case "strong":
        return (
          <Text key={at} className="font-semibold text-bone">
            {inline(node.children, at)}
          </Text>
        );
      case "emphasis":
        return (
          <Text key={at} className="italic">
            {inline(node.children, at)}
          </Text>
        );
      case "delete":
        return (
          <Text key={at} className="text-mute line-through">
            {inline(node.children, at)}
          </Text>
        );
      case "inlineCode":
        return (
          <Text key={at} className="font-mono text-code text-kind-source">
            {node.value}
          </Text>
        );
      case "link":
        /* `onPress` on the `Text` itself rather than a `Pressable` around it:
           a link is usually mid-sentence, and a pressable wrapping part of a
           line breaks the line where it starts. */
        return (
          <Text
            key={at}
            className="text-kind-source underline"
            onPress={() => void Linking.openURL(node.url).catch(() => {})}
          >
            {inline(node.children, at)}
          </Text>
        );
      case "break":
        return "\n";
      case "image":
        // Only reachable for an image the splitter left behind — its alt text
        // is the honest thing to show.
        return node.alt ?? "";
      default:
        return flatten([node]);
    }
  });
}

/** Whether this run has a picture in it, and so has to be laid out as a column. */
const pictorial = (nodes: PhrasingContent[]) => nodes.some((n) => n.type === "image");

/** A picture, from wherever it is. */
function Picture({ src, alt }: { src: string; alt?: string }) {
  if (isWorkspaceSrc(src)) return <WorkspaceImage src={src} alt={alt} />;
  return (
    <Image
      source={{ uri: src }}
      resizeMode="contain"
      className="my-2 w-full rounded-md border border-line"
      style={{ aspectRatio: 16 / 10 }}
    />
  );
}

/**
 * A paragraph with pictures in it: the pictures, and the text between them.
 *
 * The runs either side keep their formatting, which is why this splits the
 * node list rather than the source text.
 */
function Mixed({ nodes, at }: { nodes: PhrasingContent[]; at: string }) {
  const out: React.ReactNode[] = [];
  let run: PhrasingContent[] = [];
  const flush = (key: string) => {
    if (run.length === 0) return;
    if (flatten(run).trim()) {
      out.push(
        <Text key={key} className="font-sans text-read text-text">
          {inline(run, key)}
        </Text>,
      );
    }
    run = [];
  };
  nodes.forEach((node, i) => {
    if (node.type === "image") {
      flush(`${at}-t${i}`);
      out.push(<Picture key={`${at}-i${i}`} src={node.url} alt={node.alt ?? undefined} />);
    } else {
      run.push(node);
    }
  });
  flush(`${at}-end`);
  return <View className="gap-1">{out}</View>;
}

/**
 * How wide one character of the table's font is.
 *
 * `text-code` is 15px and the face is JetBrains Mono, whose advance is 0.6em
 * — so 9px, with a little over for the medium weight the header row is set
 * in. Estimated rather than measured because measuring text means a round
 * trip to the UI thread per cell, and the cost of being slightly generous
 * here is a few pixels of padding on a table that already scrolls.
 */
const CHAR = 9.4;

/** The padding either side of a cell, which `px-2` puts there. */
const CELL_PAD = 16;

/** A table, as one grid that scrolls sideways. */
function Table({ rows, at }: { rows: string[][]; at: string }) {
  const width = columns(rows);
  const [head, ...body] = rows;
  if (!head) return null;

  const Row = ({ cells, header }: { cells: string[]; header?: boolean }) => (
    <View className="flex-row">
      {width.map((w, i) => (
        <Text
          key={i}
          numberOfLines={1}
          className={`px-2 py-1 font-mono text-code ${header ? "font-mono-medium text-bone" : "text-text"}`}
          style={{ width: Math.ceil(w * CHAR) + CELL_PAD }}
        >
          {cells[i] ?? ""}
        </Text>
      ))}
    </View>
  );

  return (
    <View className="overflow-hidden rounded-md border border-line">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View className="border-b" style={{ borderColor: color.line }}>
            <Row cells={head} header />
          </View>
          {body.map((cells, i) => (
            <View
              key={`${at}-r${i}`}
              className={i > 0 ? "border-t" : undefined}
              style={i > 0 ? { borderColor: color["line-soft"] } : undefined}
            >
              <Row cells={cells} />
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

/** One block, whatever kind it is. */
function Block({ node, at }: { node: RootContent; at: string }): React.ReactElement | null {
  switch (node.type) {
    case "heading":
      return (
        <Text className={`font-sans font-semibold text-bone ${HEADING[node.depth - 1]}`}>
          {inline(node.children, at)}
        </Text>
      );

    case "paragraph":
      return pictorial(node.children) ? (
        <Mixed nodes={node.children} at={at} />
      ) : (
        <Text className="font-sans text-read text-text">{inline(node.children, at)}</Text>
      );

    case "code":
      return <Code text={node.value} fence={node.lang ?? undefined} />;

    case "blockquote":
      return (
        <View className="border-l pl-3" style={{ borderColor: color.line }}>
          <Blocks nodes={node.children} at={at} />
        </View>
      );

    case "list":
      return (
        <View className="gap-1.5">
          {node.children.map((item, i) => (
            <View key={`${at}-${i}`} className="flex-row gap-2">
              <Text className="font-sans text-read text-mute">
                {node.ordered ? `${(node.start ?? 1) + i}.` : "\u2022"}
              </Text>
              <View className="flex-1">
                <Blocks nodes={item.children} at={`${at}-${i}`} tight />
              </View>
            </View>
          ))}
        </View>
      );

    case "table": {
      const rows = node.children.map((row) =>
        row.children.map((cell) => flatten(cell.children as PhrasingContent[])),
      );
      return <Table rows={rows} at={at} />;
    }

    case "thematicBreak":
      return <View className="my-1 h-px" style={{ backgroundColor: color.line }} />;

    // `html` is the one thing deliberately dropped rather than shown. An agent
    // writing a raw tag means it to be markup, and the characters of it are
    // noise on a phone.
    case "html":
      return null;

    default:
      return null;
  }
}

function Blocks({ nodes, at, tight }: { nodes: RootContent[]; at: string; tight?: boolean }) {
  return (
    <View className={tight ? "gap-1" : "gap-3"}>
      {nodes.map((node, i) => (
        <Block key={`${at}-${i}`} node={node} at={`${at}-${i}`} />
      ))}
    </View>
  );
}

export function Prose({ text }: { text: string }) {
  /* Reparsed on every delta of a streaming turn, which sounds worse than it
     is: remark is fast, the turns are short, and the alternative — diffing
     half-written markdown — is how a parser starts disagreeing with itself
     about a fence that has not been closed yet. */
  return <Blocks nodes={parse(text).children} at="b" />;
}

/**
 * Code scrolls; it never wraps.
 *
 * The desk's rule, and it is *more* true here: a line broken mid-identifier is
 * harder to read on a phone than on a monitor, not easier.
 */
export function Code({
  text,
  tint,
  fence,
}: {
  text: string;
  /** Colour whole lines by their leading `+`/`-`. A diff, not a program. */
  tint?: boolean;
  /** The word after the backticks, if the author wrote one. */
  fence?: string;
}) {
  const [copied, setCopied] = useState(false);
  const lang = tint ? "text" : langNamed(fence ?? "");
  const lines = text.replace(/\n$/, "").split("\n");

  return (
    <View className="overflow-hidden rounded-md bg-panel">
      {/* A header, so the copy control has somewhere to live that is not on
          top of the first line of code — and so the language the fence
          claimed is visible, which is worth a row on its own. */}
      <View className="flex-row items-center justify-between border-b border-line-soft py-1.5 pl-3 pr-1.5">
        <Text className="font-mono text-micro uppercase tracking-[0.1em] text-mute">
          {fence || "text"}
        </Text>
        <Pressable
          testID="copy-code"
          hitSlop={10}
          onPress={() => {
            Clipboard.setString(text);
            Haptics.selectionAsync();
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          className="flex-row items-center gap-1.5 rounded-md px-2 py-1"
        >
          {copied ? <Check color={color.sage} size={13} /> : <Copy color={color.dim} size={13} />}
          <Text className={`font-sans text-micro ${copied ? "text-sage" : "text-dim"}`}>
            {copied ? "Copied" : "Copy"}
          </Text>
        </Pressable>
      </View>

      {/* Code scrolls; it never wraps — and only the second half of that was
          ever true here. `numberOfLines={1}` kept each line whole,
          `overflow-hidden` clipped it at the block's width, and nothing
          carried it sideways: the rest of the line was laid out and then
          hidden, with no way to reach it.

          One scroller around all of the lines rather than one each, so they
          move together and stay in their columns — a block whose rows scroll
          independently is not code any more. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10 }}
      >
        <View>
          {lines.map((raw, i) => {
            const added = raw.startsWith("+");
            const removed = raw.startsWith("-");
            if (tint || lang === "text") {
              return (
                <Text
                  key={i}
                  numberOfLines={1}
                  className="font-mono text-code"
                  style={{
                    color: tint && added ? color.sage : tint && removed ? color.brick : color.text,
                  }}
                >
                  {raw || " "}
                </Text>
              );
            }
            /* Nested `Text` rather than a row of them: a line has to stay one
               line for `numberOfLines` to mean anything, and pieces laid out
               side by side in a `View` would each become wrappable again. */
            return (
              <Text key={i} numberOfLines={1} className="font-mono text-code text-text">
                {highlight(raw, lang).map((piece, j) => (
                  <Text key={j} className={TONE[piece.kind]}>
                    {piece.text}
                  </Text>
                ))}
                {raw ? "" : " "}
              </Text>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}


