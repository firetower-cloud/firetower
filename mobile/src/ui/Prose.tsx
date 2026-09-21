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
import { Text, View } from "react-native";
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
          const body = block.replace(/^```[a-z]*\n?/, "").replace(/```$/, "");
          return <Code key={i} text={body} />;
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
export function Code({ text, tint }: { text: string; tint?: boolean }) {
  return (
    <View className="overflow-hidden rounded-md bg-panel">
      <View className="px-3 py-2.5">
        {text.split("\n").map((raw, i) => {
          const added = raw.startsWith("+");
          const removed = raw.startsWith("-");
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
        })}
      </View>
    </View>
  );
}
