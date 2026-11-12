/**
 * A run of tool calls, as one row.
 *
 * A turn that reads four files, runs eight commands and edits three of them is
 * fifteen lines of rail before the sentence explaining what it did. Each line
 * is legible and the stack of them is not: the thing somebody is looking for —
 * what the agent *said*, or the one step that failed — is somewhere in the
 * middle of it.
 *
 * So consecutive tool calls fold into one row, closed. Nothing is hidden that
 * was not already one click away: a `Tool` row shows a verb and an argument
 * and puts its input and output behind a fold, and this puts the row itself
 * behind one more.
 *
 * `place` is here too, because where an artifact's card goes is decided
 * against these rows and against nothing else.
 *
 * Deliberately not a component. The rules below are list transforms with
 * edges — a run broken by prose, a step still running, a failure inside a
 * group, an artifact older than everything on screen — and each of those is
 * worth a test that does not need React to run.
 */

import type { ItemKind } from "./generated/model";
import type { Item } from "./conversation";

/** One line of the transcript: a thing, or a run of things. */
export type Row =
  | { type: "item"; item: Item }
  | {
      type: "group";
      /**
       * The first item's id.
       *
       * Not the index. Items stream in, so a group's position moves as the
       * turn goes on — keyed by position, React remounts the row on every
       * arrival and a group somebody opened snaps shut under them.
       */
      id: string;
      items: Item[];
    };

/**
 * The kinds that fold: exactly what `Tool` draws.
 *
 * Prose, reasoning, what somebody typed, a question and its answer, and a
 * subagent's own rail are all handled before a `Node` reaches `Tool`, and none
 * of them is noise. This list is the other side of that same decision, so the
 * two are meant to be read together.
 *
 * **`FileChange` is deliberately absent.** Folding exists to hide scaffolding —
 * the greps and the reads and the test runs somebody scrolls past on the way to
 * the point. An edit is not scaffolding; it is the work, and it is what the
 * session was started to produce. Summarising it as "changed 4 files" hid the
 * only part of a run anybody actually wants to check, and cost a click to
 * uncover the thing they came for.
 */
const FOLDS: ItemKind[] = [
  "CommandExecution",
  "FileRead",
  "McpToolCall",
  "WebSearch",
  "Unknown",
];

/**
 * How many in a row before folding is worth it.
 *
 * Two lines are not clutter, and a fold costs a click to read something that
 * was already legible.
 */
export const LEAST = 3;

/**
 * Whether this item draws nothing at all.
 *
 * Current models emit a reasoning block before almost every tool call and
 * leave its text out, so `Thought` renders null and the rail looks like an
 * unbroken run of commands. It was not one: an invisible item between two
 * calls still split the run, so three commands that read as consecutive came
 * out as three separate rows and nothing ever folded.
 *
 * These are dropped rather than kept, because a row nobody can see is not a
 * row — and passing them through would put them inside groups where they are
 * equally invisible.
 */
function silent(item: Item): boolean {
  return item.kind === "Reasoning" && !item.text;
}

/** Whether this item may disappear into a group. */
function foldable(item: Item): boolean {
  // Still going, so never. `Mark` draws `○` against a running step and that is
  // how somebody can tell the session has not hung — a group that swallows the
  // step in flight makes a working agent look like a frozen one.
  if (item.status === undefined) return false;
  // A step that handed back a picture is not scaffolding, for the same reason
  // an edit is not: the screenshot is what somebody is scrolling towards, and
  // "4 steps" puts it behind a click. The same decision `FileChange`'s absence
  // from the list above records.
  if (item.images?.length) return false;
  return FOLDS.includes(item.kind);
}

/**
 * The items on the main rail — what the agent you are talking to did itself.
 *
 * The normaliser tags everything a subagent does with the task that owns it,
 * for exactly this: without the split, several voices interleave into one
 * transcript and a delegated `grep` reads as though the main agent ran it.
 * Drawn on the main rail *and* inside the owning card, it was also drawn
 * twice.
 */
export function mainline(items: Item[]): Item[] {
  return items.filter((i) => i.task === undefined);
}

/** The items one subagent owns, for the card that stands for it. */
export function delegated(items: Item[], task: string): Item[] {
  return items.filter((i) => i.task === task);
}

/**
 * Turn a list of items into rows, folding runs of tool calls.
 *
 * `least` is a parameter so the tests can say what they mean rather than
 * building nine items to prove a boundary.
 */
export function fold(items: Item[], least: number = LEAST): Row[] {
  const rows: Row[] = [];
  let run: Item[] = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length >= least) {
      rows.push({ type: "group", id: run[0].id, items: run });
    } else {
      // Too short to be worth hiding. Drawn the way it always was.
      for (const item of run) rows.push({ type: "item", item });
    }
    run = [];
  };

  for (const item of items) {
    // Neither joins a run nor breaks one: it is not on the screen.
    if (silent(item)) continue;

    if (foldable(item)) {
      run.push(item);
      continue;
    }
    flush();
    rows.push({ type: "item", item });
  }
  flush();

  return rows;
}

/** What a closed group says about itself. */
export type Summary = {
  /** The eyebrow, matching the verbs a single row uses. */
  verb: string;
  /** "5 commands", or "12 steps" when the run is not all one thing. */
  text: string;
  /** How many of them failed. */
  failed: number;
};

