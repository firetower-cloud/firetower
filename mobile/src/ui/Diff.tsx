/**
 * What changed, file by file.
 *
 * Two rules from the desk, and both are *more* true on a phone:
 *
 * - **Code scrolls; it never wraps.** A line broken mid-identifier is harder
 *   to read on 390pt than on a monitor, not easier.
 * - **The gutter carries the diff.** A line this session wrote gets a sage
 *   number cell and a tinted row, so "what did it change in here" is answered
 *   without leaving for somewhere else.
 *
 * The gutter is pinned while the code moves under it: a horizontal scroll that
 * carries the line numbers off the screen throws away the one column that says
 * where you are.
 */
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { fromPatch, isNew } from "~/api/patch";
import type { ChangedFile } from "~/data";
import { toneOf } from "~/ui/FileGlyph";
import { split } from "~/api/paths";
import { color, size } from "~/design/tokens.generated";

const ROW = 19;

function Hunks({ patch }: { patch: string }) {
  const lines = fromPatch(patch);
  /* Line numbers in the new file, counted as we walk — the same pass the
     gutter is drawn from, so the two cannot come apart. */
  let at = 0;
  const numbered = lines.map(([kind, text]) => {
    if (kind === "hunk") {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
      at = m ? Number(m[1]) : at;
      return { kind, text, n: null as number | null };
    }
    if (kind === "del") return { kind, text, n: null as number | null };
    const n = at;
    at += 1;
    return { kind, text, n };
  });

  return (
    <View className="flex-row">
      {/* Pinned. The code scrolls under it. */}
      <View className="border-r border-line-soft bg-ground">
        {numbered.map((l, i) => (
          <View
            key={i}
            style={{ height: ROW, justifyContent: "center" }}
            className={l.kind === "add" ? "bg-sage-tint" : l.kind === "del" ? "bg-brick-tint" : ""}
          >
            <Text
              className="px-2 font-mono text-right"
              style={{ fontSize: size.micro, color: l.kind === "add" ? color.sage : color.mute }}
            >
              {l.n ?? ""}
            </Text>
          </View>
        ))}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1">
        <View>
          {numbered.map((l, i) => (
            <View
              key={i}
              style={{ height: ROW, justifyContent: "center", minWidth: 320 }}
              className={l.kind === "add" ? "bg-sage-tint" : l.kind === "del" ? "bg-brick-tint" : ""}
            >
              <Text
                numberOfLines={1}
                className="px-2 font-mono"
                style={{
                  fontSize: size.code,
                  color:
                    l.kind === "hunk"
                      ? color.mute
                      : l.kind === "add"
                        ? color.bone
                        : l.kind === "del"
                          ? color.dim
                          : color.text,
                }}
              >
                {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                {l.text || " "}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

export function Diff({ files, onOpen }: { files: ChangedFile[]; onOpen?: (path: string) => void }) {
  const [open, setOpen] = useState<string | null>(files[0]?.path ?? null);

  return (
    <View>
      {files.map((file) => {
        const showing = open === file.path;
        const { name, dir } = split(file.path);
        return (
          <View key={file.path} className="border-b border-line-soft">
            <Pressable
              onPress={() => setOpen(showing ? null : file.path)}
              className="flex-row items-center gap-2 px-3 py-3"
              android_ripple={{ color: color.overlay }}
            >
              {showing ? (
                <ChevronDown color={color.mute} size={13} />
              ) : (
                <ChevronRight color={color.mute} size={13} />
              )}
              <View className="h-2 w-2 rounded-full" style={{ backgroundColor: toneOf(file.path) }} />
              <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="font-mono text-meta text-bone">
                  {name}
                </Text>
                {dir ? (
                  <Text numberOfLines={1} className="font-mono text-mute" style={{ fontSize: size.micro }}>
                    {dir}
                  </Text>
                ) : null}
              </View>
              {isNew(file.patch) ? (
                <Text className="font-narrow text-micro uppercase tracking-[0.14em] text-sage">new</Text>
              ) : null}
              <Text className="font-mono text-meta text-sage">+{file.added}</Text>
              <Text className="font-mono text-meta text-brick">−{file.removed}</Text>
            </Pressable>

            {showing ? <Hunks patch={file.patch} /> : null}
          </View>
        );
      })}
    </View>
  );
}
