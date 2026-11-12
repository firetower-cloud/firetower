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
} from "~/api/generated/sessions/sessions";
import { answerable } from "~/api/view";
import type { Workspace } from "~/api/workspaces";
import { size } from "~/design/tokens.generated";
import { useEndWorkspace, type Ending } from "~/ui/end";
import { Sheet } from "~/ui/Sheet";
import { useTheme } from "~/design/theme";

type Row = {
  id: string;
  label: string;
  icon: typeof Pencil;
  tone?: "brick";
  onPress: () => void;
};

export function WorkspaceMenu({
  session,
  place,
  conversation,
  runs,
  onReread,
  delegated = 0,
  open,
  onClose,
  onEnding,
}: {
  session: Session;
  /**
   * The place this conversation is one run of.
   *
   * Ending is a fact about the *place* — its id, its branch, every run in it —
   * and `session` is whichever run is being read. See `ui/end.ts` on why the
   * difference between those two ids decides whether a workspace goes or the
   * wrong thing does.
   */
  place: Workspace;
  /** For the diagnostics sheet; see `Conversation.delivered`. */
  conversation?: Conversation;
  /** Every run of this workspace, not just the one being read. */
  runs?: { id: string; agent: string; status: string }[];
  /**
   * How many agents this workspace started **elsewhere** and has not ended.
   *
   * They go with it, and since their rows are now folded under this
   * workspace's on both lists, the question is the last place anybody is told
   * so. `childrenElsewhere` is what counts them; only a list of places can.
   */
  delegated?: number;
  /** Read the whole transcript again, from nothing. */
  onReread?: () => void;
  open: boolean;
  onClose: () => void;
  /**
   * The teardown was **asked for and accepted** — not finished.
   *
   * It was `onEnded`, and that was a claim the control plane never made: it
   * answers `202` once the `Destroy` frames are queued and does not wait for
   * the worker, which can still fail. See {@link Ending}.
   *
   * The screen is still left, because the list is where the three states are
   * legible and the question now says so: the row is there until the host has
   * done it, and gone when it has. What changed is that nothing on this path
   * calls an acceptance an ending.
   */
  onEnding: () => void;
}) {
  const { color } = useTheme();
  const cache = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(session.name);

  const rename = useRenameSession();
  const relaunch = useRelaunchSession();
  const end = useEndWorkspace();

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
    /* **Left out rather than shown refused**, which is this menu's own rule.
       Ending a place is for whoever it belongs to — `may_share`, server side —
       and a phone has no tooltip to explain a greyed row. `!== false` because
       a control plane older than this app sends no such field, and reading
       absence as "you may only watch" takes the control from the person whose
       work it is. */
    ...(place.runs.some((r) => r.mayWrite !== false)
      ? [
          {
            id: "end",
            label: "End this workspace",
            icon: Trash2,
            tone: "brick",
            onPress: () => {
              /* The one irreversible thing here, so it is asked rather than
                 done — and what it asks is now what it does. `ui/end.ts` is
                 the desk's flow and the sentence that goes with it. */
              void end(place, delegated).then((ending) => {
                /* `requested` and nothing else: a refusal has already said so
                   in the control plane's own words, and a question answered
                   no leaves the menu where it was. */
                if (ending !== "requested") return;
                onClose();
                onEnding();
              });
            },
          } as Row,
        ]
      : []),
  ];

  return (
    <Sheet open={open} onClose={onClose}>
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
    </Sheet>
  );
}