/** The same verbs `Tool` puts in front of a single row. */
const VERB: Partial<Record<ItemKind, string>> = {
  CommandExecution: "ran",
  FileChange: "changed",
  FileRead: "read",
  McpToolCall: "called",
  WebSearch: "searched",
};

/** What to call several of them. */
const PLURAL: Partial<Record<ItemKind, [string, string]>> = {
  CommandExecution: ["command", "commands"],
  FileChange: ["file", "files"],
  FileRead: ["file", "files"],
  McpToolCall: ["tool call", "tool calls"],
  WebSearch: ["search", "searches"],
};

/**
 * What a group says when it is closed.
 *
 * A run that is all one thing says what the thing was — "ran 5 commands" is
 * worth more than "5 steps" and costs nothing. A mixed run cannot, so it says
 * how much happened and leaves the what to opening it.
 */
export function summarise(items: Item[]): Summary {
  const failed = items.filter((i) => i.status === "Failed").length;
  const kinds = new Set(items.map((i) => i.kind));

  if (kinds.size === 1) {
    const kind = items[0].kind;
    const names = PLURAL[kind];
    if (names) {
      return {
        verb: VERB[kind] ?? "did",
        text: `${items.length} ${items.length === 1 ? names[0] : names[1]}`,
        failed,
      };
    }
  }

  return { verb: "did", text: `${items.length} steps`, failed };
}

/** Where every artifact's card goes, against one list of rows. */
export type Placed<A> = {
  /** Cards that land after a row, by that row's index. */
  at: Map<number, A[]>;
  /** Published before every line on screen, so drawn above the first row. */
  before: A[];
  /** Nowhere to anchor to: drawn at the end of the transcript. */
  loose: A[];
};

/**
 * What the placement reads off an artifact, which is one field.
 *
 * Structural rather than `Artifact`, so the rule stays a transform over
 * numbers — and so a test can say `{ firstSeenLine: 5311 }` instead of
 * building a row of twenty generated fields to prove a boundary.
 */
type Published = { firstSeenLine?: number | null };

/**
 * Where each artifact's card goes.
 *
 * By **log line**, not by searching the transcript for the artifact's folder.
 * That search could not work and three attempts at it on the desk did not: an
 * agent names a file however it likes, and one real session ran
 *
 *     cd …/.firetower/artifacts && cp firetower-architecture/index.html \
 *          firetower-architecture-copy/index.html
 *
 * after which the full path appears nowhere in the log, nothing matched, and
 * the card fell to the end of the conversation and stayed there.
 *
 * `firstSeenLine` is stamped by the server when the artifact is first
 * published, from the agent's own log. It is a position rather than a guess,
 * it is unaffected by how the file was referred to, and because it is written
 * once the card stops where it started instead of following later edits down
 * the page.
 *
 * Three places a card can go, and getting this wrong is what kept every one
 * of them at the bottom of this screen. The transcript is a *window* — a
 * phone opens on the last few exchanges and pages backwards from there — so
 * "no row matches" has two very different meanings:
 *
 *   - **inside the window**: after the row the conversation had reached;
 *   - **before the window**: above the transcript, because it happened before
 *     everything on screen. Sending that case to the end put the oldest
 *     artifact under the newest message, which is the bug as it was reported;
 *   - **no line at all** (published before the column existed, or a
 *     transcript that is still only what somebody optimistically typed): the
 *     end, which is the only honest answer when the position is unknown.
 *
 * Ported from the desktop's `placed` in `desktop/src/ui/Chat.tsx` rather than
 * re-derived, so that an artifact published at line 5311 lands in the same
 * place on both clients.
 */
export function place<A extends Published>(rows: Row[], artifacts: A[]): Placed<A> {
  const at = new Map<number, A[]>();
  const before: A[] = [];
  const loose: A[] = [];

  /* The highest log line each row covers, so a card lands after the row the
     conversation had reached — not inside the middle of a folded group. A row
     of optimistic items reaches 0, which is "says nothing about where it is"
     rather than "line zero". */
  const reach = rows.map((row) => {
    const inRow = row.type === "item" ? [row.item] : row.items;
    return inRow.reduce((high, item) => Math.max(high, item.lineNo ?? 0), 0);
  });

  /* The oldest line on screen: what a card has to be older than to belong
     above the transcript. Reduced rather than spread into `Math.min`, which
     is what the desk does — pulling down on a transcript here re-reads the
     whole conversation, and one argument per row of a long one is an argument
     list long enough to throw. */
  const earliest = reach.reduce((low, r) => (r > 0 && (low === 0 || r < low) ? r : low), 0);

  for (const artifact of artifacts) {
    const line = artifact.firstSeenLine ?? 0;
    if (line <= 0) {
      loose.push(artifact);
      continue;
    }
    if (earliest > 0 && line < earliest) {
      before.push(artifact);
      continue;
    }
    /* The last row at or below the line, which is what refuses to split a
       folded group: a run whose reach is past the artifact's line is not
       opened to put the card inside it, so the card stops at the row before
       it. Within one row, and the alternative is a card that disappears when
       somebody shuts the fold. */
    let found = -1;
    for (let i = 0; i < reach.length; i++) {
      if (reach[i] > 0 && reach[i] <= line) found = i;
    }
    if (found >= 0) at.set(found, [...(at.get(found) ?? []), artifact]);
    else loose.push(artifact);
  }

  return { at, before, loose };
}
