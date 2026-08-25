"use client";

import { useEffect, useRef, useState } from "react";
import type { Note } from "@/src/api/notes";

/**
 * One listener for the whole transcript.
 *
 * `selectionchange` fires continuously while somebody drags. A listener per
 * message means every message in a long conversation does that work on every
 * one of those events, to discover that the selection is not in it. So the
 * document is read once and only the message actually holding the selection is
 * told about it.
 */
const areas = new Map<HTMLElement, (range: Range | null, quote: string) => void>();

function watch(area: HTMLElement, tell: (range: Range | null, quote: string) => void) {
  if (areas.size === 0) document.addEventListener("selectionchange", look);
  areas.set(area, tell);
  return () => {
    areas.delete(area);
    if (areas.size === 0) document.removeEventListener("selectionchange", look);
  };
}

function look() {
  const picked = window.getSelection();
  const quote = picked?.toString().trim() ?? "";
  const range = picked && picked.rangeCount > 0 && quote.length >= 2 ? picked.getRangeAt(0) : null;

  for (const [area, tell] of areas) {
    const mine = range !== null && area.contains(range.commonAncestorContainer);
    tell(mine ? range : null, mine ? quote : "");
  }
}

/**
 * Selecting a passage and saying something about it.
 *
 * Wraps one message. Selecting text inside it offers a button by the selection;
 * pressing it — or simply typing — opens a box, and what gets written is kept
 * against the words it was written about.
 *
 * The offer only appears for a selection that is actually inside this message.
 * A drag that starts in the transcript and ends in the composer is not somebody
 * annotating, and a button that appears then is a button in the way.
 */
