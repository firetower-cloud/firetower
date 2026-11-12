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
/* React Native 0.88 split the component type from the instance type: `ScrollView`
   now names the component, so a ref wants `ScrollViewInstance`. */
import type { ScrollViewInstance } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BLEED, useEdges } from "~/ui/edges";
import { router, useLocalSearchParams } from "expo-router";
import { ChevronLeft, Eye, MoreHorizontal, PanelRight, TriangleAlert } from "lucide-react-native";
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
import { elapsed, minutesSince, statusLabel } from "~/api/view";
import { useDiff, useSession, useSessions, why } from "~/data";
import { childrenElsewhere, group, placeOf, runAt, type Workspace } from "~/api/workspaces";
import { AgentMark } from "~/ui/AgentMark";
import { Approval } from "~/ui/Approval";
import { Changes } from "~/ui/Changes";
import { Composer } from "~/ui/Composer";
import { Sheen } from "~/ui/Sheen";
import { Signal } from "~/ui/Signal";
import { Transcript } from "~/ui/Transcript";
import { Overview } from "~/ui/Overview";
import { ImagesFrom } from "~/ui/WorkspaceImage";
import { Waiting } from "~/ui/Waiting";
import { usePose } from "~/ui/pose";
import { useTheme } from "~/design/theme";

/**
 * Resolving the address before anything reads it.
 *
 * The id in the address is a *workspace*; a transcript belongs to a *session*.
 * The first run of a workspace carries the workspace's own id, so the list is
 * what resolves one to the other — and until it has loaded there is no session
 * to follow.
 *
 * **And the address may name a run instead.** That is what a Team row hands
 * over: the desk links a member to `/sessions/<id>` and the phone has no such
 * route, so the session id arrives here and `placeOf` finds the workspace
 * holding it. `runAt` then puts *that* run on screen rather than whichever
 * one speaks for the place — otherwise three subagents sharing one checkout
 * would all open the same transcript, which is the same dead row by another
 * name.
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
    const places = groups.flatMap(([, inRepo]) => inRepo);
    /* A run that has ended is in no place's `runs` any more, so its id alone
       finds nothing. Its `workspaceId` outlives it and the unfiltered list
       still carries it, which is what `belongsTo` is for. */
    const named = sessions.find((s: Session) => s.id === id);
    return placeOf(places, id, named?.workspaceId) ?? null;
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

  return <Conversation place={place} address={id} />;
}

