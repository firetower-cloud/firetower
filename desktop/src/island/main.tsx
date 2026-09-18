/**
 * The island's entry point — its own HTML, not a route in the app.
 *
 * A route would mean booting the whole client to draw a pill: the keychain
 * read that `src/main.tsx` awaits before its first frame, the server registry,
 * the query cache, xterm. None of that is anything the island uses, and all of
 * it would be loaded twice in a process that is meant to sit idle all day.
 */
import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "~/styles.css";
import "./island.css";
import "~/platform";
import { Island } from "./Island";
import { visible } from "./shell";

/**
 * A broken island gets out of the way.
 *
 * `Boundary` is the right answer for a screen — keep the shell, say what
 * broke, offer the way back. It is the wrong answer here: there is no shell to
 * keep, and a red error card pinned above every other window with no way to
 * dismiss it is worse than the bug it is reporting. So this one hides, and
 * says so where a developer will find it.
 */
class Retreat extends Component<{ children: ReactNode }, { broken: boolean }> {
  state = { broken: false };

  static getDerivedStateFromError() {
    return { broken: true };
  }

  componentDidCatch(error: Error) {
    console.error("[firetower] the island threw; hiding it", error);
    void visible(false);
  }

  render() {
    return this.state.broken ? null : this.props.children;
  }
}

createRoot(document.getElementById("island")!).render(
  <StrictMode>
    <Retreat>
      <Island />
    </Retreat>
  </StrictMode>,
);
