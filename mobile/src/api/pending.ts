/**
 * What one workspace is blocked on, found without opening it.
 *
 * This exists for the peek, and the peek exists for one reason: coverage §5's
 * **P4**, *answer a waiting agent without a round trip into the workspace*.
 * Four waiting agents should be cheaper than four round trips, and a preview
 * you cannot answer from is not cheaper than anything — it is the same four
 * trips with a photograph in front of them.
 *
 * ## Why a fetch is needed at all
 *
 * `useAnswerRequest` wants a `req`, and **a `Session` does not carry one**. The
 * list the home is drawn from knows a workspace is `NeedsYou`; it does not
 * know what it was asked. `Asked` is only ever produced by *folding* the
 * conversation's events — there is no field on the snapshot and no endpoint
 * that lists pending requests. So the request id can be reached in exactly one
 * way: read the events and fold them.
 *
 * ## Why this is not `useConversation`
 *
 * That hook is the right thing for a screen and the wrong thing for a
 * long-press. It writes into `held`, opens a socket subscription and keeps it
 * until the reader goes away — so a gesture would start a stream that then has
 * to be torn down on dismiss, and a mis-torn-down stream is a leak nobody sees.
 *
 * This does neither. `getConversation` is a plain GET and `foldAll` is a pure
 * function over its events, so a peek costs **one bounded request and nothing
 * ongoing**. Nothing is cached, because the thing being read is a question
 * that is about to stop being true.
 *
 * ## A tail, then the whole thing if the tail was wrong
 *
 * `getConversation(id)` with no params returns everything — the generated
 * contract says `hasMore` is "always false when neither `tail` nor `before`
 * was asked for". Exact, and up to `maxEvents` (4000) on a long-press,
 * possibly on cellular, for something presented as a preview.
 *
 * A `tail` is far cheaper, and the argument that it is safe is that an
 * approval *blocks* the agent, so nothing is produced after it and the
 * `Asked` is necessarily near the end. That is very likely true, and it is a
 * claim about **server** behaviour that this client cannot verify — exactly
 * the kind of "very likely" that should not be load-bearing.
 *
 * So it is not load-bearing. The tail is read first, and **when the caller
 * says this workspace is blocked and the tail produced no `Asked`, the whole
 * conversation is read and folded again**. The cheap path covers the common
 * case; the exact path covers the case the assumption was protecting. If the
 * assumption is wrong the only cost is a second request, not a wrong answer —
 * which is what makes the optimisation safe to take at all.
 *
 * The narrow endpoint that would make all of this unnecessary — one that
 * returns a session's pending requests — is the right eventual shape and is
 * server work. Noted on the pull request as a follow-up rather than done here.
 *
 * ## What it is read for travels with it
 *
 * A hook keeps its state in a **slot**, and the slot outlives the session in
 * it. The peek asks for two of these by position, so when the blocked set
 * changes — one agent unblocks while a row is held, and the next slides up a
 * place — the slot's state is still the previous session's for exactly one
 * commit, the one before its effect runs. For one frame it drew one agent's
 * name over another agent's request, and a press submitted that pair.
 *
 * Nobody was answering as somebody else: `host_to_speak_in` wants the target
 * session and Writer on its workspace. What it could do is worse in a
 * quieter way — a request id is only unique *within* a session (Codex numbers
 * them from one), so the stale id can name a real and different permission in
 * the session it lands on. Allow, pressed on a question that was never shown.
 *
 * So the session a read is about travels with the read, and the slot is
 * compared against it **while rendering** rather than in an effect. An effect
 * is a frame late by construction, and a frame is where this lived.
 */
import { useEffect, useState } from "react";
import { foldAll, nothing, type Asked } from "~/api/conversation";
import { getConversation } from "~/api/generated/sessions/sessions";

export type Pending = {
  /**
   * The session the rest of this is about.
   *
   * Carried rather than assumed. The caller knows which session it asked
   * for; this is what lets it prove the answer it is holding came from that
   * question and not from the one that was in this slot before.
   */
  of: string | null;
  /** What it is blocked on, once it is known. */
  asked: Asked | null;
  /** True while the one request is in flight. */
  reading: boolean;
  /** The server refused or could not be reached; the peek offers no answer. */
  failed: boolean;
};

const idle: Pending = { of: null, asked: null, reading: false, failed: false };

/**
 * Read one session's pending request, once.
 *
 * `sessionId` is null when nothing is peeked, which is the normal state — the
 * effect does nothing and no request is made until somebody holds a row.
 */
/**
 * How much of the end to read first.
 *
 * `PAGE` in `conversation.ts` is 8 exchanges and is tuned for reading back
 * through a transcript. This wants the last *few* events rather than the last
 * few exchanges, and a blocked agent's request is the final thing that
 * happened — so this is generous by the standards of what it is looking for
 * and still a fraction of a long conversation.
 */
const TAIL = 24;

export function usePending(sessionId: string | null, blocked: boolean): Pending {
  const [state, setState] = useState<Pending>(idle);

  useEffect(() => {
    if (!sessionId) {
      setState(idle);
      return;
    }
    /* A peek dismissed before the answer lands must not write to a component
       that has moved on, and must not leave a stale `asked` behind for the
       next row somebody holds. */
    let live = true;
    setState({ of: sessionId, asked: null, reading: true, failed: false });

    const read = async (): Promise<Asked | null> => {
      const tail = foldAll(nothing, (await getConversation(sessionId, { tail: TAIL })).events);
      if (tail.asked[0]) return tail.asked[0];
      /* The tail said nothing is pending. If the list says this workspace is
         blocked, the tail was the wrong window — read the whole thing and
         fold it exactly. One extra request, never a wrong answer. */
      if (!blocked) return null;
      return foldAll(nothing, (await getConversation(sessionId)).events).asked[0] ?? null;
    };

    read()
      .then((asked) => {
        if (!live) return;
        setState({ of: sessionId, asked, reading: false, failed: false });
      })
      .catch((e) => {
        if (!live) return;
        /* No answer offered rather than a wrong one. A peek that drew Allow
           and Deny over a request it could not read would be a button that
           does nothing, which is worse than the menu on its own. */
        console.warn("[firetower] could not read what this workspace is asking", e);
        setState({ of: sessionId, asked: null, reading: false, failed: true });
      });

    return () => {
      live = false;
    };
  }, [sessionId]);

  /* **Here, not in the effect.** The effect above clears the slot when the
     session in it changes, and it runs *after* the commit that changed it —
     so by itself it clears the frame after the one somebody could press. A
     read belongs to the session it was made for or it is not an answer yet,
     and that is a question this render can settle on its own. */
  if (state.of !== sessionId) {
    return sessionId ? { of: sessionId, asked: null, reading: true, failed: false } : idle;
  }

  return state;
}

/** The same read, for somewhere that is not a hook. */
export async function pendingFor(sessionId: string): Promise<Asked | null> {
  const snapshot = await getConversation(sessionId);
  return foldAll(nothing, snapshot.events).asked[0] ?? null;
}
