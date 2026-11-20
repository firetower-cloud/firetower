/**
 * Turning a schedule on or off, and **what the server said when it would
 * not**.
 *
 * Two screens carry this switch — the library's row and the schedule's own
 * page — and both of them used to `await approveSchedule(…)` bare. The server
 * refuses an approval in several cases, and every one of those refusals went
 * to an unhandled promise rejection: the press did nothing, the page was
 * byte-identical before and after, and the sentence explaining why was in the
 * devtools console.
 *
 * That is worse than the dead end it was added to prevent. A dead end tells
 * you something eventually; a button that silently does nothing tells you the
 * application is broken.
 *
 * So the three acts and their refusal live here, once, and both screens draw
 * [`Refused`] with whatever comes back. **The three, not just the approval:**
 * pausing and resuming can fail too — the schedule was deleted in another
 * window, the server is unreachable — and a handler that catches one of its
 * three calls is a handler somebody will widen wrongly later.
 *
 * ## Why the sentence is returned rather than thrown
 *
 * There is no renderer under this test runner: `vitest` here is
 * `react-dom/server` and pure functions, so a click cannot be fired and a
 * `catch` inside a component cannot be observed. A function that **answers**
 * with the sentence can be, and so can the component that draws it — which is
 * the same split `start.ts` and `attach.ts` already use, and the reason their
 * rules are the tested part rather than the markup around them.
 */
import { useEffect, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import { Icon } from "~/components/ui";
import {
  approveSchedule,
  pauseSchedule,
  resumeSchedule,
} from "~/api/generated/schedules/schedules";
import { why } from "~/data";
import type { Schedule } from "~/api/generated/model";

/** The three fields the switch reads. Narrow, so a test needs no fixture. */
export type Flippable = Pick<Schedule, "id" | "active" | "approvedAt" | "revision">;

/**
 * Press the switch, and hand back the sentence if the server refused.
 *
 * `null` means it worked. The caller refreshes and clears whatever it was
 * showing; it does not have to know which of the three calls was made.
 *
 * **Which call, and why these three in this order.** On is off; approved but
 * off is a resume; never approved — or approved and then un-approved, which is
 * what editing its agent team does — is an approval. That last case is the one
 * that can be refused on its merits rather than by accident: a team whose lead
 * has changed carries an engine the pinned permission mode and sandbox were
 * not approved for, so turning it on would start something nobody has read.
 */
export async function flipSchedule(s: Flippable): Promise<string | null> {
  try {
    if (s.active) await pauseSchedule(s.id);
    else if (s.approvedAt) await resumeSchedule(s.id);
    else await approveSchedule(s.id, { revision: s.revision });
    return null;
  } catch (e) {
    /* `why` reads the `ApiError`'s own message, which is the sentence the
       server wrote for a person to act on.

       **And a blank one is not an answer.** `why` falls back with `??`, which
       only catches a *missing* message — an error carrying `message: ""`
       comes back as an empty string, `Refused` draws nothing, and the press
       is silent again in exactly the way this file exists to prevent. Its own
       fallback wording, so there is one sentence in the product for this
       rather than two. (The `??` is shared by every caller of `why`; worth
       fixing there, which is wider than this branch.) */
    return why(e).trim() || "That didn't work.";
  }
}

/**
 * Why the press did nothing, where the press was.
 *
 * `.s-conseq[data-tone="brick"]` is what a schedule's page already draws for
 * *this cannot run*, which is the same kind of statement: here is why this
 * schedule is not going to do the thing. One shape on both screens, so the
 * answer does not depend on which of them you were looking at.
 *
 * **Brick, not amber.** Amber on these pages is a schedule that stopped
 * itself, which is a state it is in; this is an action that was refused.
 *
 * ## It scrolls itself into view
 *
 * The library is one scroller with two tables in it, and the switch that was
 * refused may be forty rows down — so a notice at the top of that scroller is
 * drawn and not *seen*, which is the same failure this component exists to
 * fix, one degree milder. `block: "nearest"` so a notice already on screen
 * does not move the page under somebody's hand.
 *
 * `role="alert"` is the other half, for a reader that is not looking at all:
 * a notice appearing without focus moving is otherwise never announced.
 */
export function Refused({ says }: { says: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (says) box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [says]);
  if (!says) return null;
  return (
    <div ref={box} className="s-conseq" data-tone="brick" role="alert">
      <Icon of={TriangleAlert} size={16} />
      <div>
        <p>{says}</p>
      </div>
    </div>
  );
}
