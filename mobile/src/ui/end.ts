/**
 * Ending a workspace, from wherever it is asked.
 *
 * The desk's `ui/end.ts`, ported rather than written again: the same call with
 * the same argument, the same thing read first, and the same facts in the
 * question. Every agent in the place stops, the workspace goes from the host,
 * the branch stays on the machine.
 *
 * ## Why this file exists at all
 *
 * The phone's *End this workspace* called `useStopSession`, whose own summary
 * is *"Stop the agent. The workspace and its branch stay."* — and then asked a
 * question that promised a worktree and a family of agents went with it.
 * Neither was true. `end_children` is reached only from the teardown path
 * (`api/sessions.rs:1828`, `:1857`), and `/stop` never gets there.
 *
 * The wording was the half of that which this app owns, and softening it was
 * the smaller fix. The owner chose the other direction: make the behaviour
 * match the words, because the words are what the desk has done all along and
 * the phone was the client that quietly did less.
 *
 * ## A 202 is a request, not a receipt
 *
 * The control plane answers `202` once the `Destroy` frames are **enqueued**
 * (`api/sessions.rs:1898`) and does not wait for the worker. A connection can
 * go after the frames are queued, or the teardown can fail at the worker —
 * QA watched exactly that, with a child left `Stranded` and its directory
 * still on disk — and the answer is `202` either way. There is no atomicity
 * across the family either: children are dispatched first (`:1857`), so a
 * later failure on the parent's own host can leave the children ended and the
 * parent alive. That is inherited server behaviour, newly reached by the
 * phone, and it is not this file's to fix.
 *
 * So this returns an {@link Ending} and not a boolean, and *completed* is not
 * one of its answers. What the phone can honestly say is **where to look**:
 * the control plane never marks a session as going, so the row is on the list
 * until the host has finished and gone from it when it has. The question says
 * so, which makes the list the status display it already was — pending is a
 * row still there, finished is a row gone, failed is a row that stays.
 *
 * ## The id, and why it is said explicitly
 *
 * `destroySession(place.id, { workspace: true })`. **The place's id, and
 * `workspace` asked for rather than inferred.** A workspace is named by the
 * session that cut it, so that session's id is also the workspace's — and the
 * control plane used to read that coincidence as "end everything", which meant
 * whoever started a place could not end their own first agent without ending
 * everybody's. Now it is told. `Workspace.id` is `session.workspaceId ??
 * session.id`, so it is the place's id for anything that belongs to a place:
 * the same id the desk passes, and not whichever run the screen happens to be
 * reading.
 *
 * ## What is read before the question
 *
 * `sessionWork` — uncommitted files and unpushed commits per checkout — so the
 * question can say what would be lost rather than gesturing at it. One
 * difference from the desk, and it is the contract's own: `uncommitted` is
 * nullable because *absent is not zero*, and a host that stopped answering
 * arrives as absent. The desk sums it with `?? 0`, which reads a workspace
 * nobody could reach as a workspace with nothing in it. Here anything
 * unreadable says so.
 *
 * ## The target is bound, not resolved again later
 *
 * This flow suspends twice before it sends anything — once reading the work,
 * once waiting for an answer — and the second wait is a native window that
 * outlives the React tree that opened it. Switch Firetower in between and
 * `BackendProvider` remounts everything under it, while the question stays on
 * screen with A's facts in it; the generated client then resolves the DELETE
 * against whatever is current, which is B. A session id carries no server in
 * it (`crates/ft-core/src/ids.rs:20`), so on two separately selectable
 * backends restored from one database — staging from production, which is
 * ordinary practice — the same id names a real workspace on both, and B's is
 * destroyed on A's preflight.
 *
 * Two things together, because neither is enough:
 *
 * - **The destination is bound.** Both calls name the Firetower they are for
 *   — see `aimOf` and {@link Aimed} in `client/http.ts` — so the read and the
 *   teardown go to the same machine by construction rather than by the
 *   ordering of a check. Naming the workspace in the question does **not**
 *   fix this: an alert can accurately name A while the DELETE still leaves
 *   for B.
 * - **The operation is cancelled if the destination moves.** Bound or not, an
 *   answer given on one Firetower is not consent to act on another, so the
 *   target is rechecked after *each* await and the flow stops rather than
 *   sending. Which it is — the question, the screen, or both — is why
 *   {@link endAstray} says only that nothing was sent.
 *
 * **The destination, and not the identity.** The first version of this bound
 * `[serverId, user]` and that was the same mistake one layer down. A
 * `serverId` is derived from the organisation's database id, so it is the one
 * field a restored copy keeps — the premise of the whole finding — and
 * `remember()` replaces a connection by that id, URL and token together. So
 * the pair matched while the address underneath it moved: the preflight read
 * A, `remember()` pointed the same id and account at B, the recheck passed,
 * and the DELETE left for B with B's token. `aimOf` carries the URL for that
 * reason and this flow compares the whole of it at every check.
 *
 * ## When the host is not answering
 *
 * The control plane refuses with 409 `HostUnreachable` and a sentence of its
 * own, which is shown as it came. It also offers something no client of this
 * control plane implements — `?force=true`, which marks the session ended here
 * and puts the workspace in front of `reclaim::sweep` without the machine ever
 * being told. The desk does not offer it either. Writing the phone the first
 * one is a different and larger decision than the one that was made here, so
 * this reports and stops: it never claims a teardown it did not get.
 */
