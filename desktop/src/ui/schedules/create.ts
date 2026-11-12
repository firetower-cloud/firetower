/**
 * Making a schedule from the sheet, which is the one route that leaves it on.
 *
 * **Pressing Create is the act of approval**, and that is what the pinned
 * consequence summary above the footer is for: somebody has read what an
 * unattended run may do, what it costs and what happens when it cannot
 * finish, and has agreed to it. Asking them to approve their own schedule
 * seconds later is the same decision twice.
 *
 * ## Why this is two calls and not a flag on one
 *
 * The rule is about the **route**, not about who is asking. `POST
 * /api/v1/schedules` writes an inactive schedule *whoever* calls it — a
 * person, the MCP tool, the API by hand, a copied schedule, a webhook
 * trigger that does not exist yet. Everything defaults inert, and there is
 * exactly one explicit act that turns one on: `POST /{id}/approve`.
 *
 * An `activate: true` on the create body would have been one call, and it
 * would have moved the decision from the route to the caller — anything able
 * to reach the endpoint could ask for an active schedule, and "an agent may
 * propose but may not activate" would then rest on who was asking rather
 * than on which path was taken. A rule written as `if the caller is a person`
 * is one that drifts the first time something new calls it.
 *
 * So the activating path is the one that already existed and is already the
 * one act an agent cannot reach: an HTTP handler, behind a signed-in
 * principal, which `delegate::handle` has no door to. Nothing new is exposed
 * here, which is what keeps an agent's proposal inactive.
 *
 * ## It fails toward off
 *
 * Two statements are not atomic. If the second does not land, what exists is
 * a schedule that is off — visible in the library, one switch away — and the
 * caller is told so. That is the safe direction, and it is the same state an
 * agent's proposal arrives in.
 */
import {
  approveSchedule,
  createSchedule,
} from "~/api/generated/schedules/schedules";
import type { NewSchedule, Schedule } from "~/api/generated/model";

/** What happened, so the sheet can say the true thing either way. */
export type Made =
  | { on: true; schedule: Schedule }
  | { on: false; schedule: Schedule; why: string };

export async function createAndTurnOn(req: NewSchedule): Promise<Made> {
  /* Inactive, whoever asked. A refusal here — a cadence under the floor, a
     repository that is not theirs — is the caller's to report, so it is not
     caught. */
  const schedule = await createSchedule(req);

  try {
    return { on: true, schedule: await approveSchedule(schedule.id) };
  } catch (e) {
    return {
      on: false,
      schedule,
      why:
        e instanceof Error
          ? e.message
          : "it was written down but could not be turned on",
    };
  }
}
