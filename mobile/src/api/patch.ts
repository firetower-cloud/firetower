/**
 * Reading a unified patch, as git printed it.
 *
 * Ported verbatim from `desktop/src/patch.ts` — it is regexes over a string
 * and there is nothing platform-specific in it.
 *
 * `session_diff` hands back the hunks verbatim. Two things are wanted from
 * them: the lines to draw in the inspector, and the line numbers in the file
 * as it now stands that were added — so an open file can show its own edits.
 */

/** The patch as lines with a kind. Headers become context so they still read. */
export function fromPatch(patch: string): [string, string][] {
  return patch
    .replace(/\n$/, "")
    .split("\n")
    .filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to)/.test(l))
    .map((l): [string, string] => {
      if (l.startsWith("@@")) return ["hunk", l];
      if (l.startsWith("+")) return ["add", l.slice(1)];
      if (l.startsWith("-")) return ["del", l.slice(1)];
      return ["ctx", l.replace(/^ /, "")];
    });
}

/** Line numbers, in the new file, of every line the patch added. */
export function addedLines(patch: string): Set<number> {
  const out = new Set<number>();
  let at = 0;
  for (const l of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) {
      at = Number(hunk[1]);
      continue;
    }
    if (at === 0) continue;
    if (l.startsWith("+")) {
      out.add(at);
      at++;
    } else if (l.startsWith("-") || l.startsWith("\\")) {
      // A removed line takes no room in the new file; "\ No newline" is not a line.
    } else {
      at++;
    }
  }
  return out;
}

/** Whether the patch creates the file rather than changing one that was there. */
export const isNew = (patch: string) => /^new file mode/m.test(patch);

/**
 * The lines the patch removed, keyed by the line in the new file they sat
 * before — so a file can show what was there, in place, the way the diff
 * does. Lines removed at the very end key to one past the last line.
 */
export function removedLines(patch: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  let at = 0;
  let pending: string[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    out.set(at, [...(out.get(at) ?? []), ...pending]);
    pending = [];
  };
  for (const l of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) {
      flush();
      at = Number(hunk[1]);
      continue;
    }
    if (at === 0) continue;
    if (l.startsWith("-")) pending.push(l.slice(1));
    else if (l.startsWith("\\")) continue;
    else {
      flush();
      at++;
    }
  }
  flush();
  return out;
}
