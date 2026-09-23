/**
 * A workspace: the conversation, off the stream.
 *
 * Everything drawn here comes from `useConversation` in `~/api/conversation` —
 * the fold from lifecycle events into items, requests, questions, tasks, plan
 * and mode. That fold is the contract, shared with the other two clients; this
 * file only decides how each thing looks at phone size.
 *
 * The repository is one tap away rather than beside: see `~/ui/Changes`.
 */
import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { ChevronLeft, MoreHorizontal } from "lucide-react-native";
import { useConversation } from "~/api/conversation";
import { useListEvents } from "~/api/generated/events/events";
import type { Attached, Event } from "~/api/generated/model";
import { ready, stepLines } from "~/api/steps-bringup";
import { Bringup } from "~/ui/Bringup";
import { WorkspaceMenu } from "~/ui/WorkspaceMenu";
import {
  useAnswerRequest,
  useAttachFile,
  useInterruptSession,
  useSendTurn,
} from "~/api/generated/sessions/sessions";
import { elapsed, minutesSince, STATUS_LABEL } from "~/api/view";
import { useDiff, useSession, useSessions } from "~/data";
import { group, lead, type Workspace } from "~/api/workspaces";
import { AgentMark } from "~/ui/AgentMark";
import { Approval } from "~/ui/Approval";
import { Changes } from "~/ui/Changes";
import { Composer } from "~/ui/Composer";
import { Sheen } from "~/ui/Sheen";
import { Signal } from "~/ui/Signal";
import { Transcript } from "~/ui/Transcript";
import { Waiting } from "~/ui/Waiting";
import { color } from "~/design/tokens.generated";

/**
 * Resolving the address before anything reads it.
 *
 * The id in the address is a *workspace*; a transcript belongs to a *session*.
 * The first run of a workspace carries the workspace's own id, so the list is
 * what resolves one to the other — and until it has loaded there is no session
 * to follow.
 *
 * Split in two for that reason rather than for tidiness. Hooks cannot be
 * skipped, so a single component had to call `useConversation("")` while the
 * list was in flight — which asked the control plane for the conversation of a
 * session that does not exist and got a 404 on every cold open of a workspace.
 */
export default function WorkspaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: sessions, loading } = useSessions();

  const place = useMemo(() => {
    const { groups } = group(sessions.filter((s) => s.status !== "Ended"));
    return groups.flatMap(([, places]) => places).find((p) => p.id === id) ?? null;
  }, [sessions, id]);

  if (!place) {
    return (
      <View className="flex-1 items-center justify-center bg-ground">
        {loading ? (
          <Waiting say="Finding this workspace" />
        ) : (
          <Text className="font-sans text-ui text-mute">That workspace is not here any more.</Text>
        )}
      </View>
    );
  }

  return <Conversation place={place} />;
}

