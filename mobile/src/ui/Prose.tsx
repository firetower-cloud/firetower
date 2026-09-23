/**
 * Just enough markdown to read an agent by.
 *
 * A placeholder with a deadline: Phase 2 replaces this with a walk over the
 * same mdast `remark-parse` and `remark-gfm` produce on the other two clients,
 * so that all three agree about what a nested list or a fenced block *is*.
 * What is here handles the four things that turn up in every other sentence —
 * bold, inline code, fences and bullets — so the screen can be judged before
 * that lands.
 */
import { useState } from "react";
import { Clipboard, Pressable, ScrollView, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { Check, Copy } from "lucide-react-native";
import { highlight, langNamed, TONE } from "~/api/syntax";
import { color } from "~/design/tokens.generated";

/** `**bold**` and `` `code` ``, in one pass, order-preserving. */
function inline(text: string, key: string) {
  const out: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text))) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const piece = m[0];
    if (piece.startsWith("**")) {
      out.push(
        <Text key={`${key}-b${m.index}`} className="font-semibold text-bone">
          {piece.slice(2, -2)}
        </Text>,
      );
    } else {
      out.push(
        <Text key={`${key}-c${m.index}`} className="font-mono text-code text-kind-source">
          {piece.slice(1, -1)}
        </Text>,
      );
    }
    at = m.index + piece.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function Prose({ text }: { text: string }) {
  const blocks = text.split("\n\n");
  return (
    <View className="gap-3">
      {blocks.map((block, i) => {
        if (block.startsWith("```")) {
          // The fence's own word, which is the only thing that says what
          // language this is.
          const named = block.slice(3, block.indexOf("\n") < 0 ? 3 : block.indexOf("\n"));
          const body = block.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "");
          return <Code key={i} text={body} fence={named} />;
        }
        if (/^[-*] /m.test(block)) {
          return (
            <View key={i} className="gap-1.5">
              {block.split("\n").map((li, j) => (
                <View key={j} className="flex-row gap-2">
                  <Text className="font-sans text-body text-mute">•</Text>
                  <Text className="flex-1 font-sans text-read text-text">
                    {inline(li.replace(/^[-*] /, ""), `${i}-${j}`)}
                  </Text>
                </View>
              ))}
            </View>
          );
        }
        return (
          <Text key={i} className="font-sans text-read text-text">
            {inline(block, String(i))}
          </Text>
        );
      })}
    </View>
  );
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


