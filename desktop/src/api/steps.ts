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
 * Deliberately not a component. The rules below are a list transform with
 * edges — a run broken by prose, a step still running, a failure inside a
 * group — and each of those is worth a test that does not need React to run.
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
  return FOLDS.includes(item.kind);
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
