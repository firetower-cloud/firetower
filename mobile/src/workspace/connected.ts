/**
 * Repositories connected on one screen, wanted on the one behind it.
 *
 * Somebody starting a workspace taps *Connect a repository*, lands on
 * `/repos`, connects two, and comes back to the form. Those two are the only
 * reason they went — so the form has them chosen when it comes back, rather
 * than making them open the picker again and find the rows they just created.
 *
 * The same handoff as `draft.ts`, for the same reason: it is written on one
 * screen and read on another, a module-level value is exactly the durability
 * that needs, and there are no tabs on a phone to scope it to.
 *
 * **Only left when the form asked for it.** `/repos` is also a screen of its
 * own off the You tab, and ids left there would be picked up by the next
 * workspace somebody started — preselecting repositories they chose for an
 * unrelated reason, an hour earlier. So the form's route passes `pick`, and
 * that is what decides whether anything is left here at all.
 */
let held: string[] = [];

/** Leave what was just connected, for the form that asked for it. */
export function leaveConnected(ids: string[]) {
  held = ids;
}

/**
 * Take them, once.
 *
 * Emptied on read: coming back to the form a second time should not re-add
 * repositories somebody has since removed from it.
 */
export function takeConnected(): string[] {
  const ids = held;
  held = [];
  return ids;
}
