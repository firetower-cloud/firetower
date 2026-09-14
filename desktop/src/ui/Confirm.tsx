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
      <div onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal className="w-[26rem] overflow-hidden rounded-xl border border-line bg-overlay shadow-(--shadow-float)">
        <div className="px-5 pt-4 pb-3">
          <h2 className="text-lede text-bone">{q.title}</h2>
          {q.body && <div className="mt-2 text-ui leading-relaxed text-dim">{q.body}</div>}
          {q.field && (
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && yes()}
              placeholder={q.field.placeholder}
              className="mt-3 w-full rounded-md border border-line bg-ground px-2.5 py-1.5 text-ui text-bone placeholder:text-mute focus:border-mute focus:outline-none"
            />
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-panel/60 px-4 py-2.5">
          <button onClick={() => onSettle(q.field ? null : false)} className="control text-dim hover:bg-raise hover:text-bone">{q.cancel ?? "Cancel"}</button>
          <button ref={go} onClick={yes} disabled={!!q.field && !value.trim()} className={`control font-medium disabled:opacity-50 ${q.tone === "danger" ? "bg-brick text-ground hover:opacity-90" : "bg-bone text-ground hover:opacity-90"}`}>
            {q.action}
          </button>
        </div>
      </div>
    </div>
  );
}
