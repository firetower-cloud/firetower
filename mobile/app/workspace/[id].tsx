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
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from "react-native";
/* React Native 0.88 split the component type from the instance type: `ScrollView`
   now names the component, so a ref wants `ScrollViewInstance`. */
import type { ScrollViewInstance } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { ChevronLeft, Eye, MoreHorizontal, PanelRight } from "lucide-react-native";
import { delegating, interruptible, useConversation } from "~/api/conversation";
import { useListEvents } from "~/api/generated/events/events";
import { useListArtifacts } from "~/api/generated/artifacts/artifacts";
import type { Attached, Event, Session } from "~/api/generated/model";
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
import { ArtifactCard } from "~/ui/ArtifactCard";
import { Overview } from "~/ui/Overview";
import { ImagesFrom } from "~/ui/WorkspaceImage";
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
  const scroller = useRef<ScrollViewInstance>(null);
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

  /**
   * The artifacts this session published.
   *
   * Owned by a person rather than by the workspace — `reclaim.rs` deletes a
   * workspace within a minute of its last session ending and the cascade
   * takes the conversation with it, so these rows deliberately sit outside
   * it. That is why they are fetched separately rather than folded into the
   * conversation.
   *
   * **Grouped at the end rather than anchored inline.** The desktop places
   * each card at its `firstSeenLine`; the phone's fold does not carry a line
   * number onto an `Item`, and threading one through would change a contract
   * shared with two other clients. The end of the transcript is the fallback
   * the server already documents for rows with no line, so it is the same
   * behaviour rather than a new one.
   */
  /**
   * The team around this workspace, one level up and one level down.
   *
   * The manager is this session when it leads and the session that started it
   * when it is a child; the roster is everyone under that manager, which is
   * the same set whichever member you are reading. Derived from the list the
   * inbox already holds rather than fetched — the parent is a field on a run.
   */
  /* The same query the inbox reads; react-query hands back the one cache
     rather than asking twice. */
  const { data: sessions } = useSessions();
  const above = useMemo(
    () => (speaker.parentId ? (sessions.find((s: Session) => s.id === speaker.parentId) ?? null) : null),
    [sessions, speaker.parentId],
  );
  const managerId = above?.id ?? speaker.id;
  const team = useMemo(() => sessions.filter((s: Session) => s.parentId === managerId), [sessions, managerId]);

  /* Beside the conversation when the display is wide enough to hold both —
     the Duo's inner panel is the first phone screen that is — and a pushed
     route when it is not. One component, two placements. */
  /**
   * Where the overview goes, which is three answers and not two.
   *
   * The conversation is never squeezed — that is the whole rule, and the
   * widths decide which way of keeping it applies:
   *
   * - **push**, under 600. There is no room for a rail at all; it is its own
   *   screen, one back-gesture away. The phone at 390 and the Duo's front
   *   panel at 466.
   * - **float**, 600 to 820. Wide enough to want the rail, too narrow to
   *   split: 669 minus a 340 rail leaves 329, which is less than the phone
   *   this app was designed for. So it comes over the top and the
   *   conversation keeps its full width underneath. The Duo's inner panel
   *   in portrait, which an earlier single threshold of 700 missed entirely.
   * - **dock**, 820 and over. Room for both, so the rail sits beside and the
   *   conversation takes the majority — 611 of the Duo's 951 in landscape.
   *
   * Collapsible in both of the last two, from one control, so rotating the
   * device never changes what the button does — only where the rail lands.
   */
  const { width } = useWindowDimensions();
  const rail: "push" | "float" | "dock" = width >= 820 ? "dock" : width >= 600 ? "float" : "push";

  /* Docked starts open because it costs the conversation nothing it needs;
     floated starts closed because it costs the conversation all of it. */
  const [railOpen, setRailOpen] = useState(rail === "dock");

  /* Only the docked rail yields — a floated one is over the top, so there is
     nothing to take width from. */
  const panel = rail === "dock" ? Math.min(340, Math.max(280, width - 400)) : 340;
  const beside = rail === "dock" && railOpen;
  const floating = rail === "float" && railOpen;

  const { data: everyArtifact } = useListArtifacts();
  const family = useMemo(() => new Set([managerId, ...team.map((t) => t.id)]), [managerId, team]);
  const artifacts = useMemo(
    () => (everyArtifact ?? []).filter((a) => a.fromSessionId && family.has(a.fromSessionId)),
    [everyArtifact, family],
  );

  const { conversation, echo, settle, remember, stopping, reread, older } = useConversation(speaker.id);
  const [rereading, setRereading] = useState(false);
  /* The live one first — a todo list arrives on the turn stream and moves as
     the agent works. `session.plan` is the cross-engine fallback an agent set
     through `firetower:plan`, which rides on the session and lands a poll
     later. */
  /* The plan is the manager's. `lead()` picks whichever run is *speaking*,
     which once a team exists is often a subagent — and a subagent keeps no
     plan, so reading it there emptied the panel exactly when there was a
     team to show one for. */
  const plan =
    conversation.plan.length > 0 ? conversation.plan : ((above ?? session)?.plan ?? []);

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

  /* Named once: the docked column and the floated sheet draw the same thing
     and must not drift apart. */
  const overview = session ? (
    <Overview
      session={session}
      lead={above}
      team={team}
      plan={plan}
      artifacts={artifacts}
      onOpenArtifact={(id) => router.push({ pathname: "/workspace/artifact", params: { id } })}
    />
  ) : null;

  return (
    <View className="flex-1 bg-ground" style={{ paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}>
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

        {/* Only when the overview cannot sit beside the conversation. On a
            wide display it is already on screen and a button to it would open
            a second copy of what you are looking at. */}
        {/* One control, three meanings — and it reads the same in all of them:
            "show me the overview". Only where it lands differs. */}
        <Pressable
          testID="overview"
          onPress={() =>
            rail === "push"
              ? router.push({ pathname: "/workspace/overview", params: { id: place.id } })
              : setRailOpen((open) => !open)
          }
          className={`h-10 w-10 items-center justify-center rounded-md ${railOpen && rail !== "push" ? "bg-raise" : ""}`}
          hitSlop={8}
        >
          <PanelRight color={railOpen && rail !== "push" ? color.bone : color.dim} size={19} />
        </Pressable>

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

      <View className={beside ? "min-h-0 flex-1 flex-row" : "min-h-0 flex-1"}>
      {/* The conversation column: transcript, menu and composer together, so
          the overview sits beside all three rather than between them. */}
      <View className="min-h-0 flex-1">
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
            <>
              {/* Which workspace the pictures in the agent's prose are read
                  from. Without this a `![shot](docs/shot.png)` has nowhere to
                  look. */}
              <ImagesFrom.Provider value={{ session: speaker.id }}>
                <Transcript items={conversation.items} tasks={conversation.tasks} />
              </ImagesFrom.Provider>

            </>
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

          {/* Outside the conditional above on purpose. An artifact is owned by
              a person and outlives the workspace that made it, so a session
              whose transcript is empty — or has not arrived — can still have
              published one. Nesting these in the transcript branch hid them
              exactly when the card was the only thing worth seeing. */}
          {artifacts.map((a) => (
            <ArtifactCard
              key={a.id}
              artifact={a}
              onOpen={() => router.push({ pathname: "/workspace/artifact", params: { id: a.id } })}
            />
          ))}

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
              {/* Once the turn has ended, the subagents are the only thing
                  still working — so they are what this line is about. */}
              <Sheen
                text={
                  conversation.stopping
                    ? "Stopping"
                    : conversation.inTurn
                      ? "Working"
                      : delegating(conversation.tasks)
                }
              />
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

      {/* A viewer gets no composer here either. Same reason as the desk: a box
          that takes a message the server will refuse reads as the product
          being broken, not as a permission somebody does not have. */}
      {/* `=== false`, not falsiness: an older control plane sends no such field,
          and treating that as read-only hides the composer from everybody. */}
      {session && session.maySpeak === false ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 16, alignItems: "center" }}>
          <View className="flex-row items-center gap-2.5 rounded-full border border-line bg-panel px-4 py-3">
            <Eye color={color.mute} size={14} />
            <Text className="font-sans text-ui text-dim">You are watching this work.</Text>
          </View>
        </View>
      ) : (
      <Composer
        sessionId={speaker.id}
                    acp={speaker.agent === "KimiCode" || speaker.agent === "CursorAgent" || speaker.agent === "MistralVibe"}
        // What the stop button can reach, which is narrower than what is
        // working. See `interruptible`.
        working={interruptible(conversation)}
        model={conversation.model}
        mode={conversation.mode}
        onSend={say}
        onRemember={remember}
        onAttach={carry}
        onInterrupt={() => {
          stopping(true);
          interrupt.mutate({ id: speaker.id });
        }}
        // Only to somebody who may act here. The composer is already gone for a
        // viewer, and these ride above it — an approval is the one control
        // where being drawn and refused is worst: the agent is stopped, asking
        // whether it may do something on the owner's machine.
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
      )}
      </View>

      {/* Docked: a sibling column, so the conversation reflows to what is
          left — 611 of the Duo's 951, which is wider than any phone. */}
      {beside ? (
        <View className="border-l border-line-soft" style={{ width: panel }}>
          <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>{overview}</ScrollView>
        </View>
      ) : null}

      {/* Floated: over the top, so the conversation keeps its full width and
          dismissing costs no reflow. The scrim is the dismiss target — a
          panel you can only close from the control that opened it is a trap
          on a screen you are holding in one hand. */}
      {floating ? (
        <>
          <Pressable
            testID="overview-scrim"
            onPress={() => setRailOpen(false)}
            className="absolute bottom-0 left-0 right-0 top-0"
            style={{ backgroundColor: "rgba(0,0,0,0.45)" }}
          />
          <View
            className="absolute bottom-0 right-0 top-0 border-l border-line bg-panel"
            style={{ width: panel, shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 18, shadowOffset: { width: -8, height: 0 } }}
          >
            <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>{overview}</ScrollView>
          </View>
        </>
      ) : null}
      </View>
    </View>
  );
}
