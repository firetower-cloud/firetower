/**
 * Workspaces: the second destination, which was a pushed route.
 *
 * It began as the screen **N more** opens — and before that the chip was
 * drawn, pinned and measured with no destination at all, which is the kind of
 * dead control a reachability check walks straight past: landing on the screen
 * you started from is a legal transition rather than a thrown error.
 *
 * ## Why it is a tab and not a push
 *
 * The desk already keeps this list and already calls it *Workspaces* —
 * `desktop/src/ui/RailPanel.tsx:265` draws `<Head name="Workspaces">`, the
 * 252pt panel beside ⌘1. So the phone is not naming a concept the desk lacks;
 * it is giving a *place* to a thing the desk keeps as a *panel*, because a
 * phone has no rail to hang one off and at 390, 466 and 669 there is no width
 * to dock one into either. That is the band rule, not a preference.
 *
 * **One route, not two.** This file was `app/workspaces.tsx` and was pushed
 * from the home's *N more* chip. A push onto a destination is the
 * two-back-behaviours bug: the same screen arrives once with a chevron and
 * once without, and the system tab bar lights the wrong item. The chip now
 * does `router.navigate`, and there is no alias left at the old path.
 *
 * ## A destination is somewhere you land, so four states stop being edge cases
 *
 * A pushed route is entered deliberately, from a control that only exists when
 * there is something to open. A tab is somewhere you arrive — cold, with no
 * server, with nothing running, or straight into it from a notification. This
 * screen had **none** of them: it drew *0 in all, none waiting* over an empty
 * page when the server was unreachable, which is the lie `STYLE.md` says costs
 * the most trust.
 *
 * - **Reading them.** `Waiting`, centred — the wait *is* the screen — and
 *   nothing at all for the first 350ms.
 * - **None at all.** Only once something has come back. An empty state is a
 *   claim, and it is only true after an answer.
 * - **Not answering.** The home's own panel, `Unreachable`, rather than a
 *   second wording of it.
 * - **Holding a row.** `Peek`, which already shipped here.
 *
 * ## Every row carries a mark, in its own tone
 *
 * Ember blocked, brick broken, slate working, sage done. A list where one row
 * of three has a mark reads as *missing* rather than as restraint — so the
 * mark is on all of them and the tone is what differs. `BEAT_TOKEN` is the
 * shared fold that decides which, so the phone cannot come to disagree with
 * the desk about what a status means.
 *
 * ## Banded — which is not the sections this screen refused
 *
 * This comment used to end *flat and status-ordered, never status-grouped*,
 * and gave the reason: a workspace changes state while you are looking at it,
 * and the row you reached for jumps sections under your thumb. **The owner
 * asked for status groups anyway**, on 2026-11-12, having been told that.
 *
 * The refusal was right and this is not a reversal of it, because **there are
 * still no sections.** The desk resolves both and is what is ported:
 * `desktop/src/ui/RailPanel.tsx`'s `Listing` sorts **one continuous list**
 * with `worstFirst` and emits a label where the band *turns* — its own
 * comment says what this one said, in the same words. So a row whose state
 * changes moves *within* the one order and the labels re-land around it.
 * Nothing is re-parented, nothing collapses, and an empty band is undrawable
 * because there is no container to be empty.
 *
 * Two things close what the desk's rail leaves open, and both are in
 * `~/api/workspaces`:
 *
 * - **{@link bandOf}, never `doing`.** The family's runs, and `needsYou`
 *   tested before `inFlight` — or a parent idle in all its own agents with
 *   one blocked child under it lands under *Idle* wearing an ember dot, which
 *   is where the rail puts it today. {@link banded} takes the whole fleet for
 *   the reason the sort always did.
 * - **{@link useSettled}.** The order holds still while a row is held, so the
 *   thing the original refusal was actually about cannot happen to this list
 *   either — a flat list that re-sorts under a thumb is the same defect as a
 *   sectioned one. The position only: a row going blocked under your thumb
 *   still turns ember where it stands.
 *
 * The labels carry no colour and do not pin to the top of the scroll. The
 * row's mark is the only loud thing in this list; see {@link BandLabel}.
 */
