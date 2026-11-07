/**
 * Asking before something is undone.
 *
 * The app's own dialog rather than the browser's `confirm()`: a webview has
 * no browser chrome to put a system sheet in, and a question nobody can see
 * is answered "no". Asked as a promise — `if (!(await confirm({…}))) return;`
 * — so the code that asks reads like the sentence it puts on screen.
 *
 * `prompt` is the same dialog with a field in it, for the one question that
 * wants an answer rather than a yes: a new name.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Ask = {
  title: string;
  body?: ReactNode;
  /** The verb on the button: "End workspace", "Disconnect", "Remove". */
  action: string;
  cancel?: string;
  /** Destructive reads in brick; anything else in bone. */
  tone?: "danger" | "plain";
};
type Question = Ask & { field?: { placeholder?: string; initial?: string } };

type Pending = Question & { resolve: (answer: string | boolean | null) => void };

const Ctx = createContext<{ ask: (q: Question) => Promise<string | boolean | null> } | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = useCallback((q: Question) => new Promise<string | boolean | null>((resolve) => setPending({ ...q, resolve })), []);
  const settle = (answer: string | boolean | null) => {
    pending?.resolve(answer);
    setPending(null);
  };
  return (
    <Ctx.Provider value={{ ask }}>
      {children}
      {pending && <Dialog q={pending} onSettle={settle} />}
    </Ctx.Provider>
  );
}

/** Yes or no. */
export function useConfirm() {
  const ctx = useContext(Ctx);
  return useCallback(async (q: Ask) => (ctx ? (await ctx.ask(q)) === true : false), [ctx]);
}

/** A line of text, or nothing. */
export function usePrompt() {
  const ctx = useContext(Ctx);
  return useCallback(
    async (q: Ask & { placeholder?: string; initial?: string }) => {
      if (!ctx) return null;
      const answer = await ctx.ask({ ...q, field: { placeholder: q.placeholder, initial: q.initial } });
      return typeof answer === "string" ? answer : null;
    },
    [ctx],
  );
}

function Dialog({ q, onSettle }: { q: Pending; onSettle: (answer: string | boolean | null) => void }) {
  const [value, setValue] = useState(q.field?.initial ?? "");
  const go = useRef<HTMLButtonElement>(null);
  const yes = () => onSettle(q.field ? value.trim() || null : true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSettle(q.field ? null : false);
      if (e.key === "Enter" && !q.field) yes();
    };
    window.addEventListener("keydown", onKey);
    if (!q.field) go.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-[60] grid place-items-start justify-center bg-ground/40 pt-[18vh] backdrop-blur-[2px]" onMouseDown={() => onSettle(q.field ? null : false)}>
      <div onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal className="dlg">
        <div>
          <h2>{q.title}</h2>
          {q.body && <div className="say">{q.body}</div>}
          {q.field && (
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && yes()}
              placeholder={q.field.placeholder}
              className="mt-4 h-11 w-full rounded-xl bg-ground px-4 text-ui text-bone placeholder:text-mute focus:outline-none focus:ring-[1.5px] focus:ring-bone focus:ring-inset"
            />
          )}
        </div>
        {/* On the same ground as the words. A tinted strip under the buttons
            is a second surface and a rule, for a box with four lines in it. */}
        <div className="dlgfoot">
          <button onClick={() => onSettle(q.field ? null : false)} className="btn quiet">{q.cancel ?? "Cancel"}</button>
          <button ref={go} onClick={yes} disabled={!!q.field && !value.trim()} className={`btn ${q.tone === "danger" ? "harm" : "primary"} disabled:opacity-50`}>
            {q.action}
          </button>
        </div>
      </div>
    </div>
  );
}