import { useEffect, useRef } from "react";
import { Alert } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { destroySession, getListSessionsQueryKey, sessionWork } from "~/api/generated/sessions/sessions";
import type { Workspace } from "~/api/workspaces";
import { aimOf, destination } from "~/client/http";
import { why } from "~/data";
import { servers } from "~/native/servers";

/**
 * A question with two answers, as a promise.
 *
 * `onDismiss` because Android lets an alert go without either button, and a
 * question nobody answered must settle rather than leave the caller waiting
 * for ever.
 */
function ask(title: string, body: string): Promise<boolean> {
  return new Promise((settle) => {
    Alert.alert(
      title,
      body,
      [
        { text: "Keep it", style: "cancel", onPress: () => settle(false) },
        { text: "End it", style: "destructive", onPress: () => settle(true) },
      ],
      { onDismiss: () => settle(false) },
    );
  });
}

/**
 * What came of asking — and **not** whether the teardown finished.
 *
 * A boolean here meant *ended*, and the control plane cannot answer that
 * question: see the section above on what a `202` is. Three states, named for
 * what this flow actually learns, so that nothing downstream can read an
 * acceptance as a completion by accident.
 */
export type Ending =
  /**
   * Nothing was sent. The question was answered no or dismissed, or the flow
   * was abandoned because its Firetower moved under it.
   */
  | "kept"
  /**
   * The control plane took the request and queued the teardown. The agents
   * stop and the workspace goes **when the host has done it**, which it may
   * yet fail to do — the row leaving the list is what says it did.
   */
  | "requested"
  /**
   * It would not take the request and said why, which the reader has been
   * shown as the control plane wrote it.
   */
  | "refused";

/**
 * The one clause that is about *when*, and it is in both branches.
 *
 * Every other clause here is a consequence, and all of them were true — what
 * nothing said was that none of it has happened yet when the control plane
 * answers. A `202` means the frames are queued, so the only honest thing the
 * phone knows afterwards is the observable: the row is on the list until the
 * host has finished and gone from it when it has. Said here, before the press
 * rather than after it, because a sentence in front of something irreversible
 * is worth more than an acknowledgement behind it — and because it turns the
 * list into the answer for the teardown that quietly fails.
 */
const WHEN = " The workspace leaves the list once the host has done it.";

/**
 * What the question says, given what is in the place and what it leads.
 *
 * Exported for its own test. Every clause here is a claim about what the call
 * below actually does, which is the whole reason this change exists — so the
 * sentence is a pure function of the facts and can be checked against them.
 */
export function endWording(
  place: Workspace,
  delegated: number,
  work: { uncommitted?: number | null; ahead?: number | null; pushed?: boolean | null }[] | null,
): string {
  const agents = place.runs.filter((r) => r.status !== "Ended").length;
  /* **A bare agent is the dangerous case, not the safe one.** Everywhere else
     this question has a floor under it: whatever goes, the branch stays and
     the commits on it are still there. A place with nothing checked out has no
     such floor — git never saw the directory, so every file the agent made
     goes with it, and there is no branch to promise anybody. It reads as the
     mildest of the answers, because no checkout means nothing uncommitted to
     count. */
  const bare = !place.branch && place.runs.every((r) => (r.checkouts ?? []).length === 0);
  /* Absent is not zero. See `CheckoutWork.uncommitted`: a host that stopped
     answering arrives here as absent, and summing that as nothing is how an
     afternoon of uncommitted work gets reported as an empty workspace. */
  const unreadable = work === null || work.some((c) => c.uncommitted == null);
  const uncommitted = (work ?? []).reduce((n, c) => n + (c.uncommitted ?? 0), 0);
  const unpushed = (work ?? []).reduce(
    (n, c) => n + ((c.ahead ?? 0) > 0 && c.pushed === false ? (c.ahead ?? 0) : 0),
    0,
  );
  const losing = [
    uncommitted > 0 && `${uncommitted} uncommitted file${uncommitted === 1 ? "" : "s"}`,
    unpushed > 0 && `${unpushed} unpushed commit${unpushed === 1 ? "" : "s"}`,
  ].filter(Boolean);

  const stopping =
    (agents === 1 ? "The agent stops" : `${agents} agents stop`) +
    (delegated > 0
      ? `, and so ${delegated === 1 ? "does the agent" : `do the ${delegated} agents`} it started elsewhere.`
      : ".");

  if (bare) {
    return `${stopping} Nothing is checked out here, so every file in this workspace goes with it, and there is no branch to go back to.${WHEN}`;
  }

  /* "The workspace", not "Its workspace": after *2 agents stop* there is no
     one agent for "its" to belong to, and the workspace is the thing the
     title already named. */
  const going =
    delegated > 0
      ? "Their workspaces go from the host with this one."
      : "The workspace goes from the host.";
  /* "would be lost" rather than "goes with it", which is the phone's voice
     everywhere else here: this clause's subject is a count, and one file and
     four files cannot share a verb. The desk's phrasing agrees with both. */
  const lost = unreadable
    ? "What is uncommitted there could not be read, and would be lost."
    : losing.length
      ? `${losing.join(" and ")} on ${place.branch ?? "its branch"} would be lost.`
      : "Nothing uncommitted is in it.";
  const floor = delegated > 0 ? "The branches stay on the machine." : "The branch stays on the machine.";

  return `${stopping} ${going} ${lost} ${floor}${WHEN}`;
}

