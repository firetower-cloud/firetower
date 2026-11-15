/**
 * What the create sheet's pickers open on.
 *
 * **Not `control.current`**, which is what `GET /agents/{kind}/controls`
 * fills with whatever that person last worked with. That is the right answer
 * for the composer — a session starts on the settings you were last using —
 * and it is the one thing an unattended run must not inherit: a schedule
 * approved against a remembered sandbox would change what the 9am run does
 * the next time somebody picked something else at their desk. The server pins
 * all four explicitly for that reason, and this is the sheet agreeing with it
 * so the screen reads back what will actually run.
 *
 * Pure, and its own file, because it is one rule and it was wrong on the
 * screen rather than in the request.
 */
import type { Control } from "~/api/generated/model";

/**
 * The permission mode that refuses rather than asks — **asked of the
 * catalogue, not spelled here.**
 *
 * The word differs by engine: Claude Code says `dontAsk` and Codex says
 * `never`, and a client that knew that would be a second place to change it
 * and a second place to get it wrong. `Caution::NeverAsks` is the marker the
 * server already puts on that choice.
 *
 * `undefined` for everything else, which draws as a label with no value: the
 * agent's own documented default applies, and the server writes down which
 * one that was.
 */
export function unattendedValue(c: Control): string | undefined {
  if (c.kind !== "mode") return undefined;
  return c.choices.find((v) => v.caution === "neverAsks")?.value;
}
