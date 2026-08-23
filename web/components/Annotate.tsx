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
 * pressing it opens a box; what gets written is kept against the words it was
 * written about.
 *
 * The offer only appears for a selection that is actually inside this message.
 * A drag that starts in the transcript and ends in the composer is not somebody
 * annotating, and a button that appears then is a button in the way.
 */
export function Annotatable({
  item,
  onAdd,
  children,
}: {
  item: string;
  onAdd: (item: string, quote: string, note: string) => void;
  children: React.ReactNode;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [offer, setOffer] = useState<{ quote: string; x: number; y: number } | null>(null);
  const [writing, setWriting] = useState<string | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    const within = area.current;
    if (!within) return;

    return watch(within, (range, quote) => {
      // Mid-write, the selection is irrelevant and moving the box is hostile.
      if (writing !== null) return;
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
  }, [writing]);

  const save = () => {
    const said = note.trim();
    if (writing && said) onAdd(item, writing, said);
    setWriting(null);
    setNote("");
    setOffer(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div ref={area} className="relative">
      {children}

      {offer && writing === null && (
        <button
          onMouseDown={(e) => {
            // Before the click, or the selection is gone by the time we read it.
            e.preventDefault();
            setWriting(offer.quote);
            setOffer(null);
          }}
          style={{ left: offer.x, top: offer.y }}
          className="absolute z-20 -translate-x-1/2 -translate-y-[calc(100%+6px)] rounded-[6px] border border-line bg-panel px-2 py-1 text-[11.5px] text-dim shadow-lg transition-colors hover:border-ember hover:text-bone"
        >
          Annotate
        </button>
      )}

      {writing !== null && (
        <div className="mt-2 rounded-[8px] border border-ember-deep bg-panel p-2.5">
          <blockquote className="mb-2 border-l-2 border-ember-deep pl-2.5 text-[12.5px] text-dim">
            {writing.length > 240 ? `${writing.slice(0, 240)}…` : writing}
          </blockquote>
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                save();
              }
              if (e.key === "Escape") {
                setWriting(null);
                setNote("");
              }
            }}
            rows={2}
            placeholder="What about it?"
            className="w-full resize-none rounded-[6px] border border-line bg-ground px-2.5 py-2 text-[12.5px] text-text placeholder:text-mute focus:border-ember focus:outline-none"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={save}
              disabled={!note.trim()}
              className="min-h-[32px] rounded-[6px] bg-ember px-3 text-[12px] font-medium text-ground disabled:opacity-40"
            >
              Keep
            </button>
            <button
              onClick={() => {
                setWriting(null);
                setNote("");
              }}
              className="min-h-[32px] rounded-[6px] px-2 text-[12px] text-mute transition-colors hover:text-text"
            >
              Cancel
            </button>
            <span className="ml-auto text-[11px] text-mute">Kept until you send them</span>
          </div>
        </div>
      )}
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
          className="rounded-[8px] border border-line bg-panel px-2.5 py-2"
        >
          <blockquote className="mb-1.5 border-l-2 border-line pl-2.5 text-[12px] text-mute">
            {note.quote.length > 160 ? `${note.quote.slice(0, 160)}…` : note.quote}
          </blockquote>
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[12.5px] whitespace-pre-wrap text-text">
              {note.note}
            </p>
            <button
              onClick={() => onDrop(note.id)}
              aria-label="Remove this note"
              className="shrink-0 text-[12px] text-mute transition-colors hover:text-brick"
            >
              ×
            </button>
          </div>
        </li>
      ))}
    </ol>
  );
}
