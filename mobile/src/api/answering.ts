/**
 * The questions a held row can answer, and the one call that answers them.
 *
 * **One hook rather than the same twenty lines in two screens**, for the
 * reason `usePeekable` is one hook: the home and the Workspaces destination
 * had already drifted once, and this is worse to get wrong — the pairing of a
 * question to the agent it was asked by is what decides whose approval a
 * button grants.
 *
 * It was in `ui/Peek.tsx`, beside the component it feeds. It is here now
 * because the pairing is the part that can be wrong, and `Peek.tsx` reaches
 * reanimated and gesture-handler, so nothing in it can be put under test at
 * all. The component draws what it is handed; what it is handed is decided
 * here, where `pending.test.ts` and `answering.test.ts` can both see it.
 */
import { useMemo } from "react";
import type { Asked } from "~/api/conversation";
import type { Session } from "~/api/generated/model";
import { useAnswerRequest } from "~/api/generated/sessions/sessions";
import { usePending, type Pending } from "~/api/pending";
import { asking, type Workspace } from "~/api/workspaces";

/**
 * How many waiting agents one peek offers buttons for.
 *
 * Three questions is most of a phone and this has no scroll in it: it tops out
 * at 16% of the window and grows down. Two, then a line saying how many more
 * are waiting — which is still two answers for one long press, and the whole
 * reason the component exists.
 */
export const ANSWERS = 2;

/** One agent's question, with both answers on it. */
export type Ask = { run: Session; asked?: Asked | null; reading?: boolean };

/**
 * One slot's read, and only if it is about the agent in that slot.
 *
 * `usePending` settles this for itself and this asks it again, because the
 * two things that have to agree are written as two expressions: the id handed
 * to the hook at index `i`, and the run drawn against `read[i]`. One guard
 * covers the hook's own slot; this one covers the pairing, which is the thing
 * the buttons mean.
 */
function pair(run: Session, read: Pending): Ask {
  const mine = read.of === run.id;
  /* `undefined` rather than `null` on a mismatch: that is this type's word
     for *not read yet*, and a slot whose session has just changed is about to
     read. `null` would mean nothing is pending, which nobody knows yet. */
  return { run, asked: mine ? read.asked : undefined, reading: mine ? read.reading : true };
}

/**
 * `usePending` per agent, and a fixed number of them: hooks cannot be called
 * in a loop whose length changes, which is the other reason the cap is a
 * constant rather than a preference. Both calls are inert when nothing is
 * held — a null id makes no request.
 *
 * **A slot is not a session.** The two calls below are positional and the
 * blocked set moves under them: an agent unblocks while a row is held and the
 * next one slides into its slot. What `pending.ts` carries, and what `pair`
 * checks, is which session each read is actually about — see the note there
 * for what a mispaired frame could approve.
 */
export function useAnswering(place: Workspace | null, places: Workspace[]) {
  const waiting = useMemo(() => (place ? asking(place, places) : []), [place, places]);
  const asks = waiting.slice(0, ANSWERS);
  const read = [
    usePending(asks[0]?.id ?? null, !!asks[0]),
    usePending(asks[1]?.id ?? null, !!asks[1]),
  ];
  const answer = useAnswerRequest();

  return {
    /** The agents being offered an answer, each with what it asked. */
    asks: asks.map((run, i) => pair(run, read[i])),
    /** Everyone waiting, including the ones past the cap. */
    waiting: waiting.length,
    /**
     * **The pair the button was drawn with**, handed back rather than looked
     * up again.
     *
     * This took a `Session` and found its request by searching the slots at
     * press time, which asks the same question a second time against whatever
     * the slots hold *now*. The answer that matters is the one the reader was
     * looking at when their thumb came down, and that is already in the `Ask`
     * the button belongs to.
     */
    onAnswer: (ask: Ask, yes: boolean) => {
      /* No `req`, no answer. A button that fires against a request that could
         not be read is worse than no button — see `api/pending.ts`. */
      if (!ask.asked) return;
      answer.mutate({
        id: ask.run.id,
        data: {
          req: ask.asked.req,
          decision: yes ? { decision: "Allow" } : { decision: "Deny", reason: null },
        },
      });
    },
  };
}