function Conversation({ place, address }: { place: Workspace; address: string }) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const edges = useEdges({ gutter: BLEED });
  const scroller = useRef<ScrollViewInstance>(null);
  const [atEnd, setAtEnd] = useState(true);

  /* The run the address named, or the one that speaks for the place when it
     named the place. */
  const speaker = runAt(place, address);
  /**
   * What the page is called, when the address named a run rather than a place.
   *
   * A subagent started in the manager's own checkout carries the *workspace's*
   * name, so three of them under one header read as the same page three
   * times — and tapping `Token audit` to arrive somewhere called `Quota band
   * thresholds` looks exactly like the wrong row opened. Its `title` is the
   * only field that says which agent this is, which is why the Team row shows
   * that one too: the page should be called what the row that opened it said.
   *
   * Only for an address that named a run. A workspace opened from a list is
   * asking for the workspace and keeps its name.
   */
  const asked = speaker.id === address && speaker.id !== place.id;
  const sharing = asked && !!speaker.parentId && place.runs.some((r) => r.id === speaker.parentId);
  const heading = sharing ? speaker.title || place.name : place.name;
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
  /* How many agents this workspace started elsewhere. Only the menu wants it,
     and only for the question it asks before ending the place — those agents
     go with it, and their rows are folded under this one on both lists, so
     the question is the last place anybody is told. */
  const delegated = useMemo(() => {
    const places = group(sessions.filter((s: Session) => s.status !== "Ended")).groups.flatMap(
      ([, inRepo]) => inRepo,
    );
    return childrenElsewhere(place, places).length;
  }, [sessions, place]);
  const managerId = above?.id ?? speaker.id;
  const team = useMemo(() => sessions.filter((s: Session) => s.parentId === managerId), [sessions, managerId]);
  /**
   * Where the overview goes, which is three answers and not two.
   *
   * The conversation is never squeezed — that is the whole rule, and the
   * widths decide which way of keeping it applies:
   *
   * - **push**, under 600. There is no room for a panel at all; it is its own
   *   screen, one back-gesture away. The phone at 390 and the Duo's front
   *   panel at 466.
   * - **float**, from 600. Wide enough to want the panel, too narrow to
   *   split. It comes over the top and the conversation keeps its full width
   *   underneath, and the scrim dismisses it. The Duo's inner display in
   *   portrait: 669, which lays out in 595.
   * - **dock**, from 840 of *laid-out* width. Room for both, so the panel
   *   sits beside and the conversation still clears its measure. The Duo's
   *   inner display in landscape: 951, laying out in 877, column 317.
   *
   * Collapsible in both of the last two, from one control, so rotating the
   * device never changes what the button does — only where the panel lands.
   *
   * **The arithmetic is in `measure.ts` and measured by `usePose`**, not
   * written here. This read `width >= 820` against the *window*, which is the
   * dock question answered about the wrong box and ~90pt early; and the panel
   * was `Math.min(340, Math.max(280, width - 400))`, which is `panelWidth`
   * with 400 standing in for `READING` and **no floor test** — so it returned
   * 280 at widths where 280 does not fit.
   */
  const pose = usePose();
  const rail = pose.band;

  /* Docked starts open because it costs the conversation nothing it needs;
     floated starts closed because it costs the conversation all of it.

     `null` until somebody presses the control, and then it is their answer —
     which is what carries across a fold. Arriving at a *width* changes
     neither. */
  const [railChoice, setRailChoice] = useState<boolean | null>(null);
  const railOpen = railChoice ?? pose.docked;

  /* A floated panel takes nothing from the conversation, so the two are
     different numbers rather than one with a special case. */
  const panel = pose.docked ? pose.panel : pose.floating;
  const beside = pose.docked && railOpen;
  const floating = rail === "float" && railOpen;

  /**
   * The artifacts around this workspace, which is two sets rather than one.
   *
   * Owned by a person rather than by the workspace — `reclaim.rs` deletes a
   * workspace within a minute of its last session ending and the cascade
   * takes the conversation with it, so these rows deliberately sit outside
   * it. That is why they are fetched separately rather than folded into the
   * conversation.
   *
   * `artifacts` is the whole family's and belongs to `Overview`: the panel's
   * list is the index of everything this team produced, and a member's card
   * is one tap from the manager's page there.
   *
   * `mine` is the transcript's, and it is narrower because the transcript
   * says *when*. Anchoring is done by `firstSeenLine`, which is a position in
   * the producing session's own log — so a member's line read against these
   * rows lands somewhere arbitrary and confident, and left unanchored it
   * piles up at the end of the conversation, which is the symptom that was
   * reported, in the sessions that have the most artifacts. The desk shows
   * `fromSessionId === session.id` here for the same reason.
   */
  const { data: everyArtifact } = useListArtifacts();
  const family = useMemo(() => new Set([managerId, ...team.map((t) => t.id)]), [managerId, team]);
  const artifacts = useMemo(
    () => (everyArtifact ?? []).filter((a) => a.fromSessionId && family.has(a.fromSessionId)),
    [everyArtifact, family],
  );
  /* One line, and the one to take out if a member's card should be anchored
     here after all — there is no field on the phone today linking a task to
     the session that ran it, so anchoring one properly is its own piece of
     work rather than a wider filter. */
  const mine = useMemo(
    () => artifacts.filter((a) => a.fromSessionId === speaker.id),
    [artifacts, speaker.id],
  );

  const { conversation, echo, unecho, settle, unsettle, remember, stopping, reread, older } =
    useConversation(speaker.id);
  const [rereading, setRereading] = useState(false);
  /**
   * What the server refused or never heard, in words.
   *
   * Every mutation on this screen writes optimistically first — the message
   * appears, the approval card goes, the composer says stopping — and until
   * now **none of them had an `onError`**. A failed answer looked answered, a
   * failed send looked sent, and a failed interrupt said stopping for ever.
   * On a phone that is not an edge case: it is any dropped connection.
   *
   * So each one rolls its optimistic write back and says so here. One line,
   * because the detail that matters is *which* action did not happen.
   */
  const [trouble, setTrouble] = useState<string | null>(null);
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
    setTrouble(null);
    send.mutate(
      { id: speaker.id, data: { text, images } },
      {
        onError: (e) => {
          /* The bubble came back off, so the transcript does not claim a
             message the agent never got. The text is gone from the composer
             by now, so it is quoted here rather than silently lost. */
          unecho(text);
          setTrouble(`That message was not sent — ${why(e)}`);
        },
      },
    );
    setTimeout(() => scroller.current?.scrollToEnd({ animated: true }), 60);
  };

  /* A file goes into the workspace rather than into the message: the agent
     has its own tools for reading one, and sending the bytes twice is waste. */
  const carry = async (name: string, data: string) => {
    setTrouble(null);
    try {
      await attach.mutateAsync({ id: speaker.id, data: { name, data } });
    } catch (e) {
      /* Nothing optimistic to roll back — the file was never shown as
         attached — but silence here means somebody sends a message about a
         file the workspace has not got. */
      setTrouble(`${name} was not attached — ${why(e)}`);
      throw e;
    }
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
      /* The same route the Workspaces list and the home push — addressed by
         the member's session rather than its workspace, which is the only
         part a team row does differently. */
      onOpenSession={(to) => router.push(`/workspace/${to}`)}
    />
  ) : null;

  return (
    /* `onLayout` is how the band knows which box it is deciding about. On
       the Duo the system rail insets this view, so its width is the laid-out
       width the dock test wants — measured rather than assumed. */
    <View
      className="flex-1 bg-ground"
      onLayout={pose.onLayout}
      style={edges}
    >
      <View className="flex-row items-center gap-1 border-b border-line-soft px-1 pb-2.5 pt-1">
        <Pressable onPress={() => router.back()} className="h-10 w-10 items-center justify-center" hitSlop={8}>
          <ChevronLeft color={color.bone} size={22} />
        </Pressable>

        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="font-medium text-title text-bone">
            {heading}
          </Text>
          <View className="mt-0.5 flex-row items-center gap-1.5">
            <Signal status={speaker.status} size={6} />
            <Text className="font-sans text-meta text-dim">{statusLabel(speaker.status)}</Text>
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
              ? router.push({ pathname: "/workspace/overview", params: { id: speaker.id } })
              : setRailChoice(!railOpen)
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
             could be visible.

             **Index 1, not 0, and that is the whole of it.** The scroller
             anchors on the first subview at or past the reader's offset and
             moves the offset by however far that same view moved. History is
             inserted at the head of the *rows*, so anything above them — the
             branch, the bring-up, the spinner, a card published before the
             window — never moves, and anchoring on one of those computes a
             correction of zero: the page lands on top of the reader instead
             of above them, and since the offset is then still near the top
             `older()` fires again. Measured at 6,800pt and five pages from
             one flick, with a card above the window as the anchor. Starting
             at 1 says never anchor above the transcript, always anchor on a
             row. It holds because `Transcript` draws all of that leading
             content as exactly one subview — which is what `lead` is for. */
          maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
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
          {/* Which workspace the pictures in the agent's prose are read from.
              Without this a `![shot](docs/shot.png)` has nowhere to look. */}
          <ImagesFrom.Provider value={{ session: speaker.id }}>
            <Transcript
              items={conversation.items}
              tasks={conversation.tasks}
              /* This session's own, placed by `firstSeenLine`. The family's
                 set stays with `Overview`, above. */
              artifacts={mine}
              /* Everything that belongs above the conversation, handed over
                 rather than drawn here, so it joins the cards published
                 before the window inside the transcript's single leading
                 subview. That is what lets the scroller above say
                 `minIndexForVisible: 1` and mean "anchor on a row" — see the
                 note on it. Drawn here they were four more subviews above the
                 insertion point, and any of them under the reader's thumb
                 when a page landed was a correction of zero. */
              lead={
                <>
                  <Text className="mb-3 font-mono text-meta text-mute">
                    {speaker.branch ?? place.branch}
                  </Text>

                  {/* The bring-up sits above the transcript and scrolls away once
                      the agent is talking, which is the right amount of attention
                      for it. */}
                  <Bringup lines={bringup} />

                  {/* The history arriving. Sits above the transcript because that
                      is where it is going, and says nothing when there is nothing
                      left to read — a conversation short enough to arrive whole
                      should never show a hint that it was cut. */}
                  {conversation.loadingOlder ? (
                    <View className="items-center py-3">
                      <ActivityIndicator size="small" color={color.mute} />
                    </View>
                  ) : null}

                  {/* Why there is nothing to read, when there is nothing to read.
                      Inverted from a branch that wrapped the transcript, because
                      the transcript below now draws the artifact cards too and has
                      to be reached whether or not a conversation arrived — an
                      artifact is owned by a person and outlives the workspace that
                      made it, so a session whose transcript has gone can still have
                      published one. `place` sends every card to the end when there
                      is no row to anchor it to, which is this case. */}
                  {conversation.items.length === 0 ? (
                    conversation.trouble ? (
                      <Text className="mt-2 font-sans text-meta text-brick">
                        {conversation.trouble}
                      </Text>
                    ) : !conversation.arrived ? (
                      /* Before this branch existed the fall-through below ran
                         while the snapshot was still crossing the wire, so a
                         conversation that was merely long was reported as one that
                         had never happened. An empty transcript is only empty once
                         something has come back to say so. */
                      <Waiting say="Loading the conversation" />
                    ) : bringup.some((l) => l.state !== "pending") ? null : (
                      /* Nothing said and nothing coming up: a workspace that is
                         simply waiting for you to open the conversation. */
                      <Text className="mt-2 font-sans text-meta text-mute">
                        Nothing has been said yet.
                      </Text>
                    )
                  ) : null}
                </>
              }
              onOpenArtifact={(id) => router.push({ pathname: "/workspace/artifact", params: { id } })}
            />
          </ImagesFrom.Provider>

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
          delegated={delegated}
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
        acp={speaker.agent === "KimiCode" || speaker.agent === "CursorAgent"}
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
          setTrouble(null);
          interrupt.mutate(
            { id: speaker.id },
            {
              onError: (e) => {
                /* Otherwise the button stays "stopping" for ever over an agent
                   that is still working. */
                stopping(false);
                setTrouble(`It is still working — ${why(e)}`);
              },
            },
          );
        }}
        // Only to somebody who may act here. The composer is already gone for a
        // viewer, and these ride above it — an approval is the one control
        // where being drawn and refused is worst: the agent is stopped, asking
        // whether it may do something on the owner's machine.
        above={[
          /* Above the composer, with the approvals, because that is where the
             action was taken. A rollback nobody sees is still silent. */
          trouble ? (
            <Pressable
              key="trouble"
              testID="trouble"
              onPress={() => setTrouble(null)}
              className="mx-3 mb-2 flex-row items-center gap-2.5 rounded-field border border-brick-deep bg-brick-tint px-4 py-3"
            >
              <TriangleAlert color={color.brick} size={16} />
              <Text className="min-w-0 flex-1 font-sans text-meta text-text">{trouble}</Text>
            </Pressable>
          ) : null,
          ...conversation.asked.map((a) => (
          <Approval
            key={a.req}
            asked={a}
            onAnswer={(yes) => {
              /* Optimistic, deliberately — an approval that waits on a round
                 trip feels broken. The rollback is what makes that safe. */
              settle(a.req);
              setTrouble(null);
              answer.mutate(
                {
                  id: speaker.id,
                  data: {
                    req: a.req,
                    decision: yes ? { decision: "Allow" } : { decision: "Deny", reason: null },
                  },
                },
                {
                  onError: (e) => {
                    /* The agent is still stopped and still holding the tool
                       call open. Putting the card back is the only thing that
                       says so. */
                    unsettle(a);
                    setTrouble(`That answer did not reach the agent — ${why(e)}`);
                  },
                },
              );
            }}
          />
          )),
        ]}
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
            onPress={() => setRailChoice(false)}
            className="absolute bottom-0 left-0 right-0 top-0"
            /* `--color-scrim`, like the four other scrims in the app. This was
               `rgba(0,0,0,0.45)` — dark's value, frozen into light, where the
               token is `rgb(22 22 23 / 0.34)`. A scrim is its own token
               precisely because it is not a surface at an alpha: over a pale
               page a dark wash is still what the page recedes into, and that
               is the half a surface colour cannot express. */
            style={{ backgroundColor: color.scrim }}
          />
          <View
            className="absolute bottom-0 right-0 top-0 border-l border-line bg-float"
            style={{
              width: panel,
              /* 46 in the drawing — a floated panel is a popover by the test
                 that picks between the two backdrops: the conversation stays
                 on screen behind it and is exactly what you read it against. */
              zIndex: 46,
              /* A shadow is a light-theme device: below ~1% luminance there
                 is nothing under a surface to cast into. It is kept because
                 where it overlaps something lighter it does register, but
                 what draws the boundary in dark is the `float` fill and the
                 hairline — not this. */
              shadowColor: "#000",
              shadowOpacity: 0.5,
              shadowRadius: 18,
              shadowOffset: { width: -8, height: 0 },
            }}
          >
            <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>{overview}</ScrollView>
          </View>
        </>
      ) : null}
      </View>
    </View>
  );
}
