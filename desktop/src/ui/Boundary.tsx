import { RotateCw, TriangleAlert } from "lucide-react";
/**
 * What to show when a screen throws.
 *
 * A render error unmounts the tree, and an unmounted tree in a window with no
 * browser chrome is a black rectangle — no message, no console anybody is
 * looking at, no way back. That is how a one-line mistake in the new-workspace
 * form turned into "the app
 * went blank", which is unreportable as a bug.
 *
 * So: keep the shell, say what broke, and offer the way out. Deliberately not
 * pretty — it should look like something went wrong.
 *
 * **What is caught is `unknown`, and the fact of it is held apart from the
 * value.** `throw` takes any expression, so a boundary is handed whatever was
 * thrown and not an `Error`: a string, a rejected value, `null`, `undefined`.
 * This stored the thrown thing *as* the state and asked `if (!error)` — so a
 * falsy throw read as "nothing went wrong", the children were rendered again,
 * and React, finding the same subtree throwing a second time, gave the whole
 * root up. The window went white with no message anywhere, which is the exact
 * failure this component exists to prevent, arriving through the component
 * meant to prevent it. `stopped` is the fact; `said` is whatever the thrown
 * thing could be persuaded to say about itself.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode; onReset?: () => void };
type State = { stopped: boolean; said: string; where: string | null };

/**
 * What a thrown thing says for itself, for somebody copying it into a report.
 *
 * `error.message` was read off it directly, which is empty for every throw
 * that is not an `Error` — so the one panel on the screen whose whole job is
 * to be pasted into a bug report came out blank for exactly the throws that
 * are hardest to diagnose without it. The *kind* of the thrown thing is part
 * of the report: "undefined was thrown" is a different bug from a message
 * that happens to be missing, and a reader cannot tell the two apart from an
 * empty box.
 */
export function said(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message || thrown.name || "An Error with no message.";
  if (typeof thrown === "string") return thrown || "An empty string was thrown.";
  if (thrown === undefined) return "undefined was thrown.";
  if (thrown === null) return "null was thrown.";
  try {
    // A thrown object may be anything, including one whose `toString` throws.
    // Failing here would replace the screen that says what broke with nothing.
    return String(thrown);
  } catch {
    return `A ${typeof thrown} was thrown, and it could not be read.`;
  }
}

export class Boundary extends Component<Props, State> {
  state: State = { stopped: false, said: "", where: null };

  static getDerivedStateFromError(thrown: unknown): Partial<State> {
    return { stopped: true, said: said(thrown) };
  }

  componentDidCatch(thrown: unknown, info: ErrorInfo) {
    // The component stack is the only thing that says *which* screen, and it
    // is not in the message.
    this.setState({ where: info.componentStack?.split("\n").slice(1, 4).join("\n") ?? null });
    console.error("[firetower] a screen threw", thrown, info.componentStack);
  }

  render() {
    const { stopped, said: detail, where } = this.state;
    if (!stopped) return this.props.children;

    return (
      <div className="grid h-full min-w-0 flex-1 place-items-center bg-panel px-6">
        <div className="w-full max-w-[32rem] text-center">
          <span className="mx-auto grid h-11 w-11 place-items-center text-brick">
            <TriangleAlert className="h-6 w-6" strokeWidth={1.5} />
          </span>
          <h1 className="mt-3 text-display font-mid text-bone">This screen stopped</h1>
          <p className="mt-2 text-read text-dim">
            Something in the interface threw. The server is fine and nothing was lost — this is
            the client.
          </p>

          {/* **A quiet panel, not a red block.** The detail is for copying into
              a report, and filling a box with brick says the app is broken when
              what broke is one screen of it. */}
          <pre className="scroll-slim mt-4 max-h-40 overflow-auto rounded-xl bg-raise px-3.5 py-3 text-left font-mono text-code whitespace-pre-wrap text-dim">
            {detail}
            {where ? `\n${where}` : ""}
          </pre>

          <div className="mt-4 flex items-center justify-center gap-2">
            <button
              onClick={() => {
                this.setState({ stopped: false, said: "", where: null });
                this.props.onReset?.();
              }}
              className="btn primary"
            >
              Back to the Dashboard
            </button>
            {/* **Try again, not Reload.** Re-rendering the screen is what this
                needs; reloading the window throws away every other screen's
                state to fix one of them. */}
            <button
              onClick={() => this.setState({ stopped: false, said: "", where: null })}
              className="btn plain"
            >
              <RotateCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              Try again
            </button>
            <button
              onClick={() => void navigator.clipboard?.writeText(`${detail}\n${where ?? ""}`)}
              className="btn quiet"
            >
              Copy the detail
            </button>
          </div>

          <p className="mt-5 text-meta text-mute">
            Only this screen stopped. The rail, the panel and anything running carry on — leaving
            is one click, not a restart.
          </p>
        </div>
      </div>
    );
  }
}
