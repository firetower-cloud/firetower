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
