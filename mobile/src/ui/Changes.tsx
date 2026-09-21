/**
 * The way from the conversation into the repository.
 *
 * A strip above the composer: how many files, how much moved, and what the
 * next honest step is. Tapping it opens the repository as a page.
 *
 * It replaced a draggable sheet. The sheet was an attempt to keep the desk's
 * arrangement — chat and repository at once — and on a 390pt screen it kept
 * neither: three lines of conversation is not context, and a diff in a third
 * of the screen is not a diff. A strip costs two lines and says the same
 * three facts.
 *
 * `shipping()` decides the label, so this and the Commit tab cannot disagree
 * about what the next step is.
 */
import { Pressable, Text, View } from "react-native";
import { ChevronRight, FileDiff } from "lucide-react-native";
import type { Session } from "~/api/generated/model";
import { useSessionWork } from "~/api/generated/sessions/sessions";
import { shipping } from "~/api/ship";
import type { ChangedFile } from "~/data";
import { color } from "~/design/tokens.generated";

export function Changes({
  session,
  files,
  onPress,
}: {
  session: Session;
  files: ChangedFile[];
  onPress: () => void;
}) {
  const { data: work, isError } = useSessionWork(session.id);
  const ship = shipping(session, work, isError);

  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);

  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-2 border-t border-line-soft bg-panel px-4 py-3"
      android_ripple={{ color: color.overlay }}
    >
      <FileDiff color={color.dim} size={14} />
      <Text className="font-sans text-meta text-dim">
        {files.length} {files.length === 1 ? "file" : "files"}
      </Text>
      {added ? <Text className="font-mono text-meta text-sage">+{added}</Text> : null}
      {removed ? <Text className="font-mono text-meta text-brick">−{removed}</Text> : null}
      <View className="flex-1" />
      <Text numberOfLines={1} className="font-sans text-meta text-mute">
        {ship.label}
      </Text>
      <ChevronRight color={color.mute} size={14} />
    </Pressable>
  );
}
