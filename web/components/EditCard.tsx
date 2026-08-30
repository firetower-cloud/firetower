"use client";

import { useState } from "react";

/**
 * What an edit actually did, in the transcript.
 *
 * The conversation used to say a file changed and leave it at that — you took
 * the agent's word for it, or you opened the Changes panel and lost your place.
 * The edit is the most interesting thing in a turn, and it was the one thing
 * not on screen.
 *
 * **Nothing new is fetched to draw this.** A tool call already carries its own
 * arguments, and for an edit those arguments *are* the diff: `old_string` and
 * `new_string` for a replacement, `content` for a write. So this is a renderer
 * for something the transcript already had and was throwing away.
 *
 * It is not a real diff — there is no line-level alignment and no line numbers,
 * because neither is in the arguments and reading the file to get them would
 * turn every edit in a long turn into a request. Removed block, then added
 * block, which is what the agent asked for and is honest about being that.
 */
export function EditCard({
  path,
  removed,
  added,
  onOpen,
}: {
  path: string;
  /** What was there. Absent for a file being created. */
  removed?: string;
  /** What replaced it. Absent for a deletion. */
  added?: string;
  /** Open the full diff, where there is one to open. */
  onOpen?: () => void;
}) {
  const [whole, setWhole] = useState(false);

  const out = lines(removed);
  const inn = lines(added);
  const total = out.length + inn.length;
  // Long enough to see what happened, short enough that three edits in a turn
  // do not become the whole screen.
  const cut = !whole && total > MOST;

  const shownOut = cut ? out.slice(0, Math.min(out.length, MOST / 2)) : out;
  const shownIn = cut ? inn.slice(0, MOST - shownOut.length) : inn;

  return (
    <div className="my-2 overflow-hidden rounded-md border border-line">
      <div className="flex items-center gap-2 border-b border-line bg-panel px-2.5 py-1.5">
        <span className="shrink-0 text-meta text-mute">✎</span>
        <span className="min-w-0 flex-1 truncate font-mono text-meta text-slate" title={path}>
          {path}
        </span>
        {inn.length > 0 && (
          <span className="shrink-0 font-mono text-micro text-sage">+{inn.length}</span>
        )}
        {out.length > 0 && (
          <span className="shrink-0 font-mono text-micro text-brick">−{out.length}</span>
        )}
        {onOpen && (
          <button
            onClick={onOpen}
            title="Open the full diff"
            className="shrink-0 text-meta text-mute transition-colors hover:text-bone"
          >
            ↗
          </button>
        )}
      </div>

      <div className="overflow-x-auto bg-ground">
        <pre className="min-w-full px-2.5 py-1.5 font-mono text-meta leading-[1.6]">
          {shownOut.map((line, i) => (
            <div key={`-${i}`} className="bg-brick/[0.07] text-brick">
              <span className="mr-2 select-none opacity-60">−</span>
              {line || " "}
            </div>
          ))}
          {shownIn.map((line, i) => (
            <div key={`+${i}`} className="bg-sage/[0.07] text-sage">
              <span className="mr-2 select-none opacity-60">+</span>
              {line || " "}
            </div>
          ))}
        </pre>
      </div>

      {total > MOST && (
        <button
          onClick={() => setWhole(!whole)}
          className="w-full border-t border-line bg-panel py-1 text-meta text-mute transition-colors hover:text-bone"
        >
          {whole ? "Show less" : `Show all ${total} lines`}
        </button>
      )}
    </div>
  );
}

/** Lines shown before it folds. */
const MOST = 14;

function lines(text?: string): string[] {
  if (!text) return [];
  // A trailing newline is a property of the file, not a line somebody wrote.
  return text.replace(/\n$/, "").split("\n");
}

/**
 * Whether a tool call's arguments describe an edit we can draw, and what of.
 *
 * Reads the shapes the agents actually send rather than a shape we defined:
 * `Edit` gives `old_string`/`new_string`, `Write` gives `content`, and Codex
 * sends the same ideas under its own names. Anything unrecognised returns
 * nothing and the caller draws what it drew before — being unable to read one
 * tool's arguments must never cost the item.
 */
export function editFrom(input: unknown): { path: string; removed?: string; added?: string } | null {
  if (typeof input !== "object" || input === null) return null;
  const args = input as Record<string, unknown>;

  const str = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = args[name];
      if (typeof value === "string") return value;
    }
    return undefined;
  };

  const path = str("file_path", "filePath", "path", "file");
  if (!path) return null;

  const removed = str("old_string", "oldString", "old_text", "oldText");
  const added = str("new_string", "newString", "new_text", "newText", "content", "contents");

  // A path with neither half is a delete, or a tool we have misread. Either
  // way there is no diff to draw.
  if (removed === undefined && added === undefined) return null;

  return { path, removed, added };
}