export function Annotatable({
  item,
  drafting,
  onBegin,
  children,
}: {
  item: string;
  /** Somebody is writing a note — about this passage or another one. */
  drafting: boolean;
  onBegin: (item: string, quote: string, first: string) => void;
  children: React.ReactNode;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [offer, setOffer] = useState<{ quote: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const within = area.current;
    if (!within) return;

    return watch(within, (range, quote) => {
      // Mid-write, the selection is irrelevant and moving the button is
      // hostile.
      if (drafting) return;
      if (!range) {
        setOffer(null);
        return;
      }

      // Positioned against this message rather than the page, so scrolling the
      // transcript takes the button with it.
      const box = range.getBoundingClientRect();
      const mine = within.getBoundingClientRect();
      setOffer({
        quote,
        x: box.left - mine.left + box.width / 2,
        y: box.top - mine.top,
      });
    });
  }, [drafting]);

  /**
   * Start writing the moment somebody types.
   *
   * The button is the discoverable way in; typing is the fast one, and it is
   * what anybody who has just highlighted a sentence in order to say something
   * about it will do anyway. The first keystroke is kept — it is the start of
   * the note, not the price of opening the box.
   */
  useEffect(() => {
    if (!offer || drafting) return;

    const key = (e: KeyboardEvent) => {
      // Somebody typing into the composer is typing into the composer, even
      // with a selection sitting in the transcript behind them.
      const on = e.target as HTMLElement | null;
      if (on && (on.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(on.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "Escape") {
        setOffer(null);
        window.getSelection()?.removeAllRanges();
        return;
      }

      // A character starts the note with it; Enter opens an empty box. Arrows,
      // tab and the rest are somebody navigating, and are left alone.
      const first = e.key.length === 1 ? e.key : e.key === "Enter" ? "" : null;
      if (first === null) return;

      e.preventDefault();
      onBegin(item, offer.quote, first);
      setOffer(null);
    };

    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [offer, drafting, item, onBegin]);

  return (
    <div ref={area} className="relative">
      {children}

      {offer && !drafting && (
        <button
          onMouseDown={(e) => {
            // Before the click, or the selection is gone by the time we read it.
            e.preventDefault();
            onBegin(item, offer.quote, "");
            setOffer(null);
          }}
          style={{ left: offer.x, top: offer.y }}
          className="absolute z-20 -translate-x-1/2 -translate-y-[calc(100%+6px)] rounded-[8px] border border-line bg-panel px-2.5 py-1.5 text-[12.5px] text-dim shadow-[0_8px_24px_-10px_rgba(0,0,0,0.8)] transition-colors hover:border-ember hover:text-bone"
        >
          Start typing to annotate
        </button>
      )}
    </div>
  );
}

/** A note being written: which passage, and what is being said about it. */
export type Draft = { item: string; quote: string; note: string };

/**
 * The note you are writing, docked below the transcript.
 *
 * Deliberately outside the scroller. It used to render under the message it
 * was about, which put it below the *whole* message — and focusing it made the
 * browser drag the transcript down until it appeared, 1800px from what you
 * were reading. The passage you selected is quoted here instead, so it costs
 * nothing to have scrolled away from it.
 */
export function Drafting({
  draft,
  onChange,
  onKeep,
  onCancel,
}: {
  draft: Draft;
  onChange: (note: string) => void;
  onKeep: () => void;
  onCancel: () => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);

  /**
   * Put the cursor after what is already there.
   *
   * `autoFocus` alone focuses the box but leaves the caret at the start, so the
   * character that opened it ended up at the end of everything typed after it —
   * "doit" arriving as "oitd". Focus and caret are set together, once, when the
   * box opens.
   *
   * `preventScroll` because this is still an element being focused: the dock
   * keeps the transcript out of it, and this keeps the window out of it too.
   */
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
    // Once per passage, not once per keystroke.
  }, [draft.item, draft.quote]);

  return (
    <div className="mb-2 shrink-0 rounded-[12px] border border-ember-deep bg-panel p-3">
      <blockquote className="mb-2 border-l-2 border-ember-deep pl-2.5 text-[13.5px] text-dim">
        {draft.quote.length > 240 ? `${draft.quote.slice(0, 240)}…` : draft.quote}
      </blockquote>
      <textarea
        ref={box}
        value={draft.note}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onKeep();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        rows={2}
        placeholder="What about it?"
        className="w-full resize-none rounded-[8px] border border-line bg-ground px-3 py-2.5 text-[13.5px] text-text placeholder:text-mute focus:border-ember focus:outline-none"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={onKeep}
          disabled={!draft.note.trim()}
          title="Keep (↵)"
          className="flex min-h-[34px] items-center gap-2 rounded-[8px] bg-ember px-3.5 text-[13px] font-medium text-ground disabled:opacity-40"
        >
          Keep
          <span aria-hidden className="font-mono text-[12px] opacity-60">
            ↵
          </span>
        </button>
        <button
          onClick={onCancel}
          className="min-h-[32px] rounded-[6px] px-2 text-[13px] text-mute transition-colors hover:text-text"
        >
          Cancel
        </button>
        <span className="ml-auto text-[12px] text-mute">Kept until you send them</span>
      </div>
    </div>
  );
}

/**
 * The notes already written against one message.
 *
 * Drawn under it rather than inside it. The message is rendered from markdown,
 * and threading highlights back through that is a lot of machinery to make a
 * passage yellow — where a margin note says the same thing, reads in order, and
 * cannot corrupt what the agent actually wrote.
 */
export function Notes({ notes, onDrop }: { notes: Note[]; onDrop: (id: string) => void }) {
  if (notes.length === 0) return null;
  return (
    <ol className="mt-2 flex flex-col gap-1.5">
      {notes.map((note) => (
        <li
          key={note.id}
          className="rounded-[12px] border border-line bg-panel px-3 py-2.5"
        >
          <blockquote className="mb-1.5 border-l-2 border-line pl-2.5 text-[13px] text-mute">
            {note.quote.length > 160 ? `${note.quote.slice(0, 160)}…` : note.quote}
          </blockquote>
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[13.5px] whitespace-pre-wrap text-text">
              {note.note}
            </p>
            <button
              onClick={() => onDrop(note.id)}
              aria-label="Remove this note"
              className="shrink-0 text-[13px] text-mute transition-colors hover:text-brick"
            >
              ×
            </button>
          </div>
        </li>
      ))}
    </ol>
  );
}
