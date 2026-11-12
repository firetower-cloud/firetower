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
 * ## And after the send, where there is nothing left to cancel
 *
 * The rechecks above are all before the DELETE, which is the half that can
 * still be stopped. The two awaits *after* it had none, and that was read as
 * cancellation being complete. It was not: the DELETE and the invalidation
 * each suspend, the screen can be unmounted or the Firetower moved while
 * either is in flight, and the flow then came back `requested` to a caller
 * that no longer existed. `WorkspaceMenu`'s continuation calls `onEnding()`,
 * which is a global `router.back()` (`app/workspace/[id].tsx:604`), so a
 * teardown asked for on one screen navigated whatever screen had replaced it;
 * a late rejection put an unqualified *It did not end.* over a different
 * workspace.
 *
 * Nothing here can un-send a DELETE and nothing here pretends to. **What is
 * suppressed is the navigation and the alert, not the fact** — the request
 * really went, so it is reported as {@link Ending}'s `orphaned` rather than
 * relabelled `kept`. Trading one false sentence for another is not a fix.
 *
 * ## Mounted is not current
 *
 * Unmount and destination were two of the three ways a continuation can lose
 * the reader, and the third is the quietest: **push another screen.** The one
 * that asked is still mounted, on the same backend, with the same cache — so
 * both of the checks above pass while the thing in front of the reader is a
 * different workspace, and `onEnding()` navigates it. Dismissing the menu is
 * not the event; pushing over it is.
 *
 * So the screen's **visit** is counted and the operation captures which one it
 * was asked in. A generation and not a flag, because a flag can be revived by
 * coming back: blur, answer, return, and a boolean reads true again for a
 * continuation that was abandoned two screens ago. And the two questions are
 * kept apart — {@link useEndWorkspace}'s `onTarget` decides what may be
 * *sent*, `inFront` decides what may reach the *glass*. Navigating away is not
 * a cancellation of something somebody asked for; it is the end of that
 * operation's claim on the screen.
 *
 * The cache invalidation stays **above** the guard, where it already was. It
 * belongs to the destination and not to the screen, and the list is the one
 * thing that says whether the teardown finished.
 *
 * **The destination, and the identity, and they are one thing now.** The
 * first version of this bound `[serverId, user]` and that was the same
 * mistake one layer down. A `serverId` is derived from the organisation's
 * database id, so it is the one field a restored copy keeps — the premise of
 * the whole finding — and `remember()` replaces a connection by that id, URL
 * and token together. So the pair matched while the address underneath it
 * moved: the preflight read A, `remember()` pointed the same id and account at
 * B, the recheck passed, and the DELETE left for B with B's token.
 *
 * Carrying the URL in the aim closed that, and then the same defect came back
 * through the one door left: **do the swap before the action rather than
 * during it.** A destination captured when *the action starts* is already B,
 * so there is nothing for any recheck to catch — while the `Workspace` the
 * question names came out of a cache keyed on the narrow identity, which the
 * URL change did not disturb. Every comparison passed because both sides of
 * every comparison had moved together; the only thing left behind was the
 * data on screen.
 *
 * So two things changed, and the second is not a guard:
 *
 * - `api/identity.ts` carries the address, so the aim **is** the identity.
 *   `BackendProvider` is keyed on it, which means a URL change retires the
 *   whole context — the `QueryClient`, the socket and this hook with them —
 *   and the next render has to read the list from the new address before
 *   there is a workspace to end at all. The cost is in that file's docblock:
 *   held transcripts are re-keyed. They are another machine's transcripts.
 * - This flow writes its destination down **when the screen that will ask is
 *   mounted**, not when a button is pressed. That is the destination which
 *   supplied the workspace in the question, which is the thing the reviewer
 *   asked the action to be bound to — and it is the one capture point a
 *   pre-action swap cannot get in front of.
 *
 * ## When the host is not answering
 *
 * The control plane refuses with 409 `HostUnreachable` and a sentence of its
 * own, and behind that refusal it offers `?force=true`: the session is marked
 * `Ended` here, the teardown that host owes is recorded against it
 * (`db.rs`'s `forget_session`), and the workspace goes in front of
 * `reclaim::sweep` without the machine ever being told. The owner asked for
 * the desk's behaviour, and *"the phone cannot get rid of a workspace whose
 * machine is off"* is the half of that which was missing — the workspace sits
 * in the inbox for ever with no control that can touch it.
 *
 * **It is a second question, not a third branch of the first one.** Somebody
 * who has just read *the agents stop, the workspace goes from the host* and
 * pressed *End it* is being offered something close to the opposite: the row
 * leaves their list and the work keeps running on a machine they cannot see.
 * Folded into the first dialog that is a sentence nobody reads under a button
 * they already decided to press. So the refusal is shown, in the control
 * plane's own words — which are the only accurate ones, because it knows
 * which machine and which of its two refusals this is — and the decision is
 * asked again with its own title, its own body and its own verb. See
 * {@link removeTitle}, {@link removeWording} and {@link Ending}'s `removed`,
 * which is deliberately not `requested`: no teardown was queued, and nothing
 * downstream may read one.
 *
 * The desk has no forced path to port. `desktop/src/ui/end.ts` reports the
 * refusal and stops, and no client of this control plane passes `force`; the
 * flow is the desk's shape — read, ask, send, invalidate — with the second
 * decision written here first.
 */
import { useEffect, useRef } from "react";
import { Alert } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import * as Haptics from "expo-haptics";
import { destroySession, getListSessionsQueryKey, sessionWork } from "~/api/generated/sessions/sessions";
import type { Workspace } from "~/api/workspaces";
import { aimOf, destination, meansHostAway } from "~/client/http";
import { why } from "~/data";
import { servers } from "~/native/servers";

/**
 * A question with two answers, as a promise.
 *
 * `onDismiss` because Android lets an alert go without either button, and a
 * question nobody answered must settle rather than leave the caller waiting
 * for ever.
 *
 * `act` because there are two questions here and they are not the same
 * decision: *End it* tears a workspace down, *Remove it here* takes one off
 * this Firetower and leaves it running. A button that said the same thing in
 * both would be the whole of what is wrong with folding them together.
 */
function ask(title: string, body: string, act: string): Promise<boolean> {
  return new Promise((settle) => {
    Alert.alert(
      title,
      body,
      [
        { text: "Keep it", style: "cancel", onPress: () => settle(false) },
        { text: act, style: "destructive", onPress: () => settle(true) },
      ],
      { onDismiss: () => settle(false) },
    );
  });
}

/**
 * What came of asking — and **not** whether the teardown finished.
 *
 * A boolean here meant *ended*, and the control plane cannot answer that
 * question: see the section above on what a `202` is. Four states, named for
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
   * **The request went, and there is nobody here to tell.**
   *
   * `requested` with the caller gone: the DELETE was sent and accepted, and
   * by the time it came back the screen that asked had been unmounted, the
   * Firetower had moved underneath it, or the reader had pushed something over
   * it. The teardown is happening either way — nothing can call it back, and
   * this must never be read as `kept`, which would be a fresh version of the
   * lie this whole file exists to correct.
   *
   * What it withholds is the *acting on it*. `onEnding()` is a global
   * `router.back()` and an alert is a window over whatever is in front now,
   * so neither belongs to a caller that is no longer the one who asked. The
   * row on the list is still where the answer is, and the list is still
   * refreshed below — see the invalidation, which happens either way.
   */
  | "orphaned"
  /**
   * **Taken off this Firetower without the machine ever being told.**
   *
   * The answer to the *second* question, and only reachable through it: the
   * control plane refused the teardown because the host is not answering, said
   * so in its own sentence, and that sentence was put to the reader as a
   * different decision with a different button. `?force=true` marks the
   * session `Ended` here and records the teardown that host still owes
   * (`db.rs`'s `forget_session`), which is paid the next time it connects.
   *
   * **Not `requested`.** That answer claims a teardown was queued, and the
   * whole content of this one is that it was not: the agents are still running
   * over there. Callers leave the screen on it the way they do on `requested`,
   * because the row is finished *here* either way and the list is still where
   * that is visible — but nothing may read it as the workspace having gone.
   */
  | "removed"
  /**
   * It would not take the request and said why — shown as the control plane
   * wrote it, **when there is still somebody to show it to.** A refusal that
   * lands after the caller or the destination has gone has nowhere to be
   * displayed, and an unqualified alert over a different workspace is worse
   * than silence.
   *
   * Also what comes back when the reader was offered {@link Ending}'s
   * `removed` and said no. The teardown really was refused; they have been
   * told why, in the control plane's words, by the question itself.
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
 * The second question's title, when the machine is not answering.
 *
 * **"Remove", not "End".** The verb is the control plane's own — *"Remove it
 * here anyway"* — and it is the difference between the two decisions said in
 * one word: the first ends a workspace, this one takes a workspace off a list
 * and leaves it running. Sharing a title with the first question is how a
 * person agrees to the second without noticing there was one.
 *
 * `from ${server}` rather than `on ${server}`, for the same reason: what this
 * removes it from is this Firetower, which is the whole of what it does.
 */
export function removeTitle(place: Workspace, server: string | null): string {
  return server ? `Remove ${place.name} from ${server}?` : `Remove ${place.name}?`;
}

/**
 * What the second question says: **the control plane's sentence, and what the
 * button does.**
 *
 * The refusal is quoted rather than paraphrased because the control plane
 * writes the only accurate version of it. It knows which machine, and it knows
 * which of two refusals this is — a host that is merely away, where removing
 * the row is the right trade and it says so; or one that has been retired,
 * where the conversation is the only record of what ran there and it says that
 * instead, and does not recommend it. Rewriting either here would be this app
 * guessing at a fact it was told.
 *
 * One clause is added, and it is the one the server does not say because it is
 * about *this* decision rather than about the machine: **nothing stops over
 * there.** Everything the first question promised — the agents stopping, the
 * workspace going from the host — is exactly what does not happen, and a
 * person who has just read that question and pressed *End it* needs the
 * negation out loud. "That machine", deliberately: a child of this workspace
 * on a host that *is* answering really is torn down (`api/sessions.rs`'s
 * `end_children`), so the clause is true of what it names and claims nothing
 * about what it does not.
 */
export function removeWording(refusal: string): string {
  return `${refusal} Nothing stops on that machine — this only takes it off the list here.`;
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
  /**
   * **The destination that supplied what this screen is showing.**
   *
   * Written down at mount, which is the point of it: `BackendProvider` is
   * keyed on the identity and the identity now carries the address, so this
   * hook exists for exactly as long as one destination does, and the cache
   * that fed the workspace in the question is that destination's. Read when
   * the action *starts* instead — which is what it did — and a registry
   * already moved to B hands the action B, while the question still names A's
   * retained workspace and nothing disagrees with anything.
   *
   * `useRef`, so every call from this screen names the same machine however
   * many times it redraws.
   */
  const from = useRef(destination());
  const aimed = from.current;
  const firetower = aimOf(aimed);
  /**
   * **Which visit to this screen is the one in front.**
   *
   * Mounted is not current. Confirm a teardown, push another screen while the
   * DELETE or the invalidation is in flight, and the screen that asked is
   * still mounted on the same backend — so both of the checks above pass,
   * while the thing in front of the reader belongs to somebody else. The
   * continuation came back `requested` and `WorkspaceMenu` called `onEnding()`
   * on it, which is a global `router.back()`; a late rejection put *It did not
   * end.* over it the same way.
   *
   * A **generation** rather than a flag, because a flag can be revived: blur,
   * answer the question, come back to the screen and a boolean reads true
   * again — and the continuation it would let through was abandoned three
   * screens ago. Each blur ends a visit for good, so an operation that
   * captured one can never be in front again.
   *
   * `useIsFocused` throws outside expo-router's own route tree, and every
   * caller of this hook is a route component — `WorkspaceMenu` on
   * `workspace/[id]`, and the two tab screens that drive the peek's *End*. A
   * caller that was not would be a caller with no answer to this question at
   * all, which is worth a crash in development rather than a guard that
   * silently never fires.
   */
  const focused = useIsFocused();
  const visit = useRef(0);
  useEffect(() => {
    /* Only a **blur** ends a visit, and it ends it for good: coming back is a
       new one. `useIsFocused` reads a context, so it changes when focus
       changes and never on an unrelated re-render — which rules out the
       failure mode of counting `useFocusEffect`'s cleanups instead. React may
       re-run an effect whenever its deps move, and that hook's deps include
       the navigation object; a screen that redraws on every streamed line
       would have ended a visit per frame and orphaned every teardown it ever
       asked for, silently. */
    if (!focused) visit.current += 1;
  }, [focused]);

  return async (place: Workspace, delegated = 0): Promise<Ending> => {
    /* The visit this was asked in. Captured with everything else that is
       about *this* press rather than about the screen. */
    const since = visit.current;
    /* Named only when the phone holds more than one; see `endTitle`. Which
       machine is a fact about the mounted destination; whether saying so is
       worth the words is a fact about the registry now. */
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
    /**
     * Is there still somebody in front of this to say it to?
     *
     * **Two predicates and not one, because they answer different
     * questions.** `onTarget` decides whether anything may be *sent*: it is
     * about the machine, and a press is consent to act on the machine that
     * was named. This decides whether anything may be put on the *screen* or
     * navigate it — and navigating away is not a cancellation of a teardown
     * somebody asked for, but it does end that teardown's claim on the glass.
     *
     * Folded together, a blur would have stopped the DELETE and a destination
     * that moved would have been reported by an alert over whatever is in
     * front now. Both of those are a fresh version of the defect this file
     * exists to correct, arriving through the fix for it.
     */
    const inFront = () => alive.current && visit.current === since;

    /**
     * **The second decision**, asked only when the first one came back
     * refused because the host is not answering.
     *
     * A separate question with its own words and its own button, not a third
     * branch of the first: somebody who has just been told the machine cannot
     * be reached is agreeing to something materially different from the
     * teardown they asked for. The workspace leaves their list and keeps
     * running on a machine they cannot see. {@link removeWording} is what
     * says so, in the control plane's terms.
     *
     * Every guard the first half has, for the same reasons: the question is a
     * native window and can outlive the screen or the destination, so the
     * target is rechecked before the send, and the screen's visit decides
     * what may be navigated or alerted afterwards.
     */
    const removeAnyway = async (refusal: string): Promise<Ending> => {
      if (!(await ask(removeTitle(place, named), removeWording(refusal), "Remove it here"))) {
        /* The teardown really was refused, and the question they just
           declined is where they were told why. Nothing to add. */
        return "refused";
      }
      if (!onTarget()) {
        if (inFront()) {
          Alert.alert("It was not removed.", endAstray(place, named ?? aimed?.org ?? null));
        }
        return "refused";
      }
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      try {
        await destroySession(place.id, { workspace: true, force: true }, { firetower });
        /* Above the guard, like the first one: the list belongs to the
           destination and it is where the row going is visible. */
        await cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
        if (!onTarget() || !inFront()) return "orphaned";
        return "removed";
      } catch (e) {
        /* A removal that will not even be *recorded* is its own failure and
           gets its own title: *It did not end.* is about the teardown, which
           this reader has already been told did not happen. */
        if (onTarget() && inFront()) Alert.alert("It was not removed.", why(e));
        return "refused";
      }
    };

    /* **Before the read, and not only after it.** The registry can have moved
       before this was ever called — a workspace retained from before the swap,
       asked about afterwards — and a preflight sent on behalf of a question
       that will not be asked is a request about one machine's workspace made
       to whatever is current.

       Silent, for the same reason the check below the read is: nothing has
       been asked and nothing promised. In the app this is a backstop rather
       than a path — the provider is keyed on this destination, so a URL that
       moved has already taken the screen down and there is nobody to tell. */
    if (!onTarget()) return "kept";

    const work = await sessionWork(place.id, { firetower }).catch(() => null);
    /* Nothing has been asked and nothing promised, so this one is silent. */
    if (!onTarget()) return "kept";

    if (!(await ask(endTitle(place, named), endWording(place, delegated, work), "End it"))) {
      return "kept";
    }
    /* The second recheck, and the one the defect lived behind: *End it* was
       pressed on a question about A, and a press is not consent to act on
       whatever is current when it lands. */
    if (!onTarget()) {
      /* Said to whoever asked, and to nobody else. The question was answered
         on this screen; if the reader has since pushed another one, an
         unqualified *It did not end.* over it is the hazard below arriving
         before the send instead of after it. */
      if (inFront()) Alert.alert("It did not end.", endAstray(place, named ?? aimed?.org ?? null));
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
         invalidated whether or not anybody is still looking at it — the cache
         belongs to the identity and not to the screen, and the list is the
         one thing that says whether the teardown finished. So this is above
         the recheck rather than behind it. */
      await cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
      /* Two awaits since the last recheck, and either can outlive the screen
         that asked, the Firetower it asked about, or this screen's turn at
         being the one in front. One check covers all three, because it is the
         last thing before the answer goes back. The request has gone and this
         says so; what it withholds is the navigation. */
      if (!onTarget() || !inFront()) return "orphaned";
      /* **Asked for, not done.** Nothing above this line waited for a worker,
         so nothing below it may claim one finished. */
      return "requested";
    } catch (e) {
      /* The control plane's own sentence, as it came. When the host is not
         answering that sentence is the only thing that explains why a
         workspace somebody just ended is still on the list.

         Unless there is nobody it would be explaining it to: a rejection that
         lands after the screen has gone, after the Firetower moved, or after
         the reader has pushed something over the screen that asked, puts that
         sentence over a workspace it is not about. The refusal is still the
         answer — it is just not shown to somebody who did not ask. */
      if (!onTarget() || !inFront()) return "refused";
      /* **One refusal has a second answer behind it.** A host that is not
         answering cannot be told to tear anything down, and the control plane
         offers `?force=true` for exactly that — so the refusal is not the end
         of the road, it is the start of a different question. Every other
         refusal is shown and stopped at.

         The code rather than `instanceof`, which is how `data.ts` reads an
         error for the same reason: one `ApiError` class per bundle is not
         something this file can be sure of, and the code is the contract. */
      if (!meansHostAway((e as { code?: string })?.code)) {
        Alert.alert("It did not end.", why(e));
        return "refused";
      }
      return await removeAnyway(why(e));
    }
  };
}
