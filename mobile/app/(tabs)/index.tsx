/**
 * The home, which was the Inbox.
 *
 * The desk's four things, in the phone's order: a **greeting**, *agents
 * waiting for you*, *recent artifacts*, and the composer **pinned to the
 * foot**. The desk puts its box under the greeting because a cursor belongs
 * where the eye lands and a mouse reaches everywhere equally. A thumb does
 * not, so here the box goes where the thumb already rests and the two
 * sections take the room it leaves — which also lifts the only answer to
 * *what is waiting* out of the bottom third, where it used to sit 58% down.
 *
 * ## What this stopped doing, and why each one went
 *
 * - **The repository grouping.** It answered *what is this project doing*,
 *   which is a desk question. On a phone the question is *what wants me*, and
 *   grouping by repository buries the two rows that do against eleven that do
 *   not. Coverage §8 settles it: lose it.
 * - **The filter.** `All / Waiting / Working / Idle` is the dashboard's
 *   vocabulary and it was four controls to answer a question the order
 *   already answers. Ranked and labelled where the order turns, not filtered
 *   and not grouped — the docked column's list is `banded`, which is one
 *   order with a label in it and no sections. See `workspaces.tsx`.
 * - **The ember tint on a row.** Ember is the only loud thing on screen and it
 *   answers one question. A filled peach row spends it on a surface; the dot
 *   spends it on the mark, which is what it is for. The glyph stays.
 * - **The `+`.** The screen it opened is the screen you are already on.
 * - **Its own name as a heading.** A tab that says Dashboard above a page that
 *   says Inbox is the cheapest kind of incoherence; the greeting is better
 *   than either, because it is the only line on the screen that is about the
 *   person rather than about the software.
 *
 * ## The seven states
 *
 * All seven in coverage §3 are this one component with different data, which
 * is the point — `home` in the prototype is a parameter, not a screen. They
 * are: both sections, typing, nothing waiting, nothing at all, seeded from a
 * task, no repository, and not answering.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { BLEED, useEdges, useRail } from "~/ui/edges";
import Animated from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { router, useFocusEffect } from "expo-router";
import { ChevronRight, Clock } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { getListSessionsQueryKey, useCreateSession } from "~/api/generated/sessions/sessions";
import { useAgentControls } from "~/api/generated/agents/agents";
import { useListArtifacts } from "~/api/generated/artifacts/artifacts";
import { useListSchedules } from "~/api/generated/schedules/schedules";
import type { Agent, Control, ControlKind, Session } from "~/api/generated/model";
import { banded, childrenElsewhere, fleetLine, group, lead, useSettled, useVanished, type Workspace } from "~/api/workspaces";
import { elapsed, minutesSince, needsYou } from "~/api/view";
import {
  repoLabel,
  resolveStart,
  runLabel,
  seededSettings,
  type StartAs,
} from "~/api/start";
import { useAccounts, useAgents, useAgentTeams, useHosts, useProfiles, useRepos, useSessions, why } from "~/data";
import { takeConnected } from "~/workspace/connected";
import { useServer } from "~/native/current";
import { ServerChip } from "~/ui/ServerChip";
import { ArtifactCard } from "~/ui/ArtifactCard";
import { useAnswering } from "~/api/answering";
import { BandLabel } from "~/ui/BandLabel";
import { useEndWorkspace } from "~/ui/end";
import { Peek, usePeekable } from "~/ui/Peek";
import { Picker } from "~/ui/Picker";
import { ProfileSheet } from "~/ui/ProfileSheet";
import { RunSheet } from "~/ui/RunSheet";
import { Servers } from "~/ui/Servers";
import { Unreachable } from "~/ui/Unreachable";
import { WorkspaceRow } from "~/ui/WorkspaceRow";
import { StartBox, type Chip, type Pick_ } from "~/ui/StartBox";
import { Waiting } from "~/ui/Waiting";
import { COLUMN, dottedChips, posterColumns } from "~/ui/measure";
import { usePose } from "~/ui/pose";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

/**
 * Late night takes *Good evening* rather than a fourth greeting.
 *
 * A greeting is a salutation, not a clock. Three is what a person would say.
 */