import { Fragment, useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { BLEED, useEdges } from "~/ui/edges";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "~/api/generated/model";
import { banded, childrenElsewhere, fleetLine, group, lead, useSettled } from "~/api/workspaces";
import { useSessions } from "~/data";
import { useServer } from "~/native/current";
import { getListSessionsQueryKey } from "~/api/generated/sessions/sessions";
import { useAnswering } from "~/api/answering";
import { useEndWorkspace } from "~/ui/end";
import { BandLabel } from "~/ui/BandLabel";
import { Peek } from "~/ui/Peek";
import { Unreachable } from "~/ui/Unreachable";
import { Waiting } from "~/ui/Waiting";
import { WorkspaceRow } from "~/ui/WorkspaceRow";
import { COLUMN } from "~/ui/measure";
import { size } from "~/design/tokens.generated";

export default function Workspaces() {
  const edges = useEdges({ gutter: BLEED });
  const here = useServer();
  const cache = useQueryClient();
  const { data: sessions, loading, error } = useSessions();
  const [peeking, setPeeking] = useState<string | null>(null);

  const live = sessions.filter((s: Session) => s.status !== "Ended");
  const { groups } = useMemo(
    () => group(live),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live.map((s: Session) => s.id + s.status).join()],
  );
  /** Every workspace there is, children included. Nothing family-wide works
   *  without it — see `familyOf`. */
  const every = useMemo(() => groups.flatMap(([, inRepo]) => inRepo), [groups]);
  /**
   * The rows: parents only, in the family's order, each with the band it
   * reads under and a label where that band turns.
   *
   * **One argument, and it is the whole fleet.** `banded` ranks, filters and
   * labels in that order inside itself, because the comparator and the labels
   * have to be computed from the same list — handed the rows this screen
   * draws, `familyOf` finds no children and the two disagree. A child started
   * by an agent in another workspace is still a real checkout with a real
   * agent in it; it simply stops having a row, and its lead's row answers
   * for it.
   */
  const rows = useMemo(() => banded(every), [every]);
  /**
   * And the order holds still while a row is held, so it cannot move out from
   * under a thumb. `peeking` is the hold: a press on a row becomes the peek,
   * which covers the list with a scrim as it opens.
   *
   * The position only — every place in here is the live one, so a row that
   * goes blocked while the peek is open still turns ember where it stands.
   */
  const shown = useSettled(rows, peeking !== null);
  const peeked = rows.find((row) => row.place.id === peeking)?.place ?? null;

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

     This place's own, deliberately: it is what *What it changed* opens, and
     a parent's diff is the parent's. The family's questions are `useAnswering`
     below, which is a different question with a different answer. */
  const speakerId = peeked ? (blockedRun?.id ?? lead(peeked).id) : null;
  const answering = useAnswering(peeked, every);

  /* The same teardown the workspace's own menu asks for, asked from the row.
     `every` rather than `places`: only the whole list knows which workspaces
     are this one's children, and the count in the question is the number that
     goes with it. */
  const endWorkspace = useEndWorkspace();
  const endPeeked = useCallback(() => {
    if (!peeked) return;
    void endWorkspace(peeked, childrenElsewhere(peeked, every).length);
  }, [endWorkspace, peeked, every]);

  const refresh = useCallback(
    () => cache.invalidateQueries({ queryKey: getListSessionsQueryKey() }),
    [cache],
  );

  /**
   * The title takes the destination's size, and there is no chevron.
   *
   * A destination has nowhere to go back to, and a back control on one is the
   * same defect `artifacts.tsx` still has. Without the chevron there is no
   * 44pt target to optically align against either, so the title sits on the
   * gutter the rows below it sit on — `px-5`, which is what `STYLE.md` means
   * by the gutter being one number.
   */
  const head = (
    <View className="px-5 pb-1 pt-0.5" style={COLUMN}>
      <Text
        className="font-medium text-bone"
        style={{
          fontSize: size.display,
          lineHeight: size.display * 1.16,
          letterSpacing: size.display * -0.024,
        }}
      >
        Workspaces
      </Text>
    </View>
  );

  /* **Not answering outranks everything below it.** A list that empties
     itself reads as work being lost, so the panel replaces the content
     rather than sitting above an honest-looking zero. `live.length` is not
     consulted the way the home consults it: the home has a composer worth
     keeping on screen under a stale list, and this screen is the list. */
  if (error && rows.length === 0) {
    return (
      <View className="flex-1 bg-ground" style={edges}>
        {head}
        <Unreachable org={here?.org ?? "That server"} onRetry={refresh} />
      </View>
    );
  }

  /* **The wait is the screen**, so it centres rather than sitting under the
     count. The count is a claim about data that has not arrived. */
  if (loading && rows.length === 0) {
    return (
      <View className="flex-1 bg-ground" style={edges}>
        {head}
        <View className="flex-1 items-center justify-center px-9">
          <Waiting say="Reading your workspaces" />
        </View>
      </View>
    );
  }

  /* **None at all**, and only once something has come back — an empty state
     is a claim, and above it the two states that are not it have already
     returned. The sentence says where a workspace comes from, because the
     answer to "nothing is running" is an action and not an apology. */
  if (rows.length === 0) {
    return (
      <View className="flex-1 bg-ground" style={edges}>
        {head}
        <View className="flex-1 items-center justify-center gap-2.5 px-9">
          <Text
            className="text-center font-medium text-bone"
            style={{ fontSize: size.title, lineHeight: size.title * 1.3 }}
          >
            Nothing is running.
          </Text>
          <Text
            className="max-w-[34ch] text-center font-sans text-mute"
            style={{ fontSize: size.read, lineHeight: size.read * 1.6 }}
          >
            A workspace is cut from a repository. Start one from the Dashboard, or pick a task.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View
      className="flex-1 bg-ground"
      style={edges}
    >
      {head}

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ ...COLUMN, paddingBottom: 30 }}>
        {/* **"In all" keeps counting every workspace**, children included.
            Fourteen checkouts exist, fourteen hold a host, and ending a parent
            ends what it started — so the number to carry around is the fleet's
            and not the list's. Each parent row says how many it stands for.

            **The waiting clause goes while a *Waiting on you* label is drawn**
            — it was two sizes of the same claim, and the two numbers disagree
            in both directions. See `fleetLine`. Read off `shown` rather than
            the fleet, so the line cannot contradict a label the hold is
            keeping on screen. */}
        <View className="px-5 pb-2 pt-1.5">
          <Text className="font-medium text-dim" style={{ fontSize: size.meta }}>
            {fleetLine(every, shown)}
          </Text>
        </View>

        {/* One map over one sorted array, with a label on the first row of
            each band and nowhere else. There is no section view here and
            nothing to collapse — that is the whole of what makes this a band
            and not a group. */}
        {shown.map((row, at) => (
          <Fragment key={row.place.id}>
            {row.turn ? (
              <BandLabel says={row.turn.says} count={row.turn.count} first={at === 0} />
            ) : null}
            <WorkspaceRow
              place={row.place}
              places={every}
              onPeek={() => setPeeking(row.place.id)}
            />
          </Fragment>
        ))}
      </ScrollView>

      {peeked ? (
        <Peek
          place={peeked}
          places={every}
          onClose={() => setPeeking(null)}
          onOpen={() => router.push(`/workspace/${peeked.id}`)}
          /* Where the children went. A child was one tap from this list and is
             now three — open the parent, find the panel, read the Team — so
             the peek pays it back: a long press and a tap, to all of them. */
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
    </View>
  );
}
