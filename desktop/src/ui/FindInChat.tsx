/**
 * ⌘F, in the conversation.
 *
 * A transcript is the longest thing in this app and the only one with no
 * index: an afternoon of work is a few thousand lines of prose with the one
 * command, path or name you are after somewhere in the middle of it. A window
 * has no browser find bar to fall back on, so the conversation carries its
 * own — the same shape as the terminal's (`Shell`), because it answers the
 * same question about the pane it sits in.
 *
 * **Ranges, not markup.** Matches are painted with the Custom Highlight API,
 * which colours a `Range` and owns no DOM. The obvious implementation —
 * wrapping each hit in a `<mark>` — puts nodes inside elements React is
 * streaming into, and the next token the agent writes silently overwrites
 * them; a fault that only appears on a live session and never in a test.
 * Where the API is missing the current match is *selected* instead, which is
 * the same picture by a cruder route and needs no DOM either.
 *
 * It reads one text node at a time, so a phrase broken across a link or a
 * `code` span is not found. That is the price of never owning the DOM, and
 * for what this is for — a path, a flag, a file name — it does not bite.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { isMac } from "~/platform";

/** The two highlight registries, styled by `::highlight()` in `styles.css`. */
const ALL = "ft-find";
const ON = "ft-find-on";

/**
 * Enough to light up a long transcript without walking a thousand ranges on
 * every keystroke. Past it, the answer is a longer query rather than more
 * highlights — so the count says `600+` and means it.
 */
const CAP = 600;

/**
 * Where `needle` sits in `hay`, case-insensitively: the start of each
 * non-overlapping match, in order.
 *
 * Plain text, not a pattern. Somebody looking for `foo(bar)` in a transcript
 * means those nine characters, and a find bar that read them as a regex would
 * answer a question nobody asked.
 */
export function hits(hay: string, needle: string): number[] {
  if (!needle) return [];
  const a = hay.toLowerCase();
  const b = needle.toLowerCase();
  const found: number[] = [];
  for (let at = a.indexOf(b); at !== -1; at = a.indexOf(b, at + b.length)) found.push(at);
  return found;
}

/** Every match under `scope`, as ranges that point at the live text nodes. */
function ranges(scope: HTMLElement, needle: string): Range[] {
  const found: Range[] = [];
  if (!needle) return found;
  const walk = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let node = walk.nextNode(); node && found.length < CAP; node = walk.nextNode()) {
    for (const at of hits(node.nodeValue ?? "", needle)) {
      if (found.length >= CAP) break;
      const span = document.createRange();
      span.setStart(node, at);
      span.setEnd(node, at + needle.length);
      found.push(span);
    }
  }
  return found;
}

type Registry = { set(name: string, highlight: object): void; delete(name: string): void };
type Paint = new (...ranges: Range[]) => object;

/**
 * The Custom Highlight API, where this webview has one.
 *
 * Reached through a cast rather than the DOM typings: the app ships to macOS
 * 12 and up, where the WebKit under it may predate the API by several years,
 * so its absence is a case to handle and not a build-time question.
 */
function registry(): { highlights: Registry; Highlight: Paint } | null {
  const w = window as unknown as { CSS?: { highlights?: Registry }; Highlight?: Paint };
  if (!w.CSS?.highlights || !w.Highlight) return null;
  return { highlights: w.CSS.highlights, Highlight: w.Highlight };
}

/**
 * Bring a match into view, and only when it is not already there.
 *
 * Into the upper third rather than the middle, because what you are reading
 * is usually the line *after* the one you searched for. A match already on
 * screen is left alone — a find bar that scrolls on every keystroke makes the
 * page twitch under a word you can already see.
 */
function show(scroller: HTMLElement | null, span?: Range) {
  if (!scroller || !span) return;
  const spot = span.getBoundingClientRect();
  // Zero on both edges means the range's text node has left the document.
  if (spot.width === 0 && spot.height === 0) return;
  const view = scroller.getBoundingClientRect();
  const room = view.height * 0.2;
  if (spot.top >= view.top + room && spot.bottom <= view.bottom - room) return;
  scroller.scrollTop += spot.top - view.top - view.height / 3;
}

