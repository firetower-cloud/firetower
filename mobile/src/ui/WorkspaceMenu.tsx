/**
 * What else you can do to a workspace.
 *
 * The desk puts this on a right-click and in a tab strip; a phone has neither,
 * so it is the `⋯` in the header and a panel from the bottom. Only what the
 * control plane actually offers for this session — a verb that is not
 * available is left out rather than shown greyed, because a phone has no
 * tooltip to explain why.
 *
 * Ending is separated by a rule and coloured brick. It is the one thing here
 * that cannot be undone.
 */
import { useState } from "react";
import { Alert, Modal, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";
import { ExternalLink, GitPullRequest, Pencil, RefreshCw, RotateCcw, Stethoscope, Trash2 } from "lucide-react-native";
import type { Session } from "~/api/generated/model";
import type { Conversation } from "~/api/conversation";
import {
  getGetSessionQueryKey,
  getListSessionsQueryKey,
  useRelaunchSession,
  useRenameSession,
  useStopSession,
} from "~/api/generated/sessions/sessions";
import { answerable } from "~/api/view";
import { why } from "~/data";
import { color, size } from "~/design/tokens.generated";

type Row = {
  id: string;
  label: string;
  icon: typeof Pencil;
  tone?: "brick";
  onPress: () => void;
};

export function WorkspaceMenu({
  session,
  conversation,
  runs,
  onReread,
  open,
  onClose,
  onEnded,
}: {
  session: Session;
  /** For the diagnostics sheet; see `Conversation.delivered`. */
  conversation?: Conversation;
  /** Every run of this workspace, not just the one being read. */
  runs?: { id: string; agent: string; status: string }[];
  /** Read the whole transcript again, from nothing. */
  onReread?: () => void;
  open: boolean;
  onClose: () => void;
  onEnded: () => void;
}) {
  const insets = useSafeAreaInsets();
  const cache = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(session.name);

  const rename = useRenameSession();
  const relaunch = useRelaunchSession();
  const stop = useStopSession();

  const freshen = () => {
    cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
    cache.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) });
  };

  const pr = session.checkouts?.find((c) => c.pullRequest)?.pullRequest ?? session.pullRequest;

  const rows: Row[] = [
    {
      id: "rename",
      label: "Rename",
      icon: Pencil,
      onPress: () => {
        setName(session.name);
        setRenaming(true);
      },
    },
    ...(pr
      ? [
          {
            id: "pr",
            label: "Open the pull request",
            icon: GitPullRequest,
            onPress: () => {
              onClose();
              void Linking.openURL(pr);
            },
          } as Row,
        ]
      : []),
    ...(session.taskUrl
      ? [
          {
            id: "task",
            label: `Open ${session.taskKey ?? "the task"}`,
            icon: ExternalLink,
            onPress: () => {
              onClose();
              void Linking.openURL(session.taskUrl!);
            },
          } as Row,
        ]
      : []),
    /* Relaunch is for a run that stopped and can be picked up. `Ended` is the
       only state with nothing left to talk to. */
    ...(answerable(session)
      ? [
          {
            id: "relaunch",
            label: "Restart the agent",
            icon: RotateCcw,
            onPress: () => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              relaunch.mutate({ id: session.id }, { onSettled: freshen });
              onClose();
            },
          } as Row,
        ]
      : []),
    ...(onReread
      ? [
          {
            id: "reread",
            label: "Read this conversation again",
            icon: RefreshCw,
            onPress: () => {
              /* Here as well as on the pull, because the pull cannot be
                 reached: a `RefreshControl` only fires at the very top of a
                 scroll view and a transcript opens pinned to the bottom of
                 one that may be thousands of messages long. A recovery you
                 have to scroll for an hour to reach is not one. */
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onReread();
              onClose();
            },
          } as Row,
        ]
      : []),
    {
      id: "why",
      label: "Why is this conversation short?",
      icon: Stethoscope,
      onPress: () => {
        /* A transcript that stops part way has two possible causes needing
           opposite fixes — the control plane sent fewer events than the
           conversation holds, or it sent them all and this client lost them.
           Nothing on screen tells those apart, and neither does a report of
           the symptom. So the app can be asked. */
        const d = conversation?.delivered;
        Alert.alert(
          "This conversation",
          [
            `Session  ${session.id}`,
            `Runs in this workspace  ${runs?.length ?? 1}`,
            ...(runs && runs.length > 1
              ? runs.map((r) => `  · ${r.agent} ${r.status} ${r.id}`)
              : []),
            "",
            d?.failed
              ? "First read  failed, streaming instead"
              : `First read  ${d ? `${d.events} events, up to line ${d.lastLine}` : "not finished"}`,
            `Drawn  ${conversation?.items.length ?? 0} items`,
            `Cursor  line ${conversation?.lastLine ?? 0}`,
            `Unreadable  ${conversation?.skipped ?? 0}`,
          ].join("\n"),
          [{ text: "Done" }],
        );
        onClose();
      },
    } as Row,
    {
      id: "end",
      label: "End this workspace",
      icon: Trash2,
      tone: "brick",
      onPress: () => {
        /* The one irreversible thing here, so it is asked rather than done.
           The worktree goes with it. */
        Alert.alert(
          "End this workspace?",
          "The agent stops and its worktree is removed from the host. Anything not committed goes with it.",
          [
            { text: "Keep it", style: "cancel" },
            {
              text: "End it",
              style: "destructive",
              onPress: () => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
                stop.mutate(
                  { id: session.id },
                  {
                    onSuccess: () => {
                      freshen();
                      onClose();
                      onEnded();
                    },
                    onError: (e) => Alert.alert("That didn't work", why(e)),
                  },
                );
              },
            },
          ],
        );
      },
    },
  ];

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/60" onPress={onClose} />
      <View
        className="rounded-t-2xl border-t border-line bg-panel"
        style={{ paddingBottom: insets.bottom + 8 }}
      >
        <View className="items-center pb-1 pt-2.5">
          <View className="h-1 w-9 rounded-full bg-mute" />
        </View>

        {renaming ? (
          <View className="gap-3 px-5 pb-4 pt-2">
            <Text className="font-narrow text-micro uppercase tracking-[0.18em] text-mute">
              Name
            </Text>
            <TextInput
              autoFocus
              value={name}
              onChangeText={setName}
              selectionColor={color.ember}
              className="rounded-xl bg-raise px-3.5 py-3 font-sans text-bone"
              style={{ fontSize: size.ui }}
            />
            <View className="flex-row gap-2">
              <Pressable
                onPress={() => setRenaming(false)}
                style={{ height: 48 }}
                className="flex-1 items-center justify-center rounded-xl border border-line"
              >
                <Text className="font-medium text-ui text-text">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  rename.mutate(
                    { id: session.id, data: { name: name.trim() } },
                    { onSettled: freshen },
                  );
                  setRenaming(false);
                  onClose();
                }}
                disabled={!name.trim()}
                style={{ height: 48 }}
                className={`flex-1 items-center justify-center rounded-xl ${name.trim() ? "bg-bone" : "bg-overlay"}`}
              >
                <Text
                  className={`font-semibold text-ui ${name.trim() ? "text-ground" : "text-mute"}`}
                >
                  Rename
                </Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View className="pb-2">
            {rows.map((row, i) => {
              const Icon = row.icon;
              const last = row.id === "end";
              return (
                <View key={row.id}>
                  {last && i > 0 ? <View className="my-1 h-px bg-line-soft" /> : null}
                  <Pressable
                    onPress={row.onPress}
                    className="flex-row items-center gap-3 px-5 py-4"
                    android_ripple={{ color: color.overlay }}
                  >
                    <Icon color={row.tone === "brick" ? color.brick : color.dim} size={17} />
                    <Text
                      className={`font-medium text-title ${row.tone === "brick" ? "text-brick" : "text-bone"}`}
                    >
                      {row.label}
                    </Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
        )}
      </View>
    </Modal>
  );
}
