/**
 * Shipping what the agent did.
 *
 * `api/ship.ts` is the contract: `shipping(session, work)` reduces every
 * checkout's state to one stage — uncommitted → unpushed → pushed → open — and
 * one honest label for the button, which is always exactly what pressing it
 * does. The desk puts three controls in a row; 390pt has room for one, which
 * is the whole reason the stage model exists rather than a panel offering
 * every verb and leaving somebody to work out which applies.
 *
 * The title and body come from `describe_session` — the run's own proposal —
 * and are a draft to edit, not a box to fill. Nothing acts on them until the
 * button.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { GitBranch, GitPullRequest } from "lucide-react-native";
import type { Session } from "~/api/generated/model";
import {
  getGetSessionQueryKey,
  getListSessionsQueryKey,
  getSessionWorkQueryKey,
  useCommitSession,
  useDescribeSession,
  useOpenPullRequest,
  usePushSession,
  useSessionWork,
} from "~/api/generated/sessions/sessions";
import { ready, shipping } from "~/api/ship";
import { why } from "~/data";
import { color, size } from "~/design/tokens.generated";

export function Ship({
  session,
  files,
  bottom = 0,
}: {
  session: Session;
  files: number;
  /** The home indicator's room. The action is pinned, so it owes it. */
  bottom?: number;
}) {
  const cache = useQueryClient();
  const { data: work, isError: workFailed } = useSessionWork(session.id, {
    query: { refetchInterval: 15_000 },
  });
  const ship = shipping(session, work, workFailed);

  const [title, setTitle] = useState(session.proposedTitle ?? "");
  const [body, setBody] = useState(session.proposedBody ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [wrong, setWrong] = useState<string | null>(null);

  /* The run's own proposal, asked for once. It is a draft: it fills the boxes
     and then leaves them alone, because overwriting what somebody has edited
     because a request came back late is worse than never having helped. */
  const describe = useDescribeSession();
  useEffect(() => {
    if (title || body) return;
    describe.mutate(
      { id: session.id },
      {
        onSuccess: (d) => {
          setTitle((t) => t || d.title);
          setBody((b) => b || (d.body ?? ""));
        },
        onError: () => {},
      },
    );
    // Once per session, on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const commit = useCommitSession();
  const push = usePushSession();
  const open = useOpenPullRequest();

  const freshen = () => {
    cache.invalidateQueries({ queryKey: getSessionWorkQueryKey(session.id) });
    cache.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) });
    cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
  };

  /**
   * The sequence, run as far as it needs to go.
   *
   * One button rather than three, because the stage already says which steps
   * are outstanding — and a person who wants a pull request does not want to
   * be asked about committing first.
   */
  const go = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setWrong(null);
    try {
      if (ship.stage === "uncommitted") {
        setBusy("Committing…");
        await commit.mutateAsync({ id: session.id, data: { message: title || "Work in progress" } });
      }
      if (ship.stage === "uncommitted" || ship.stage === "unpushed" || ship.stage === "open-behind") {
        setBusy("Pushing…");
        await push.mutateAsync({ id: session.id });
      }
      if (ship.stage !== "open-behind") {
        setBusy("Opening the pull request…");
        await open.mutateAsync({ id: session.id, data: { title, body } });
      }
      freshen();
    } catch (e) {
      setWrong(why(e));
    } finally {
      setBusy(null);
    }
  };

  const can = ready(ship) && !busy;

  return (
    <View className="min-h-0 flex-1">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ gap: 16, paddingHorizontal: 16, paddingVertical: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="flex-row items-center gap-2">
          <GitBranch color={color.mute} size={13} />
          <Text numberOfLines={1} className="flex-1 font-mono text-meta text-dim">
            {session.branch ?? session.checkouts?.[0]?.branch ?? "—"}
          </Text>
          <Text className="font-sans text-meta text-mute">
            {files} {files === 1 ? "file" : "files"}
          </Text>
        </View>

        <View className="gap-2">
          <Text className="font-narrow text-micro uppercase tracking-[0.18em] text-mute">Title</Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder={describe.isPending ? "Asking the agent…" : "What this changes"}
            placeholderTextColor={color.mute}
            selectionColor={color.ember}
            className="rounded-md bg-raise px-3 py-3 font-sans text-bone"
            style={{ fontSize: size.ui }}
          />
        </View>

        <View className="gap-2">
          <Text className="font-narrow text-micro uppercase tracking-[0.18em] text-mute">Body</Text>
          <TextInput
            value={body}
            onChangeText={setBody}
            multiline
            placeholder="Why, and anything a reviewer needs"
            placeholderTextColor={color.mute}
            selectionColor={color.ember}
            className="rounded-md bg-raise px-3 py-3 font-sans text-text"
            style={{ fontSize: size.ui, minHeight: 120, textAlignVertical: "top" }}
          />
        </View>

        {ship.links.length > 0 ? (
          <View className="gap-1.5">
            <Text className="font-narrow text-micro uppercase tracking-[0.18em] text-mute">Open</Text>
            {ship.links.map((l) => (
              <Text key={l.url} numberOfLines={1} className="font-mono text-meta text-slate">
                {l.slug}
              </Text>
            ))}
          </View>
        ) : null}

        {wrong ? <Text className="font-sans text-meta text-brick">{wrong}</Text> : null}
      </ScrollView>

      {/* Pinned. It is the one thing this tab is for, and a button you have to
          scroll to find is one people assume is missing. */}
      <View className="border-t border-line-soft px-4 pt-3" style={{ paddingBottom: bottom + 10 }}>
        <Pressable
          disabled={!can}
          onPress={go}
          style={{ height: 52 }}
          className={`flex-row items-center justify-center gap-2 rounded-xl ${can ? "bg-bone" : "bg-overlay"}`}
        >
          {busy ? (
            <ActivityIndicator color={color.mute} />
          ) : (
            <>
              <GitPullRequest color={can ? color.ground : color.mute} size={16} />
              <Text className={`font-semibold text-title ${can ? "text-ground" : "text-mute"}`}>
                {ship.label}
              </Text>
            </>
          )}
        </Pressable>

        {busy ? (
          <Text className="mt-2 text-center font-sans text-meta text-dim">{busy}</Text>
        ) : ship.blocked ? (
          <Text className="mt-2 text-center font-sans text-meta text-mute">{ship.blocked}</Text>
        ) : null}
      </View>
    </View>
  );
}
