"use client";

/**
 * The keys a tabbed workbench is expected to have.
 *
 * Only the ones whose absence would be noticed. Anything that duplicates a
 * browser shortcut is left alone: taking `⌘T` or `⌘W` from a browser to mean
 * something else inside one page is the kind of cleverness that loses somebody
 * a tab they meant to keep, so closing is `⌘⌥W` and there is no `⌘T`.
 *
 * Nothing here fires while a field has focus. A person typing a message is
 * typing a message, and `1` in a prompt must never mean "go to the first tab".
 */

import { useEffect } from "react";
import { paneTabs, useTabs } from "./tabs";

export function useWorkbenchKeys() {
  const { state, focus, close, move, unsplit, focusPane } = useTabs();

  useEffect(() => {
    const pressed = (e: KeyboardEvent) => {
      const on = e.target as HTMLElement | null;
      if (on && (on.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(on.tagName))) return;
      if (!e.metaKey && !e.ctrlKey) return;

      const here = paneTabs(state, state.focused);
      const active = state.active[state.focused];

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
        if (state.split) unsplit();
        else if (active) move(active, 1);
        return;
      }

      // ⌘⌥← / → — step between the halves of a split.
      if (state.split && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        focusPane(e.key === "ArrowLeft" ? 0 : 1);
      }
    };

    window.addEventListener("keydown", pressed);
    return () => window.removeEventListener("keydown", pressed);
  }, [state, focus, close, move, unsplit, focusPane]);
}