function partOfDay(now = new Date()): "morning" | "afternoon" | "evening" {
  const h = now.getHours();
  return h < 5 ? "evening" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

const GREETING = {
  morning: "Good morning",
  afternoon: "Good afternoon",
  evening: "Good evening",
} as const;

/** One waiting agent, as a chip you can hold. */
function WaitingChip({
  place,
  onOpen,
  onPeek,
}: {
  place: Workspace;
  onOpen: () => void;
  onPeek: () => void;
}) {
  const speaker = lead(place);
  const { gesture, pressed } = usePeekable(onPeek, onOpen);

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        testID="waiting-chip"
        accessibilityRole="button"
        className="h-11 flex-row items-center gap-2.5 rounded-full bg-raise px-4"
        style={pressed}
      >
        {/* The ember dot, and it is the only saturated thing on the screen. */}
        <View className="h-2 w-2 rounded-full bg-ember" />
        <Text numberOfLines={1} className="max-w-[190px] font-sans text-bone" style={{ fontSize: size.body }}>
          {place.name}
        </Text>
        <Text className="font-sans text-meta text-mute">{elapsed(minutesSince(speaker.updatedAt))}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

function Heading({ text, all }: { text: string; all?: () => void }) {
  const { color } = useTheme();
  return (
    <View className="flex-row items-baseline gap-2.5 px-5 pb-2.5 pt-5">
      <Text className="font-medium text-dim" style={{ fontSize: size.meta }}>
        {text}
      </Text>
      {all ? (
        <>
          <View className="flex-1" />
          <Pressable onPress={all} hitSlop={8} className="flex-row items-center gap-0.5">
            <Text className="font-sans text-ui text-dim">View all</Text>
            <ChevronRight color={color.dim} size={14} />
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

export default function Home() {
  const { color } = useTheme();
  const edges = useEdges({ gutter: BLEED });
  const pose = usePose();
  const rail = useRail();
  const here = useServer();
  const cache = useQueryClient();

  const { data: sessions, loading, error } = useSessions();
  const { data: repos, loading: findingRepos } = useRepos();
  const { data: agents, loading: findingAgents } = useAgents();
  const { data: hosts, loading: findingHosts } = useHosts();
  const { data: accounts, loading: findingAccounts } = useAccounts();
  const { data: profiles } = useProfiles();
  const { data: teams } = useAgentTeams();
  const { data: artifacts = [] } = useListArtifacts();
  const schedules = useListSchedules();
  const create = useCreateSession();

  const [draft, setDraft] = useState("");
  const [peeking, setPeeking] = useState<string | null>(null);
  const [servers, setServers] = useState(false);

  const live = sessions.filter((s: Session) => s.status !== "Ended");
  const { groups } = useMemo(
    () => group(live),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live.map((s: Session) => s.id + s.status).join()],
  );
  /* Flat and ranked, not grouped by repository. `group` is still what knows
     how to assemble a workspace out of its runs — that fold is shared with
     the other two clients — so this takes its output and throws the
     *repository* grouping away rather than re-deriving what a workspace is. */
  const places = useMemo(() => groups.flatMap(([, inRepo]) => inRepo), [groups]);
  /* The docked column's rows, which are the destination's rows — one call to
     `banded`, shared, so the preview and the place cannot come to disagree
     about the order or about which band a row reads under. A Duo rotating
     from 669 to 951 reveals a column; it must not reveal a list that reads
     differently.

     Still one continuous order with a label where the band turns, and still
     not sections — see `workspaces.tsx`, which carries that argument, and
     `banded`, which is handed the whole fleet because a family cannot be read
     out of a list its children have been taken out of. */
  const rows = useMemo(() => banded(places), [places]);
  /* **Off `places`, not off `rows`.** A chip in *Agents waiting for you* can
     be held too, and a blocked child has a chip and no row — so what is
     peekable here is every workspace and not only the ones with rows. */
  const peeked = places.find((p) => p.id === peeking) ?? null;
  const close = useCallback(() => setPeeking(null), []);
  /* A workspace that ends elsewhere takes its peek away by unmounting it, so
     nothing dismisses it and the id stays set. Let it go, or the hold below
     has nothing left to end it. */
  useVanished(peeking, peeked, close);
  /* And it holds its order while a row is held, for the same reason and in
     the same window: the peek a press becomes. **`peeked`, not `peeking`** —
     a hold on an id that no longer names anything never releases, and the
     list stays in last week's order with nothing on screen to dismiss. */
  const shown = useSettled(rows, peeked !== null);

  /* Blocked, not `needsYou`. The wider grouping also covers finished and
     broken, which belong on the list but are not the thing that is asking —
     and a chip is an invitation to answer.

     Still every workspace rather than the drawn rows: a chip is how a waiting
     agent is reached from the home, and a child with no row needs one more,
     not fewer. */
  const blocked = places.filter((p) => p.runs.some((r) => r.status === "NeedsYou"));
  const fits = dottedChips(pose.content);
  const dotted = blocked.slice(0, fits);
  const rest = blocked.length - dotted.length;

  const cols = posterColumns(pose.content, pose.docked);
  const posters = artifacts.slice(0, cols);

  const noRepo = repos.length === 0;

  /**
   * **The session id, not the workspace id.**
   *
   * `Workspace.id` is `session.workspaceId ?? session.id` — so for anything
   * that belongs to a workspace it is the *workspace's* id, and the routes
   * below want a *session's*. Passing `peeked.id` to the conversation meant
   * asking for one that does not exist, which is how the peek once drew an
   * ember dot over buttons that never arrived.
   *
   * `lead()` is what picks the run whose transcript a person means, and it is
   * what `[id].tsx` opens against. The peek has to agree with the screen it is
   * a preview of, or it opens a different session than the one it is showing.
   */
  const blockedRun = peeked?.runs.find((r) => r.status === "NeedsYou");
  /* **The blocked run, not the lead.** `lead()` answers "whose transcript do
     I open" and reports the *busy* run when a workspace has one running
     beside one that is stopped — so it is the wrong target for a question.
     The run that is asking is the run to read and the run to answer.

     This place's own, deliberately: it is what *What it changed* opens, and a
     parent's diff is the parent's. The family's questions are `useAnswering`,
     which is a different question with a different answer. */
  const speakerId = peeked ? (blockedRun?.id ?? lead(peeked).id) : null;
  const answering = useAnswering(peeked, places);

  /* The same teardown the workspace's own menu asks for, asked from the row —
     and the count beside the label is the number that goes with it. `places`
     is the whole list, children included, because only the whole list knows
     which ones are this one's. */
  const endWorkspace = useEndWorkspace();
  const endPeeked = useCallback(() => {
    if (!peeked) return;
    void endWorkspace(peeked, childrenElsewhere(peeked, places).length);
  }, [endWorkspace, peeked, places]);

  const refresh = useCallback(
    () => cache.invalidateQueries({ queryKey: getListSessionsQueryKey() }),
    [cache],
  );

  /**
   * ## Starting work, in place
   *
   * Everything below used to be a push to `/new`. The form asked six
   * questions and five of them have an obvious answer, so what is held here
   * is only what somebody has actually chosen — each empty until they do —
   * and `resolveStart` turns that plus the server's lists into the whole
   * launch. See `~/api/start`, which is where the rules are, and where they
   * can be tested.
   */
  const [sheet, setSheet] = useState<null | "repo" | "host" | "profile" | "run">(null);
  const [repoIds, setRepoIds] = useState<string[]>([]);
  const [hostId, setHostId] = useState("");
  const [agentKind, setAgentKind] = useState("");
  const [accountId, setAccountId] = useState("");
  /* **One selection, not two.** A profile and a team are mutually exclusive:
     a team names its lead's profile on the server, and a team beside a
     different profile is refused there. */
  const [startAs, setStartAs] = useState<StartAs>(null);
  const [chosen, setChosen] = useState<Partial<Record<ControlKind, string>>>({});

  /* **The repository does not default, and it is the one thing here that
     does not.** The machine, the agent and the account are all resolvable —
     a wrong guess there is corrected before anything runs — but checking out
     a repository somebody did not name is work done in the wrong place. The
     chip is an invitation until it is answered, which is what the desk does
     too. The shipped chip *read* `repos[0].slug` while sending nothing; it
     now says what is true. */

  /* The profile somebody marked default, once — so changing it here
     afterwards sticks. The desk does exactly this. */
  const defaulted = useRef(false);
  useEffect(() => {
    if (defaulted.current || profiles.length === 0) return;
    defaulted.current = true;
    const def = profiles.find((p) => p.isDefault);
    if (def) setStartAs({ kind: "profile", id: def.id });
  }, [profiles]);

  /* Whatever was just connected on `/repos`, chosen here — the repository is
     the reason anybody leaves this screen for that one. `new.tsx` has the
     same hook for the same reason; `workspace/connected.ts` is why it is
     taken once. */
  useFocusEffect(
    useCallback(() => {
      const made = takeConnected();
      if (made.length === 0) return;
      setRepoIds((was) => [...was, ...made.filter((id) => !was.includes(id))]);
    }, []),
  );

  /* One refusal is worth rewording: `NoCapacity` says in a code what its
     message does not say in words, and it is the one people meet. */
  const refused = create.isError
    ? (create.error as { code?: string })?.code === "NoCapacity"
      ? "No host is available to take this."
      : why(create.error)
    : null;

  const start = resolveStart({
    draft,
    chose: { startAs, repoIds, hostId, agentKind, accountId },
    profiles,
    teams,
    repos,
    hosts,
    agents,
    accounts,
    refused,
  });

  /* Model, effort, permissions and sandbox — the same pickers a conversation
     offers, fed what Firetower knows about this engine before one is
     running. Which pickers exist is the agent's business, not ours. */
  const kind = start.agent?.kind;
  const controlsQ = useAgentControls(kind ?? "", { query: { enabled: !!kind } });
  const controls = (kind ? (controlsQ.data ?? []) : []) as Control[];
  /* A fresh set each time the engine or the profile changes: a model is one
     agent's, so carrying one across would seed a picker with a value it
     cannot offer. Seeded from what the profile pins, when it pins for this
     engine — and still changeable before you send. */
  useEffect(() => {
    setChosen(seededSettings(start.profile, (kind as Agent) ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, start.profile?.id]);
  const valueOf = useCallback(
    (c: Control) => chosen[c.kind] ?? c.current ?? undefined,
    [chosen],
  );
  const modelLabel = (() => {
    const model = controls.find((c) => c.kind === "model");
    if (!model) return undefined;
    return model.choices.find((k) => k.value === valueOf(model))?.label;
  })();

  /**
   * Whether this screen is still the one on screen when the create answers.
   *
   * It pushes the workspace on success, and somebody who has moved on — to
   * another tab, or to another Firetower, which unmounts the whole tree —
   * should not be pulled onto a workspace they stopped waiting for. The
   * workspace is made either way, which is the other half of why this is
   * `mutateAsync` and not `mutate`: react-query drops the callbacks passed to
   * `mutate` once the caller has gone, so what was typed would have gone
   * nowhere with nobody told. The desk carries the same hazard and the same
   * answer.
   */
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  const go = () => {
    if (!start.ready || !start.agent) return;
    void create
      .mutateAsync({
        data: {
          name: start.name,
          /* **What you typed is the first message.** The form sends no
             prompt and that is still right — see the head of `new.tsx` — but
             this is a composer, and a composer that fills its ↑ and then does
             not send is the most surprising control a phone can draw. */
          prompt: draft.trim() || undefined,
          repos: start.repos.map((r) => ({ repoId: r.id })),
          agent: start.agent.kind,
          /* **One of the two, never both.** A team names its lead's profile
             on the server; sending the profile as well would be the
             contradiction `create_session_as` refuses, and sending only the
             profile would start it bare with no reach — which is exactly the
             difference the sheet just made visible. */
          profile: startAs?.kind === "profile" ? startAs.id : undefined,
          team: startAs?.kind === "team" ? startAs.id : undefined,
          accountId: start.account?.id,
          branch: start.branch,
          hostId: start.host?.id,
          settings: {
            model: chosen.model,
            effort: chosen.effort,
            mode: chosen.mode,
            sandbox: chosen.sandbox,
          },
        },
      })
      .then((made) => {
        const s = made as { id: string; workspaceId?: string | null };
        /* Emptied, because this screen is still mounted under the one being
           pushed: coming back to a composer holding a sentence that has
           already been sent is how the same work gets started twice. The desk
           navigates away from its own composer and never has to. */
        setDraft("");
        if (onScreen.current) router.push(`/workspace/${s.workspaceId ?? s.id}`);
      })
      .catch(() => {
        /* Said above the card, off the mutation's own state — which
           `mutateAsync` records exactly as `mutate` does. Swallowed here
           because an unhandled rejection is not a second way of telling
           anybody. */
      });
  };

  /* The decisions that are genuinely unmade, and **where** the work happens:
     a repository and a machine. Both resolve in a sheet over this screen. */
  const chips: Chip[] = [
    {
      id: "repo",
      label: repoLabel(start.repos, repos.length),
      icon: "repo",
      want: start.repos.length === 0,
      onPress: () => setSheet("repo"),
    },
    {
      id: "host",
      label: start.host?.name ?? "No machine",
      icon: "host",
      want: !start.host,
      onPress: () => setSheet("host"),
    },
  ];

  const header = (
    /* `z-index: 20` in the drawing, the same rung as the composer:
       both are chrome the content scrolls under, and both have to sit
       above it to do that.

       **`pt-0.5` stays, and it is 2 pt on top of the root's own air rather
       than instead of it.** It was the whole of the air above this chip on
       any surface that reserves nothing — the Duo's inner display sat the
       server chip 2 pt from the frame — and the fix for that is `TOP_AIR` in
       `edges.ts`, a floor on the root's resolved total, because fourteen
       screen roots go through that hook and only one of them is this one.
       Raising the 2 here instead would have fixed the home and left Tasks,
       Artifacts, You and Workspaces exactly as they were. */
    <View className="flex-row items-center px-2 pb-2 pt-0.5" style={[COLUMN, { zIndex: 20 }]}>
      <ServerChip
        org={here?.org ?? "—"}
        reach={error ? "unreachable" : "live"}
        onPress={() => setServers(true)}
      />
    </View>
  );

  /* **Not answering.** Said as its own screen rather than as an empty list —
     see `Unreachable`, which the Workspaces destination draws too. */
  if (error && live.length === 0) {
    return (
      <View
        className="flex-1 bg-ground"
        onLayout={pose.onLayout}
        style={edges}
      >
        {header}
        <Unreachable org={here?.org ?? "That server"} onRetry={refresh} />
        {servers ? <Servers onClose={() => setServers(false)} /> : null}
      </View>
    );
  }

  /* A proposal nobody has looked at, or a schedule Firetower stopped. Both
     want a decision, which is what the count means. */
  const schedulesWaiting = (schedules.data ?? []).filter(
    (s) => (s.made.byAgent && !s.approvedAt) || (!s.active && !!s.pausedReason),
  ).length;

  const bare = noRepo;
  const greeting = bare
    ? "Nothing to cut from yet."
    : `${GREETING[partOfDay()]}, what should we work on?`;

  /* The greeting scrolls. It is a salutation, read once on arrival, and
     pinning it would spend on a fixed line the space the sections want. At
     390 nothing scrolls in the resting state anyway, so the choice only bites
     once there is more to show — which is exactly when the sections are what
     you want on screen.

     44 of air above it, not the desk's 192. The same *proportion* of a 390pt
     phone would be 194pt of nothing on the scarce axis and the page would not
     then fit. */
  /* **The greeting stops holding it open** once there is nothing under it.
     The 44 of air is there to let the greeting breathe *above the sections*;
     with no sections it is 44pt of nothing on the scarce axis, holding a
     salutation away from the only other thing on screen. Two states collapse
     it — no repository at all, and a repository with nothing waiting and
     nothing made. */
  const nothing = dotted.length === 0 && posters.length === 0;
  const head = (
    <View
      className="px-5 pb-5"
      style={{
        minHeight: bare || nothing ? 0 : 44,
        paddingTop: bare || nothing ? 28 : 16,
        justifyContent: "flex-end",
      }}
    >
      <Text
        className="font-medium text-bone"
        style={{ fontSize: size.display, lineHeight: size.display * 1.16, letterSpacing: size.display * -0.024 }}
      >
        {greeting}
      </Text>
    </View>
  );

  /**
   * **The phone's way into Schedules, and there is no fifth tab.**
   *
   * Four is what `NativeTabs` presents well as a vertical rail on the Duo,
   * and a fifth would be paid for on every pose to reach a destination most
   * people open weekly. So it is a 50pt row under the greeting, above the
   * section the redesign deliberately lifted out of the bottom third.
   *
   * It carries a count **only while something wants a decision** — a proposal
   * waiting to be turned on, or a schedule Firetower stopped. Not a count of
   * schedules, which would be a number that is always there and therefore
   * says nothing.
   */
  const entry = (
    <Pressable
      testID="schedules-entry"
      accessibilityRole="button"
      onPress={() => router.push("/schedules")}
      className="min-h-[50px] flex-row items-center gap-3 px-5"
      android_ripple={{ color: color.overlay }}
    >
      <Clock size={18} color={color.dim} strokeWidth={1.8} />
      <Text className="font-sans text-bone" style={{ fontSize: size.body }}>
        Schedules
      </Text>
      {schedulesWaiting > 0 ? (
        <Text className="font-sans text-mute" style={{ fontSize: size.meta }}>
          {schedulesWaiting} waiting for you
        </Text>
      ) : null}
      <View className="flex-1" />
      <ChevronRight size={17} color={color.mute} strokeWidth={1.8} />
    </Pressable>
  );

  const waiting =
    dotted.length > 0 ? (
      <View>
        <Heading text="Agents waiting for you" />
        {/* The chips scroll and **the count does not**. At 390 two chips do
            not fit side by side, and wrapping makes each one a full-width
            pill — a row wearing a chip's shape. Scrolling keeps the shape and
            costs no height, which is the scarce axis here. But *N more* is
            the mechanism that makes the ember budget legible, and at this
            width it scrolls off the end where it says nothing. So it is
            pinned outside the strip: the dotted chips scroll, the count
            stays. Two dots and one number, always both on screen. */}
        <View className="flex-row items-center gap-2 px-5 pb-0.5">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="min-w-0 flex-1"
            contentContainerStyle={{ gap: 8 }}
          >
            {dotted.map((p) => (
              <WaitingChip
                key={p.id}
                place={p}
                onOpen={() => router.push(`/workspace/${p.id}`)}
                onPeek={() => setPeeking(p.id)}
              />
            ))}
          </ScrollView>
          {rest > 0 ? (
            <Pressable
              testID="more-waiting"
              /* **`navigate`, not `push`.** Workspaces is a destination now,
                 and pushing one puts a second copy on the stack with a back
                 chevron the tab has no use for — the same screen arriving two
                 ways with two back behaviours, while the system tab bar
                 lights the wrong item. */
              onPress={() => router.navigate("/(tabs)/workspaces")}
              className="h-11 flex-row items-center rounded-full border border-line px-4"
              android_ripple={{ color: color.overlay }}
            >
              <Text className="font-sans text-dim" style={{ fontSize: size.body }}>
                {rest} more
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    ) : null;

  const made =
    posters.length > 0 ? (
      <View>
        <Heading text="Recent artifacts" all={() => router.push("/artifacts")} />
        <View className="flex-row gap-4 px-5">
          {posters.map((a) => (
            <View key={a.id} className="mt-4 min-w-0 flex-1">
              <ArtifactCard artifact={a} onOpen={() => router.push(`/workspace/artifact?id=${a.id}`)} />
            </View>
          ))}
        </View>
      </View>
    ) : null;

  /* **Nothing yet**, which is a different sentence from *nothing waiting*. A
     workspace is cut from a repository and this Firetower has none, so there
     is nothing to be waiting and nothing to have been made. */
  const under = bare ? (
    <Text
      className="px-5 pt-5 font-sans text-mute"
      style={{ fontSize: size.body, lineHeight: size.body * 1.6 }}
    >
      A workspace is cut from a repository, and this Firetower has none connected. Connecting one is
      two taps and it is the only setting a phone owns.
    </Text>
  ) : (
    <>
      {waiting}
      {made}
    </>
  );

  /* What will run, while it is still unsettled. The drawing puts these in the
     composer's control row rather than on the shelf: the shelf carries *where*
     the work happens — a repository and a machine — and these carry *what does
     it*. One sheet each, over this screen.

     **The profile is a pick and not a third chip.** A persona is not a place;
     putting it on the shelf would separate it from the engine it pins, and
     the strip already admits that two chips do not fit 390. */
  const picks: Pick_[] = [
    {
      id: "profile",
      glyph: (start.profile?.agent as Agent | undefined) ?? "person",
      label: start.profile?.name ?? "Just an agent",
      /* The team behind the lead. The lead's name leads, because that is who
         answers; the team is what stands behind it. */
      sub: start.team?.name,
      set: !!start.profile,
      onPress: () => setSheet("profile"),
    },
    {
      id: "run",
      glyph: start.agent?.kind ?? "none",
      label: runLabel(start.agent, modelLabel),
      onPress: () => setSheet("run"),
    },
  ];

  const box = (
    <StartBox
      value={draft}
      picks={picks}
      onChange={setDraft}
      onStart={go}
      starting={create.isPending}
      ready={start.ready}
      notice={start.why}
      chips={chips}
    />
  );

  /**
   * The four sheets, drawn at the root of every pose.
   *
   * They are `Modal`s, so they come from the bottom of the *screen* rather
   * than of whichever column the composer is sitting in — which is what makes
   * the 951 split free: unfolding with a sheet open re-clamps and re-centres
   * it, and nothing about a control changes. The content is clamped to
   * `COLUMN` inside `Sheet` and `Picker`.
   */
  const sheets = (
    <>
      <Picker
        open={sheet === "repo"}
        title="Repositories"
        waiting={findingRepos ? "Reading your repositories" : undefined}
        empty="No repository is connected to this Firetower yet."
        chosen={repoIds}
        choices={repos.map((r) => ({ id: r.id, label: r.slug, detail: r.remote }))}
        onPick={(id) =>
          setRepoIds(repoIds.includes(id) ? repoIds.filter((x) => x !== id) : [...repoIds, id])
        }
        onClose={() => setSheet(null)}
        /* The one thing this list cannot hold: a repository nobody has
           connected yet. Everything else a workspace needs is administered
           from a desk; a repository is what the work is *in*. */
        action={{
          label: "Connect a repository",
          onPress: () => {
            setSheet(null);
            router.push({ pathname: "/repos", params: { pick: "1" } });
          },
        }}
      />
      <Picker
        open={sheet === "host"}
        title="Where it runs"
        waiting={findingHosts ? "Reading the machines" : undefined}
        empty="No machine yet. Agents run on a machine added over ssh — a VM, a build box, a Mac. Adding one is done from the desktop app or the web console."
        chosen={start.host?.id}
        choices={hosts.map((h) => ({
          id: h.id,
          label: h.name,
          detail: `${h.cpus} vCPU · worker ${h.workerVersion ?? "—"}`,
          /* Dimmed and unchoosable, with the reason. A machine the scheduler
             cannot reach has not failed; it is not there. */
          blocked: h.state === "Online" ? undefined : `${h.state} — ${h.diagnosis ?? "not answering"}`,
        }))}
        onPick={(id) => {
          setHostId(id);
          setSheet(null);
        }}
        onClose={() => setSheet(null)}
      />
      {sheet === "profile" ? (
        <ProfileSheet
          profiles={profiles}
          teams={teams}
          startAs={startAs}
          onPick={(next) => {
            setStartAs(next);
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "run" ? (
        <RunSheet
          agent={start.agent}
          agents={agents}
          host={start.host}
          accounts={accounts}
          accountId={start.account?.id ?? ""}
          locked={start.locked}
          controls={controls}
          valueOf={valueOf}
          findingAgents={findingAgents}
          findingAccounts={findingAccounts}
          onPickAgent={(k) => {
            setAgentKind(k);
            /* The account belonged to the old agent; it cannot belong to
               this one. `new.tsx` does the same on the same event. */
            setAccountId("");
          }}
          onPickAccount={setAccountId}
          onPickControl={(k, v) => setChosen((was) => ({ ...was, [k]: v }))}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );

  const scroller = (
    <ScrollView
      className="flex-1"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ flexGrow: 1, ...COLUMN }}
      refreshControl={
        <RefreshControl refreshing={false} tintColor={color.mute} onRefresh={refresh} />
      }
    >
      {head}
      {entry}
      {loading && live.length === 0 ? (
        <View className="items-center justify-center py-20">
          <Waiting say="Reading your workspaces" />
        </View>
      ) : (
        under
      )}
      <View style={{ height: 16 }} />
    </ScrollView>
  );

  /**
   * At 951 landscape the home splits, and the measurement is why.
   *
   * It is the only pose with room for two things and the only one that is
   * *short* — 669 against the others' 844 to 951. The composer is pinned to
   * the foot of the left column, where a thumb is on a device held in two
   * hands, and the second column sits beside it rather than under it.
   *
   * The greeting **sinks to meet the box** rather than floating at the top of
   * a column with 280pt of nothing under it. It is a salutation *to the
   * composer*, so the two read as one thing; at every other pose the sections
   * fill that gap and the question does not arise.
   *
   * ## The right column is Workspaces, and that is a change
   *
   * It used to wrap `under` — the waiting chips and *Recent artifacts*, which
   * is what the single-column home puts *below* the greeting, moved sideways.
   * Below a greeting that is a section; in a 307pt column 669 tall it was two
   * posters and then roughly 1,200pt of floor.
   *
   * So it is the destination, previewed: head, count, and the one
   * status-ordered list with a label where the band turns, scrolling on its
   * own and filling the column however many there are. Which is exactly what
   * the desk does — the rail panel beside ⌘1 *is* this list, labels included.
   *
   * **The waiting chips fold into it rather than sitting above it.** The
   * order already puts what wants you first and every row already carries its
   * beat mark, so the top rows of the column, with their ember marks, *are*
   * the chips. A chip strip above a list whose first rows are the same
   * workspaces draws one object twice and spends the ember budget twice to say
   * one thing. That argument finishes with the bands: the labels are what the
   * chips' legend would have been, and *Waiting on you · 3* over those rows is
   * the strip's whole content in one line of furniture.
   *
   * **And the count line gives way to them, not the other way round.** At
   * 307pt the column has a head, a count line and three 12.5pt labels, and the
   * first label would have sat directly under a line saying nearly the same
   * thing — so the line drops its waiting clause while that label is drawn.
   * `fleetLine` carries the reason; it is not only the repetition, it is that
   * the two numbers disagree in both directions.
   *
   * **`Recent artifacts` moves to the head of the left column** rather than
   * being deleted. The alternative was to drop it here — Artifacts is its own
   * destination — and it loses on continuity: rotating from 669 to 951 would
   * make a whole section vanish, and rotating changes where a panel lands,
   * never what is on the screen. At 560 of left column its two posters are
   * 252pt each, against 167 on a 390pt phone.
   *
   * ## And the column runs to the frame
   *
   * `width: panel + rail, marginRight: -rail, paddingRight: rail` — the fill
   * and the divider reach the edge of the display while every row, press
   * highlight and timestamp stays inside the reserved 84. See `useRail`. The
   * left column is unaffected: it is still `content − panel` = 560, exactly
   * `READING_MAX`, and `pose.ts` still measures the frame.
   *
   * ## And the composer's sheets come from the bottom of the screen
   *
   * Not of the column. They are `Modal`s, so they are full width over both
   * columns and the rail, which is right: a sheet is the task, and anchoring
   * one to the left column would break on exactly the rotation it is most
   * likely to have to survive. What a column's width *does* decide is the
   * reading measure, so the rows inside clamp to `COLUMN` and centre — see
   * `Sheet` and `Picker`, which carry that change and the measurement behind
   * it.
   *
   * **Nothing a control does is pose-dependent.** The draft, the resolved
   * profile, agent, machine and account, and whichever sheet is open all live
   * in this component's state; `usePose` only re-measures. So unfolding with
   * the box half-typed keeps the words and keeps the sheet open — it
   * re-clamps and re-centres, and the only thing that moves is the box, from
   * the foot of the screen to the foot of the left column.
   */
  if (pose.docked && !bare) {
    return (
      <View
        className="flex-1 bg-ground"
        onLayout={pose.onLayout}
        style={edges}
      >
        {header}
        <View className="min-h-0 flex-1 flex-row">
          <View className="min-w-0 flex-1 flex-col">
            <ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1, justifyContent: "flex-end" }}>
              {made}
              {/* The posters sit at the head and the greeting at the foot, so
                  the 280pt the greeting used to float above is what separates
                  them rather than nothing. */}
              <View className="flex-1" />
              {head}
              {entry}
            </ScrollView>
            {box}
          </View>
          {/* `ground`, not a fill of its own: one page colour, and space
              separates the two columns — STYLE.md's rule, no cards. The
              divider is what says where the column starts. */}
          <View
            className="min-h-0 border-l border-line-soft"
            style={{ width: pose.panel + rail, marginRight: -rail, paddingRight: rail }}
          >
            {/* Its own head rather than `Heading`: this is a panel's head and
                not one of the home's sections, and at 307pt the control says
                *All* where a full-width section says *View all*. */}
            <View className="flex-row items-baseline gap-2.5 px-5 pb-1 pt-3.5">
              <Text className="font-medium text-dim" style={{ fontSize: size.meta }}>
                Workspaces
              </Text>
              <View className="flex-1" />
              <Pressable
                testID="all-workspaces"
                onPress={() => router.navigate("/(tabs)/workspaces")}
                hitSlop={8}
                className="flex-row items-center gap-0.5"
              >
                <Text className="font-sans text-dim" style={{ fontSize: size.meta }}>
                  All
                </Text>
                <ChevronRight color={color.dim} size={13} />
              </Pressable>
            </View>
            {/* The count waits for an answer. *0 in all, none waiting* over a
                list that has not arrived is the same lie the destination was
                drawing before it had a loading state — it just costs less
                here, because the left column still has the composer on it. */}
            {loading && places.length === 0 ? (
              <View className="flex-1 items-center justify-center px-5">
                <Waiting say="Reading your workspaces" />
              </View>
            ) : (
              <>
                {/* `micro` and `mute` where the destination's is `meta` and
                    `dim`, which it already was — so it now sits one step
                    quieter than the labels under it. The head names the panel,
                    the labels organise the rows, this is a footnote about the
                    fleet. */}
                <View className="px-5 pb-1.5">
                  <Text className="font-sans text-mute" style={{ fontSize: size.micro }}>
                    {fleetLine(places, shown)}
                  </Text>
                </View>
                <ScrollView
                  className="min-h-0 flex-1"
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={{ paddingBottom: 20 }}
                >
                  {shown.map((row, at) => (
                    <Fragment key={row.place.id}>
                      {row.turn ? (
                        <BandLabel says={row.turn.says} count={row.turn.count} first={at === 0} />
                      ) : null}
                      <WorkspaceRow
                        place={row.place}
                        places={places}
                        onPeek={() => setPeeking(row.place.id)}
                      />
                    </Fragment>
                  ))}
                </ScrollView>
              </>
            )}
          </View>
        </View>
        {peeked ? (
          /* **The same peek the other two poses get, including the answer.**
             This branch was passing neither `pending` nor `onAnswer`, so
             holding a row at 951 previewed a blocked run and then offered no
             way to unblock it — coverage §5's P4 failing in exactly the pose
             that has the most room for it. Now that the column is the
             workspaces list the peek is the main thing it is held for. */
          <Peek
            place={peeked}
            places={places}
            onClose={close}
            onOpen={() => router.push(`/workspace/${peeked.id}`)}
            /* Where the children went: one tap from the list before, three
               after, so the peek pays it back. */
            onChildren={() => router.push(`/workspace/overview?id=${peeked.id}`)}
            /* `repo.tsx` reads its param with `useSession`, so this is the
               session id — unlike `/workspace/{id}`, which resolves a
               workspace. Two routes, two kinds of id, one field name. */
            onChanges={() => router.push(`/workspace/repo?id=${speakerId}`)}
            asks={answering.asks}
            waiting={answering.waiting}
            onAnswer={answering.onAnswer}
            onEnd={endPeeked}
          />
        ) : null}
        {sheets}
        {servers ? <Servers onClose={() => setServers(false)} /> : null}
      </View>
    );
  }

  return (
    <View
      className="flex-1 bg-ground"
      onLayout={pose.onLayout}
      style={edges}
    >
      {header}
      {scroller}
      {box}

      {peeked ? (
        <Peek
          place={peeked}
          places={places}
          onClose={close}
          onOpen={() => router.push(`/workspace/${peeked.id}`)}
          /* Where the children went: one tap from the list before, three
             after, so the peek pays it back. */
          onChildren={() => router.push(`/workspace/overview?id=${peeked.id}`)}
          /* `repo.tsx` reads its param with `useSession`, so this is the
             session id — unlike `/workspace/{id}`, which resolves a workspace.
             Two routes, two kinds of id, one field name. */
          onChanges={() => router.push(`/workspace/repo?id=${speakerId}`)}
          asks={answering.asks}
          waiting={answering.waiting}
          onAnswer={answering.onAnswer}
          onEnd={endPeeked}
        />
      ) : null}
      {sheets}
      {servers ? <Servers onClose={() => setServers(false)} /> : null}
    </View>
  );
}
