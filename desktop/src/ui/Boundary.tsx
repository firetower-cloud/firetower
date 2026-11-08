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
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode; onReset?: () => void };
type State = { error: Error | null; where: string | null };

export class Boundary extends Component<Props, State> {
  state: State = { error: null, where: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The component stack is the only thing that says *which* screen, and it
    // is not in the message.
    this.setState({ where: info.componentStack?.split("\n").slice(1, 4).join("\n") ?? null });
    console.error("[firetower] a screen threw", error, info.componentStack);
  }

  render() {
    const { error, where } = this.state;
    if (!error) return this.props.children;

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
            {error.message}
            {where ? `\n${where}` : ""}
          </pre>

          <div className="mt-4 flex items-center justify-center gap-2">
            <button
              onClick={() => {
                this.setState({ error: null, where: null });
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
              onClick={() => this.setState({ error: null, where: null })}
              className="btn plain"
            >
              <RotateCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              Try again
            </button>
            <button
              onClick={() => void navigator.clipboard?.writeText(`${error.message}\n${where ?? ""}`)}
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
