"use client";

/**
 * The keys a tabbed workbench is expected to have.
 *
 * Only the ones whose absence would be noticed. Anything that duplicates a
 * browser shortcut is left alone: taking `⌘T` or `⌘W` from a browser to mean
 * something else inside one page is the kind of cleverness that loses somebody
 * a tab they meant to keep, so closing is `⌘⌥W` and there is no `⌘T`.
 *
 * Nothing in `useWorkbenchKeys` fires while a field has focus. A person typing
 * a message is typing a message, and `1` in a prompt must never mean "go to the
 * first tab".
 *
 * `⌘P` is the exception on both counts — it takes a browser shortcut, and it
 * takes it while somebody is typing. It is still described here, with the rest
 * of the keyboard, because a rule about what a key means belongs in one file
 * even when the component that acts on it lives somewhere else. The finder
 * reads it: see `isFindFile`.
 */

import { useEffect } from "react";
import { paneTabs, useTabs } from "./tabs";
import { revealPanel, VIEWS } from "./panel";

/**
 * ⌘P — find a file.
 *
 * The one browser shortcut this app takes. Nobody prints a workbench, and every
 * editor somebody arrives here from has trained the same two keys; the browser's
 * own File › Print is still there for the case that proves us wrong.
 *
 * Matched on the physical key as well as the character it produces, so the P of
 * an AZERTY or Dvorak keyboard is the P people press. `⇧⌘P` is deliberately not
 * this — it is where a command palette goes.
 */
export function isFindFile(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return false;
  return e.code === "KeyP" || e.key.toLowerCase() === "p";
}

export function useWorkbenchKeys() {
  const { set, focus, close, move, unsplit, focusPane } = useTabs();

  useEffect(() => {
    const pressed = (e: KeyboardEvent) => {
      const on = e.target as HTMLElement | null;
      if (on && (on.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(on.tagName))) return;
      if (!e.metaKey && !e.ctrlKey) return;

      const here = paneTabs(set, set?.focused ?? 0);
      const active = set?.active[set.focused] ?? null;

      // ⌘⌥1..3 — the right panel's views. Before the plain ⌘1..9 test below,
      // which would otherwise take the digit first.
      if (e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const view = VIEWS.find((v) => v.key === e.key);
        if (view) {
          e.preventDefault();
          revealPanel(view.id);
          return;
        }
      }

      // ⌘1..9 — the nth tab of the pane you are in. ⌘9 is the last one,
      // whatever its number, which is the convention every browser uses.
      if (!e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const n = Number(e.key);
        const tab = n === 9 ? here.at(-1) : here[n - 1];
        if (tab) {
          e.preventDefault();
          focus(tab.id);
        }
        return;
      }

      // ⌘⌥W — close the tab in front of you. Not ⌘W: that closes the window,
      // and somebody with eight sessions open would only make the mistake once.
      if (e.altKey && e.key.toLowerCase() === "w") {
        if (active) {
          e.preventDefault();
          close(active);
        }
        return;
      }

      // ⌘\ — put what you are reading beside what you were reading.
      if (e.key === "\\") {
        e.preventDefault();
        if (set?.split) unsplit();
        else if (active) move(active, 1);
        return;
      }

      // ⌘⌥← / → — step between the halves of a split.
      if (set?.split && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        focusPane(e.key === "ArrowLeft" ? 0 : 1);
      }
    };

    window.addEventListener("keydown", pressed);
    return () => window.removeEventListener("keydown", pressed);
  }, [set, focus, close, move, unsplit, focusPane]);
}
