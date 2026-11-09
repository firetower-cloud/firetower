/**
 * Words waiting in a composer that has not been drawn yet.
 *
 * Starting a workspace from a task fills the first message in, and then the
 * screen navigates — so the text is written on one screen and read on another.
 * This is the handoff.
 *
 * ## Why it is not sent
 *
 * The new-workspace form has always deliberately sent no prompt: the agent
 * starts and waits, and what you want doing is said in the conversation where
 * it can be answered. Building the issue into a prompt and sending it walks
 * past that — an agent editing files before anybody has read the issue.
 *
 * So the issue lands in the composer instead, unsent. Add "let's plan this
 * before touching anything" above it, delete half of it, or press send
 * unchanged. The agent starts working when a person decides it should.
 *
 * ## Why memory
 *
 * The desktop uses `sessionStorage` — a draft belongs to the tab that started
 * it. A phone has no tabs and no session storage, and the handoff is two
 * screens apart in one navigation, so a module-level map is exactly the right
 * amount of durability. It does not survive the app being killed, which is
 * correct: an issue nobody sent in that time is one they can open again.
 */
const held = new Map<string, string>();

/** Leave a first message for a session that is not on screen yet. */
export function leaveDraft(sessionId: string, text: string) {
  held.set(sessionId, text);
}

/**
 * Take it, once.
 *
 * Removed on read so that coming back to the workspace does not put the issue
 * back on top of whatever has since been typed or sent.
 */
export function takeDraft(sessionId: string): string | null {
  const text = held.get(sessionId);
  if (text === undefined) return null;
  held.delete(sessionId);
  return text;
}

/**
 * Forget every draft, because somebody signed out.
 *
 * **Not a fourth instance of the identity bug, and worth saying why.** A draft
 * is keyed on `sessionId` alone, with no account dimension — the same shape as
 * the cache that leaked. It does not leak: session ids are unique per
 * Firetower, so two accounts never produce the same key, and a second person
 * could not open the session a draft belongs to anyway.
 *
 * What it *was* doing is outliving the person who typed it. A draft is private
 * text somebody wrote and did not send, and it sat in module memory for the
 * rest of the process after they signed out. That is the same objection
 * `forgetConversations` exists for — "leaving it warm for an account somebody
 * has signed out of is not a cache, it is a copy" — one surface over.
 *
 * Everything goes rather than one identity's, because the key cannot tell them
 * apart and a draft is a two-screen handoff that does not survive the app
 * being killed either. Clearing it on a sign-out costs nothing anybody would
 * miss.
 */
export function forgetDrafts() {
  held.clear();
}