export function FindInChat({
  scroller,
  body,
  summoned,
  onClose,
}: {
  /** The pane that scrolls, which is what a match has to be brought into. */
  scroller: React.RefObject<HTMLDivElement | null>;
  /** The transcript itself — searched, so the composer and the chrome are not. */
  body: React.RefObject<HTMLDivElement | null>;
  /** Bumped on every ⌘F, so a second press re-takes the field rather than doing nothing. */
  summoned: number;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  /* Held in state rather than in a ref, and replaced wholesale every time.
     A count would not do: re-reading a turn the agent has just rewritten
     usually finds the *same number* of matches against brand new text nodes,
     and an effect keyed on the count would not fire — leaving the page
     painted through ranges that point at nodes no longer in the document. */
  const [found, setFound] = useState<Range[]>([]);
  const count = found.length;
  const field = useRef<HTMLInputElement>(null);

  const look = useCallback(() => {
    const scope = body.current;
    const list = scope ? ranges(scope, q.trim()) : [];
    setFound(list);
    setAt((n) => Math.min(n, Math.max(list.length - 1, 0)));
  }, [q, body]);

  useEffect(() => setAt(0), [q]);
  useEffect(() => look(), [look]);

  /* ⌘F with the bar already up means "search again", not "nothing happens" —
     the field comes back with what is in it selected, ready to be typed over. */
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [summoned]);

  /* The transcript is live. An agent streaming into it replaces the very text
     nodes these ranges point at, and a stale range paints nothing — so the
     search is re-run once the writing settles, rather than on every token. */
  useEffect(() => {
    const scope = body.current;
    if (!scope) return;
    let again: number | undefined;
    const watch = new MutationObserver(() => {
      window.clearTimeout(again);
      again = window.setTimeout(look, 250);
    });
    watch.observe(scope, { childList: true, subtree: true, characterData: true });
    return () => {
      watch.disconnect();
      window.clearTimeout(again);
    };
  }, [look, body]);

  /* Painting what was found, and going to the one you are on. */
  useEffect(() => {
    const api = registry();
    if (api) {
      if (found.length === 0) {
        api.highlights.delete(ALL);
        api.highlights.delete(ON);
      } else {
        api.highlights.set(ALL, new api.Highlight(...found));
        // Above the rest, whatever order the registry ended up in.
        const one = new api.Highlight(found[at]) as { priority?: number };
        one.priority = 1;
        api.highlights.set(ON, one);
      }
    } else {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      if (found[at]) sel?.addRange(found[at].cloneRange());
    }
    show(scroller.current, found[at]);
  }, [found, at, scroller]);

  /* Nothing of this outlives the bar: the highlights are global to the
     document, and a conversation left glowing after ⎋ would be the app
     remembering a search nobody is running. */
  useEffect(
    () => () => {
      const api = registry();
      if (api) {
        api.highlights.delete(ALL);
        api.highlights.delete(ON);
      } else window.getSelection()?.removeAllRanges();
    },
    [],
  );

  const step = (by: number) => setAt((n) => (count === 0 ? 0 : (n + by + count) % count));
  const none = !!q.trim() && count === 0;

  return (
    <div className="absolute top-3 right-5 z-30 flex items-center gap-1.5 rounded-md border border-line bg-panel py-1 pr-1 pl-2.5 shadow-(--shadow-float)">
      <Search className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.75} />
      <input
        ref={field}
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            step(1);
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            step(-1);
          }
        }}
        placeholder="Find in conversation"
        className="w-52 min-w-0 bg-transparent text-meta text-bone placeholder:text-mute focus:outline-none"
      />
      {/* A count, not a verdict: `none` is the honest word for a query that
          matched nothing, and `600+` for one that matched more than is worth
          lighting up. */}
      <span className={`w-16 shrink-0 text-right font-mono text-micro tabular-nums ${none ? "text-dim" : "text-mute"}`}>
        {none ? "none" : count === 0 ? "" : `${at + 1}/${count}${count === CAP ? "+" : ""}`}
      </span>
      <button
        disabled={count === 0}
        onClick={() => step(-1)}
        title={`Previous  ${isMac ? "⇧⏎" : "Shift+⏎"}`}
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-mute transition-colors hover:bg-raise hover:text-bone disabled:text-line"
      >
        <ChevronUp className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
      <button
        disabled={count === 0}
        onClick={() => step(1)}
        title="Next  ⏎"
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-mute transition-colors hover:bg-raise hover:text-bone disabled:text-line"
      >
        <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
      <button
        onClick={onClose}
        title="Close  esc"
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-mute transition-colors hover:bg-raise hover:text-bone"
      >
        <X className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}
