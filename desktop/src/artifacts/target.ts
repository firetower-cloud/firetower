/**
 * Who a note on an artifact is sent to.
 *
 * **This used to be `artifact.fromSessionId` and nothing else, which was
 * wrong in the one case the library exists for.** That column is stamped text
 * rather than a foreign key — deliberately, so an artifact survives
 * `reclaim.rs` taking the workspace a minute after its last session ends. It
 * therefore goes on naming a session long after there is nothing behind the
 * name. The send button only checked it for `null`, so it stayed enabled and
 * the turn came back 404.
 *
 * The rule has two halves, and which one applies is decided by where the
 * artifact was opened rather than by anything about the artifact:
 *
 * * **Opened inside a workspace** — the conversation is on screen, and that is
 *   plainly who a note is for. Nothing to ask.
 * * **Opened from the library** — there is no conversation in view, so it is a
 *   question. The workspace that made it is offered when it is still running,
 *   because that is the likeliest answer; when it is gone there is no default
 *   at all, because posting into somebody's conversation is not a thing to do
 *   on a guess.
 *
 * Either way the answer is checked against what is *currently* running, which
 * is what stops the other half of the same bug: a session chosen a minute ago
 * can have ended since, and sending to it would fail exactly as before.
 */

/** As much of a session as this needs: whether it can still be sent to. */
export type Reachable = { id: string };

export function noteTarget({
  fixed,
  picked,
  running,
  origin,
}: {
  /** Settled by where the artifact was opened. `null` means it is a question. */
  fixed: string | null;
  /** What the person chose. `undefined` means they have not chosen yet. */
  picked: string | null | undefined;
  /** The sessions that can currently take a turn. */
  running: Reachable[];
  /** The session that published the artifact, if it recorded one. */
  origin: string | null;
}): string | null {
  // A workspace's own agent is not second-guessed: the caller is looking at
  // it, and it is the tab's own session rather than something remembered.
  if (fixed !== null) return fixed;

  const wanted = picked === undefined ? origin : picked;
  if (!wanted) return null;

  // The check that makes both halves safe — a remembered origin and a stale
  // choice fail the same way, by not being here any more.
  return running.some((s) => s.id === wanted) ? wanted : null;
}
