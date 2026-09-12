/**
 * What to show when a screen throws.
 *
 * A render error unmounts the tree, and an unmounted tree in a window with no
 * browser chrome is a black rectangle — no message, no console anybody is
 * looking at, no way back. That is how a one-line mistake in the new-workspace
 * form (reading a fixture table by a real server's id) turned into "the app
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
      <div className="grid h-full min-w-0 flex-1 place-items-center bg-ground px-6">
        <div className="w-full max-w-[30rem]">
          <h1 className="text-title text-bone">This screen stopped</h1>
          <p className="mt-2 text-read text-dim">
            Something in the interface threw. The server is fine and nothing was lost — this is
            the client.
          </p>

          <pre className="scroll-slim mt-4 max-h-40 overflow-auto rounded-xl border border-brick-deep bg-brick-tint px-3.5 py-3 font-mono text-code whitespace-pre-wrap text-brick">
            {error.message}
            {where ? `\n${where}` : ""}
          </pre>

          <div className="mt-4 flex gap-2">
            <button
              onClick={() => {
                this.setState({ error: null, where: null });
                this.props.onReset?.();
              }}
              className="control flex-1 justify-center bg-bone font-medium text-ground hover:opacity-90"
            >
              Back to the dashboard
            </button>
            <button
              onClick={() => window.location.reload()}
              className="control flex-1 justify-center border border-line bg-raise text-text hover:bg-overlay"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