/**
 * Which workspace, and on which Firetower.
 *
 * It asked *End this workspace?* over a list of several, which names neither
 * the thing going nor the machine it is going from — and this app holds more
 * than one Firetower at a time. **The title is not the fix for the target**
 * (the binding above is), but a question about something irreversible should
 * say what it is about, and the one id in this sentence that a person can
 * check is the name.
 *
 * `place.name` rather than `rowLabel`'s: a child's full `lead / child` is
 * more identifying, not less, and this flow has no list to strip a prefix
 * against. The server is named only when there is more than one to confuse it
 * with — on a phone that knows one Firetower it is a word about nothing.
 */
export function endTitle(place: Workspace, server: string | null): string {
  return server ? `End ${place.name} on ${server}?` : `End ${place.name}?`;
}

/**
 * What is said when the answer arrives somewhere the question was not asked.
 *
 * **Only what is known.** Either the Firetower moved under the question or
 * the screen that asked it is gone, and the two are usually the same event —
 * so this says the one thing true of both, names where the workspace still
 * is, and leaves the reader somewhere to ask again from. Claiming a cause
 * here would be the same class of mistake as the sentence this whole file was
 * written to fix.
 */
export function endAstray(place: Workspace, server: string | null): string {
  return server
    ? `Nothing was sent. ${place.name} is still on ${server} — ask again from there.`
    : `Nothing was sent. ${place.name} was not ended.`;
}

/**
 * Ask, and then end it.
 *
 * `delegated` is how many agents this place started elsewhere and has not
 * ended: they go with it, and the question has to say so. The caller counts,
 * because only a list of places knows which ones belong under this one.
 */
export function useEndWorkspace() {
  const cache = useQueryClient();
  /* Unmount is a cancellation, and it is the only way this flow can learn its
     caller is gone: `Alert` is a native window, so the question survives the
     tree that opened it and comes back to a closure nobody is waiting on. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  return async (place: Workspace, delegated = 0): Promise<Ending> => {
    /* Captured once, before anything suspends: the whole destination, account
       included, and the sentence that names it. Everything after this is
       about this workspace on this Firetower and nothing else. */
    const aimed = destination();
    const firetower = aimOf(aimed);
    /* Named only when the phone holds more than one; see `endTitle`. */
    const named = servers().length > 1 ? (aimed?.org ?? null) : null;
    /**
     * Still the same Firetower — address included — and still somebody to
     * answer to?
     *
     * `firetower` is tested for being *something* as well as for matching.
     * `aimOf(undefined)` is the empty string, so a flow that started with no
     * destination at all would otherwise compare equal to one and go on to
     * ask a question about a machine it could not name. Nothing is sent
     * either way — `http` refuses an aim that names nothing — but a question
     * about an irreversible thing should not be asked in the first place.
     */
    const onTarget = () => alive.current && !!firetower && aimOf(destination()) === firetower;

    const work = await sessionWork(place.id, { firetower }).catch(() => null);
    /* Nothing has been asked and nothing promised, so this one is silent. */
    if (!onTarget()) return "kept";

    if (!(await ask(endTitle(place, named), endWording(place, delegated, work)))) return "kept";
    /* The second recheck, and the one the defect lived behind: *End it* was
       pressed on a question about A, and a press is not consent to act on
       whatever is current when it lands. */
    if (!onTarget()) {
      Alert.alert("It did not end.", endAstray(place, named ?? aimed?.org ?? null));
      return "kept";
    }
    /* The heaviest knock in the app, on the one press that cannot be taken
       back — and on the answer rather than on the question, which is where it
       was before this moved out of the menu. */
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    try {
      await destroySession(place.id, { workspace: true }, { firetower });
      /* `cache` is the `QueryClient` of the identity this hook was mounted
         for, which is the one holding the list this workspace was on. It is
         invalidated whether or not anybody is still looking at it. */
      await cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
      /* **Asked for, not done.** Nothing above this line waited for a worker,
         so nothing below it may claim one finished. */
      return "requested";
    } catch (e) {
      /* The control plane's own sentence, as it came. When the host is not
         answering that sentence is the only thing that explains why a
         workspace somebody just ended is still on the list. */
      Alert.alert("It did not end.", why(e));
      return "refused";
    }
  };
}
