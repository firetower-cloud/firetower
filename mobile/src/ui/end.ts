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
import { Alert } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { destroySession, getListSessionsQueryKey, sessionWork } from "~/api/generated/sessions/sessions";
import type { Workspace } from "~/api/workspaces";
import { why } from "~/data";

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
    return `${stopping} Nothing is checked out here, so every file in this workspace goes with it, and there is no branch to go back to.`;
  }

  const going =
    delegated > 0
      ? "Their workspaces go from the host with this one."
      : "Its workspace goes from the host.";
  /* "would be lost" rather than "goes with it", which is the phone's voice
     everywhere else here: this clause's subject is a count, and one file and
     four files cannot share a verb. The desk's phrasing agrees with both. */
  const lost = unreadable
    ? "What is uncommitted there could not be read, and would be lost."
    : losing.length
      ? `${losing.join(" and ")} on ${place.branch ?? "its branch"} would be lost.`
      : "Nothing uncommitted is in it.";
  const floor = delegated > 0 ? "The branches stay on the machine." : "The branch stays on the machine.";

  return `${stopping} ${going} ${lost} ${floor}`;
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

  return async (place: Workspace, delegated = 0): Promise<boolean> => {
    const work = await sessionWork(place.id).catch(() => null);
    if (!(await ask("End this workspace?", endWording(place, delegated, work)))) return false;
    /* The heaviest knock in the app, on the one press that cannot be taken
       back — and on the answer rather than on the question, which is where it
       was before this moved out of the menu. */
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    try {
      await destroySession(place.id, { workspace: true });
      await cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
      return true;
    } catch (e) {
      /* The control plane's own sentence, as it came. When the host is not
         answering that sentence is the only thing that explains why a
         workspace somebody just ended is still on the list. */
      Alert.alert("It did not end.", why(e));
      return false;
    }
  };
}
