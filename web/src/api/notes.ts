/**
 * Notes on what the agent said, gathered before answering.
 *
 * Replying to a long turn is hard in one box: three things are wrong in three
 * places, and by the time you have written the third you have stopped being
 * specific about the first. So each one is written where it applies, against
 * the words it applies to, and they all go at once.
 *
 * ## They are a draft, and live in the browser
 *
 * Nothing here reaches the control plane until they are sent — sending them is
 * an ordinary message, which is the whole trick: no new frame, no new endpoint,
 * and the agent needs to understand nothing it does not already.
 *
 * They survive a reload, because losing six notes to a stray refresh is the
 * kind of thing that stops somebody using a feature. They live only in the
 * browser that made them: they are a person mid-thought, not a fact about the
 * session.
 */

import { useCallback, useSyncExternalStore } from "react";

export type Note = {
  id: string;
  /** The item the words came from, so the note is drawn against it. */
  item: string;
  /**
   * What was selected, verbatim.
   *
   * Stored rather than a position. The message is rendered from markdown, so a
   * position in the text on screen is not a position in the text the agent
   * wrote, and mapping between them is a source of subtle wrongness for no
   * benefit — what has to survive is the quote, and that is what is kept.
   */
  quote: string;
  /** What somebody said about it. */
  note: string;
};

const key = (session: string) => `firetower.notes.${session}`;

/**
 * The notes on one session.
 *
 * Storage is the store — read through rather than copied into state, so a
 * second tab on the same session sees the same notes and there is no moment
 * where the two disagree.
 *
 * Reading and writing can throw — a private window, a browser told to block
 * site data — so every access is guarded and an unreadable store simply means
 * no notes rather than a broken page.
 */
export function useNotes(session: string) {
  const notes = useSyncExternalStore(
    listen,
    () => snapshot(session),
    () => NONE,
  );

  const add = useCallback(
    (item: string, quote: string, note: string) => {
      write(session, [
        ...read(session),
        { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, item, quote, note },
      ]);
    },
    [session],
  );

  const drop = useCallback(
    (id: string) => write(session, read(session).filter((n) => n.id !== id)),
    [session],
  );

  const clear = useCallback(() => write(session, []), [session]);

  return { notes, add, drop, clear };
}

/** Nothing, as one object, so a server render and an empty store agree. */
const NONE: Note[] = [];

const watching = new Set<() => void>();

/**
 * Anything that changes the notes, including another tab.
 */
function listen(onChange: () => void) {
  watching.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    watching.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * The notes as they stand, as the same array until they actually change.
 *
 * React compares what this returns against what it returned last time, so
 * parsing afresh on every read would look like a change on every render. The
 * raw string is what gets compared; the parsed array is kept beside it.
 */
const held = new Map<string, { raw: string | null; notes: Note[] }>();

function snapshot(session: string): Note[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key(session));
  } catch {
    return NONE;
  }

  const last = held.get(session);
  if (last && last.raw === raw) return last.notes;

  let notes: Note[] = NONE;
  try {
    if (raw) notes = JSON.parse(raw) as Note[];
  } catch {
    notes = NONE;
  }

  held.set(session, { raw, notes });
  return notes;
}

function read(session: string): Note[] {
  return snapshot(session);
}

function write(session: string, notes: Note[]) {
  try {
    if (notes.length === 0) window.localStorage.removeItem(key(session));
    else window.localStorage.setItem(key(session), JSON.stringify(notes));
  } catch {
    // Nowhere to keep them. They still work for this visit, which is the part
    // that matters.
  }
  for (const tell of watching) tell();
}

/**
 * The notes, as something to say.
 *
 * Numbered, with each quote above the note about it, because that is how a
 * person would write it and the agent has to be able to tell which remark
 * belongs to which passage. Quotes are indented as a block so a passage
 * containing its own punctuation cannot be mistaken for the note.
 */
export function asMessage(notes: Note[]): string {
  const parts = notes.map((n, i) => {
    const quote = n.quote
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return `${i + 1}.\n${quote}\n\n${n.note}`;
  });

  return [
    notes.length === 1
      ? "A note on what you said:"
      : `${notes.length} notes on what you said:`,
    "",
    parts.join("\n\n"),
  ].join("\n");
}
