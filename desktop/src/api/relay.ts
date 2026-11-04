/**
 * Messages one agent relays to another, told apart from what a person typed.
 *
 * A child's result and a lead's steer both reach the other agent as a user
 * turn — that is the only thing an agent reads as input — so in the raw
 * transcript they look like you spoke. The control plane marks them on their
 * first line, and this reads the mark so the conversation can draw a card from
 * the other agent instead of a bubble from you.
 *
 * The mark is `⟦ft:<kind>:<session>:<name>⟧`, written by
 * `crates/ft-server/src/delegate.rs::relay_marker`. Keep the two in step.
 */

export type Relay = {
  /** `handback` — a child reporting its result. `update` — a child checking in
   *  mid-task, without stopping. `steer` — a lead to a child. */
  kind: "handback" | "update" | "steer";
  /** The other session: the child for a hand-back or update, the lead for a steer. */
  id: string;
  /** What that session is called, for the card's label. */
  name: string;
  /** The message itself, with the mark and the join separators removed. */
  body: string;
};

// The name runs to the closing bracket, so a name with spaces or a slash is
// fine; only `⟧` or a newline ends it, and nothing names a session that.
const MARK = /⟦ft:(handback|update|steer):(s_[a-z0-9]+):([^⟧\n]*)⟧\n?/g;

/**
 * Every relayed message in one user turn, in order.
 *
 * Usually one. A lead that was mid-turn when several children handed back gets
 * them joined into a single turn (`\n\n---\n\n` between), so one user message
 * can carry several — each becomes its own card.
 */
export function relays(text: string | undefined | null): Relay[] {
  if (!text) return [];
  const marks = [...text.matchAll(MARK)];
  if (marks.length === 0) return [];

  return marks.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    // Strip the separator the join leaves before the next mark.
    const body = text.slice(start, end).replace(/\n*-{3,}\n*$/, "").trim();
    return { kind: m[1] as Relay["kind"], id: m[2], name: m[3], body };
  });
}
