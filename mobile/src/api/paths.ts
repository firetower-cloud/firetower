/**
 * Splitting a repository path into the two things a row shows.
 *
 * A file row prints its name loudly and its directory quietly underneath, and
 * the whole job is one `lastIndexOf` — which is exactly why it was written
 * inline and got it wrong. There is no slash in `AGENTS.md`, `lastIndexOf`
 * answers -1, and `slice(0, -1)` reads that as *all but the last character*:
 * the directory line came out as the file's own name with its final letter
 * bitten off. It sat in the diff for as long as it did because 10px of dim
 * grey is not a size anybody proofreads.
 *
 * Here rather than in the component so it can be checked without a renderer.
 */
import { findFiles } from "./generated/sessions/sessions";

export type Split = {
  /** What the row says loudly. */
  name: string;
  /** What it says underneath, and "" when there is nothing to say. */
  dir: string;
};

export function split(path: string): Split {
  const cut = path.lastIndexOf("/");
  if (cut === -1) return { name: path, dir: "" };
  return { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}

/* ── What a written path points at ──────────────────────────────────────── */

/**
 * The same resolution the desk does, for the same reason.
 *
 * An agent writes the path it was working with — `docs/shot.png`, or an
 * absolute one it captured — not a path relative to wherever the markdown
 * ended up. So a written path is matched against the workspace by its last
 * segment, and only a single unambiguous hit counts.
 */
const known = new Map<string, Promise<string | null>>();

/**
 * The answers again, readable without awaiting.
 *
 * Awaiting a promise that settled long ago still costs a turn of the microtask
 * queue, and that turn is a painted frame. A picture whose component remounts
 * — which is every delta of a streaming turn, because the markdown around it
 * is reparsed each time — would draw a placeholder and then the image, over
 * and over, while the agent is still talking. The desk had exactly that bug.
 */
const settled = new Map<string, string | null>();

/** What a written path already resolved to, or `undefined` if not yet. */
export function resolvedPath(sessionId: string, written: string): string | null | undefined {
  return settled.get(`${sessionId}\n${written}`);
}

/** The workspace path a written one means, or nothing if it is not there. */
export function resolvePath(sessionId: string, written: string): Promise<string | null> {
  const key = `${sessionId}\n${written}`;
  let hit = known.get(key);
  if (!hit) {
    const name = written.split("/").pop() ?? written;
    hit = findFiles(sessionId, { q: name, limit: 100 })
      .then((paths) => {
        const clean = written.replace(/^(\.\.\/)+/, "");
        const exact = paths.find((p) => p === clean || p.endsWith(`/${clean}`));
        if (exact) return exact;
        const same = paths.filter((p) => p.split("/").pop() === name);
        return same.length === 1 ? same[0] : null;
      })
      .catch(() => null)
      .then((found) => {
        settled.set(key, found);
        return found;
      });
    known.set(key, hit);
  }
  return hit;
}
