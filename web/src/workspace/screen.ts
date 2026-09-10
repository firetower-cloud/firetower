"use client";

/**
 * Which of the four things a workspace is showing, when it can only show one.
 *
 * Above `xl` this does not exist: the conversation is in the pane and Files,
 * Changes and Ship are in the panel beside it, all visible at once. Below it
 * there is one column, so they take turns, and this is whose turn it is.
 *
 * ## Why it is not `usePanel`
 *
 * The panel store answers a neighbouring question — which of its three views
 * is forward, and whether it is collapsed — and it would have taken a fourth
 * value. It is the wrong place: `panel.view` is remembered across sessions and
 * across reloads because a side panel somebody set to Ship should still be on
 * Ship tomorrow, and the answer to "what am I looking at in this workspace
 * right now" should not be. Arriving at a workspace from a notification and
 * landing on a file tree because that is where you were last week is not
 * continuity, it is the app losing your place.
 *
 * So this resets to the conversation, per session, and is never written down.
 *
 * ## Why a module store rather than a context
 *
 * Same reason as the panel's: the header's switcher, the `⋯` menu and the
 * Changes view's own "Review & ship" button all move it, and they are three
 * levels apart in the tree. Threading a callback through would mean every
 * component in between carrying a prop it has no use for.
 */

import { useCallback, useSyncExternalStore } from "react";

export type Screen = "chat" | "files" | "changes" | "ship";

/**
 * The three in the switcher, in the order a phone wants them.
 *
 * Files is not here. It is in the `⋯` menu, because the two errands somebody
 * opens this on a phone for are answering an agent and shipping what it wrote
 * — and browsing a directory tree is neither.
 */
export const SCREENS: { id: Screen; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "changes", label: "Diff" },
  { id: "ship", label: "Ship" },
];

let screen: Screen = "chat";
const watching = new Set<() => void>();

function tell() {
  for (const watcher of watching) watcher();
}

function listen(onChange: () => void) {
  watching.add(onChange);
  return () => {
    watching.delete(onChange);
  };
}

export function useScreen() {
  const now = useSyncExternalStore(
    listen,
    () => screen,
    () => "chat" as Screen,
  );

  const show = useCallback((next: Screen) => {
    if (screen === next) return;
    screen = next;
    tell();
  }, []);

  return { screen: now, show };
}

/**
 * Back to the conversation.
 *
 * Called when the workspace changes, so a new one opens on its agent rather
 * than on whichever view the last one was left on. Outside React because the
 * caller is an effect that already has the session id and no reason to
 * subscribe to this.
 */
export function resetScreen() {
  if (screen === "chat") return;
  screen = "chat";
  tell();
}
