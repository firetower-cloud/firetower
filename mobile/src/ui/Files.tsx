/**
 * The tree, one directory at a time, off the worker.
 *
 * `list_files` answers for one path, so the tree is opened rather than
 * fetched: a workspace is a checkout of somebody's whole repository and
 * walking it up front is a request nobody asked for.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useWorkspaceFiles } from "~/data";
import { toneOf } from "~/ui/FileGlyph";
import { color } from "~/design/tokens.generated";

function Level({
  sessionId,
  path,
  depth,
  touched,
  onOpen,
}: {
  sessionId: string;
  path: string;
  depth: number;
  touched: Set<string>;
  onOpen?: (path: string) => void;
}) {
  const { data, loading } = useWorkspaceFiles(sessionId, path);
  const [open, setOpen] = useState<Set<string>>(new Set());

  if (loading) {
    return (
      <View className="py-3" style={{ paddingLeft: 12 + depth * 14 }}>
        <ActivityIndicator color={color.mute} size="small" />
      </View>
    );
  }

  /* Directories first, then names. The worker answers in whatever order the
     filesystem gave it, which is not an order anybody reads in. */
  const sorted = [...data].sort((a, b) =>
    a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1,
  );

  return (
    <>
      {sorted.map((entry) => {
        const full = path ? `${path}/${entry.name}` : entry.name;
        const showing = open.has(full);
        return (
          <View key={full}>
            <Pressable
              onPress={() => {
                if (!entry.directory) return onOpen?.(full);
                const next = new Set(open);
                showing ? next.delete(full) : next.add(full);
                setOpen(next);
              }}
              className="flex-row items-center gap-2 py-2.5 pr-3"
              style={{ paddingLeft: 12 + depth * 14 }}
              android_ripple={{ color: color.overlay }}
            >
              {entry.directory ? (
                showing ? (
                  <ChevronDown color={color.mute} size={12} />
                ) : (
                  <ChevronRight color={color.mute} size={12} />
                )
              ) : (
                <View className="h-2 w-2 rounded-full" style={{ backgroundColor: toneOf(entry.name) }} />
              )}
              <Text
                numberOfLines={1}
                className={`min-w-0 flex-1 font-mono text-code ${entry.directory ? "text-dim" : "text-text"}`}
              >
                {entry.directory ? `${entry.name}/` : entry.name}
              </Text>
              {touched.has(full) ? <View className="h-1.5 w-1.5 rounded-full bg-sage" /> : null}
            </Pressable>

            {entry.directory && showing ? (
              <Level
                sessionId={sessionId}
                path={full}
                depth={depth + 1}
                touched={touched}
                onOpen={onOpen}
              />
            ) : null}
          </View>
        );
      })}
    </>
  );
}

export function Files({
  sessionId,
  touched,
  onOpen,
}: {
  sessionId: string;
  /** Workspace-relative paths this session changed, marked in the tree. */
  touched: Set<string>;
  onOpen?: (path: string) => void;
}) {
  return (
    <View className="py-1">
      <Level sessionId={sessionId} path="" depth={0} touched={touched} onOpen={onOpen} />
    </View>
  );
}
