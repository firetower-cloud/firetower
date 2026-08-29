/**
 * Words waiting in a composer that has not been drawn yet.
 *
 * Starting a worktree from a task fills the first message in, and then the page
 * navigates — so the text is written on one screen and read on another. This is
 * the handoff.
 *
 * ## Why it is not sent
 *
 * `NewWorkspace` has always deliberately sent no prompt: the agent starts and
 * waits, and what you want doing is said in the conversation where it can be
 * answered. Building the issue into a prompt and sending it walked past that —
 * an agent was editing files before anybody had read the issue on this screen.
 *
 * So the issue lands in the composer instead, unsent. Add "let's plan this
 * before touching anything" above it, delete half of it, or press send
 * unchanged. The agent starts working when a person decides it should.
 *
 * ## Why the browser
 *
 * It does not survive to another machine, which is the right amount of
 * durability for something somebody is about to edit and send within ten
 * seconds. A column on the workspace would be a migration and a second place a
 * prompt can live; re-reading the task would be a request that can fail.
 *
 * Session storage rather than local: a draft belongs to the tab that started
 * it, and a second window opening the same workspace should not find half a
 * sentence in its composer.
 */

const KEY = "firetower.draft.";

/** Leave a first message for a session that does not exist on screen yet. */
export function leaveDraft(sessionId: string, text: string) {
  try {
    window.sessionStorage.setItem(KEY + sessionId, text);
  } catch {
    // Private windows and blocked site data. The worktree is still made and the
    // task is still on it; the composer just starts empty.
  }
}

/**
 * Take it, once.
 *
 * Removed on read so that reloading the page does not put the issue back on
 * top of whatever has since been typed or sent.
 */
export function takeDraft(sessionId: string): string | null {
  try {
    const held = window.sessionStorage.getItem(KEY + sessionId);
    if (held !== null) window.sessionStorage.removeItem(KEY + sessionId);
    return held;
  } catch {
    return null;
  }
}