function Conversation({ place }: { place: Workspace }) {
  const insets = useSafeAreaInsets();
  const scroller = useRef<ScrollView>(null);
  const [atEnd, setAtEnd] = useState(true);

  const speaker = lead(place);
  const { data: session } = useSession(speaker.id);
  const { data: files } = useDiff(session);
  const [menu, setMenu] = useState(false);

  /* What the workspace did to come up. Read from this session's own events and
     folded by the same function the desk uses, so "Fetching the repository"
     means one thing everywhere. Polled while it is still coming up and left
     alone afterwards — the bring-up happens once. */
  const events = useListEvents(
    { sessionId: speaker.id, since: 0 } as Parameters<typeof useListEvents>[0],
    { query: { refetchInterval: (q) => (ready(stepLines(session ?? speaker, (q.state.data ?? []) as Event[])) ? false : 2000) } },
  );
  const bringup = useMemo(
    () => stepLines(session ?? speaker, (events.data ?? []) as Event[]),
    [session, speaker, events.data],
  );

  const { conversation, echo, settle, remember, stopping, reread, older } = useConversation(speaker.id);
  const [rereading, setRereading] = useState(false);
  const send = useSendTurn();
  const attach = useAttachFile();
  const answer = useAnswerRequest();
  const interrupt = useInterruptSession();

  /* The composer rides the keyboard's real frame on the UI thread. The same
     shared value pads the bottom of the transcript in the same frame — this is
     the whole difference between a chat that feels native and one that feels
     like a web page with a fixed footer. */
  const keyboard = useReanimatedKeyboardAnimation();
  const room = useAnimatedStyle(() => ({ height: Math.abs(keyboard.height.value) }));

  const say = (text: string, images: Attached[] = []) => {
    echo(text, images);
    send.mutate({ id: speaker.id, data: { text, images } });
    setTimeout(() => scroller.current?.scrollToEnd({ animated: true }), 60);
  };

  /* A file goes into the workspace rather than into the message: the agent
     has its own tools for reading one, and sending the bytes twice is waste. */
  const carry = async (name: string, data: string) => {
    await attach.mutateAsync({ id: speaker.id, data: { name, data } });
  };

  return (
    <View className="flex-1 bg-ground" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-1 border-b border-line-soft px-1 pb-2.5 pt-1">
        <Pressable onPress={() => router.back()} className="h-10 w-10 items-center justify-center" hitSlop={8}>
          <ChevronLeft color={color.bone} size={22} />
        </Pressable>

        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="font-medium text-title text-bone">
            {place.name}
          </Text>
          <View className="mt-0.5 flex-row items-center gap-1.5">
            <Signal status={speaker.status} size={6} />
            <Text className="font-sans text-meta text-dim">{STATUS_LABEL[speaker.status]}</Text>
            <Text className="font-sans text-meta text-mute">·</Text>
            <Text className="font-sans text-meta text-mute">
              {elapsed(minutesSince(speaker.updatedAt))}
            </Text>
            <View className="ml-1 flex-row items-center gap-1.5">
              {[...new Set(place.runs.map((r) => r.agent))].map((a) => (
                <AgentMark key={a} agent={a} size={11} tone={color.mute} />
              ))}
            </View>
          </View>
        </View>

        <Pressable
          testID="workspace-menu"
          onPress={() => setMenu(true)}
          className="h-10 w-10 items-center justify-center"
          hitSlop={8}
        >
          <MoreHorizontal color={color.dim} size={20} />
        </Pressable>
      </View>

      {/* Under the header rather than over the composer.
          It is a fact about the workspace, not about the message being
          written, and sitting it on top of the composer put a second bar of
          chrome between the conversation and the thing you type into — two
          rows deep at the bottom of the screen, which is the most crowded
          place on a phone and the one where a message is supposed to be.

          Always here, not only when something is uncommitted: a session that
          has committed its work has a clean tree, and hiding the strip then
          left the diff, the files and the pull request with no way in. */}
      {session ? (
        <Changes
          session={session}
          files={files}
          onPress={() => router.push({ pathname: "/workspace/repo", params: { id: speaker.id } })}
        />
      ) : null}

      <View className="min-h-0 flex-1">
        <ScrollView
          ref={scroller}
          className="flex-1"
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16 }}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="interactive"
          /* Streaming text appends to the last item. If you are at the bottom
             you stay pinned; if you have scrolled up to read something you are
             not yanked back. */
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            setAtEnd(contentOffset.y + layoutMeasurement.height >= contentSize.height - 80);
            /* And the other edge. A transcript opens on its last few
               exchanges, so reaching the top is a request for the ones before
               them rather than the beginning of the conversation. Asked for
               early — a screen's height from the top — so the page is usually
               there before the scroll arrives. `older` refuses when there is
               nothing to read or a page is already coming, so this does not
               have to be careful. */
            if (contentOffset.y < layoutMeasurement.height) older();
          }}
          scrollEventThrottle={64}
          /* Prepending to a scrolled list moves everything below it down, and
             what somebody was reading goes with it. This pins the content
             instead of the offset, which is the one thing that makes reading
             backwards feel like reading rather than like fighting the list.
             Native on both platforms; there is no JS frame in which the jump
             could be visible. */
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onContentSizeChange={() => atEnd && scroller.current?.scrollToEnd({ animated: true })}
          /* Pull to read it again from nothing.
             A conversation holds on to whatever it first folded and claims to
             be up to date afterwards, so a transcript that came out short
             stayed short for the life of the app with nothing to press. This
             is that something. */
          refreshControl={
            <RefreshControl
              refreshing={rereading}
              tintColor={color.mute}
              onRefresh={() => {
                setRereading(true);
                reread();
                setTimeout(() => setRereading(false), 600);
              }}
            />
          }
        >
          <Text className="mb-3 font-mono text-meta text-mute">
            {speaker.branch ?? place.branch}
          </Text>

          {/* The bring-up sits above the transcript and scrolls away once the
              agent is talking, which is the right amount of attention for it. */}
          <Bringup lines={bringup} />

          {/* The history arriving. Sits above the transcript because that is
              where it is going, and says nothing when there is nothing left to
              read — a conversation short enough to arrive whole should never
              show a hint that it was cut. */}
          {conversation.loadingOlder ? (
            <View className="items-center py-3">
              <ActivityIndicator size="small" color={color.mute} />
            </View>
          ) : null}

          {conversation.items.length > 0 ? (
            <Transcript items={conversation.items} />
          ) : conversation.trouble ? (
            <Text className="mt-2 font-sans text-meta text-brick">{conversation.trouble}</Text>
          ) : !conversation.arrived ? (
            /* Before this branch existed the fall-through below ran while the
               snapshot was still crossing the wire, so a conversation that was
               merely long was reported as one that had never happened. An
               empty transcript is only empty once something has come back to
               say so. */
            <Waiting say="Loading the conversation" />
          ) : bringup.some((l) => l.state !== "pending") ? null : (
            /* Nothing said and nothing coming up: a workspace that is simply
               waiting for you to open the conversation. */
            <Text className="mt-2 font-sans text-meta text-mute">Nothing has been said yet.</Text>
          )}

          {/* A gap that admits it is one. Before `foldAll` this was the
              silent case: the transcript stopped at whatever line could not
              be folded and said nothing about why, which reads exactly like a
              long conversation that never finished loading. */}
          {conversation.skipped ? (
            <Text className="mt-3 font-sans text-meta text-brick">
              {conversation.skipped === 1
                ? "One line of this conversation could not be read."
                : `${conversation.skipped} lines of this conversation could not be read.`}
            </Text>
          ) : null}

          {conversation.working ? (
            <View className="mt-3">
              <Sheen text={conversation.stopping ? "Stopping" : "Working"} />
            </View>
          ) : conversation.stopped ? (
            <Text className="mt-3 font-sans text-meta text-brick">{conversation.stopped}</Text>
          ) : null}

          <Animated.View style={room} />
        </ScrollView>
      </View>

      {session ? (
        <WorkspaceMenu
          session={session}
          conversation={conversation}
          runs={place.runs.map((r) => ({ id: r.id, agent: r.agent, status: r.status }))}
          onReread={reread}
          open={menu}
          onClose={() => setMenu(false)}
          onEnded={() => router.back()}
        />
      ) : null}

      <Composer
        sessionId={speaker.id}
        working={conversation.working}
        model={conversation.model}
        mode={conversation.mode}
        onSend={say}
        onRemember={remember}
        onAttach={carry}
        onInterrupt={() => {
          stopping(true);
          interrupt.mutate({ id: speaker.id });
        }}
        above={conversation.asked.map((a) => (
          <Approval
            key={a.req}
            asked={a}
            onAnswer={(yes) => {
              settle(a.req);
              answer.mutate({
                id: speaker.id,
                data: { req: a.req, decision: yes ? { decision: "Allow" } : { decision: "Deny", reason: null } },
              });
            }}
          />
        ))}
      />
    </View>
  );
}
