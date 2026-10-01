/**
 * Who may decide where something is filed.
 *
 * **One function, because there were four.** The machines list, the agents
 * list, the secrets list and the sharing dialog each worked this out for
 * themselves and each got a different answer — the dialog did not ask at all,
 * so somebody with a *look* at a directory was offered "move this into your own
 * space", which the server then refused. A control that is offered and refused
 * is worse than one that is absent: it reads as a broken button rather than as
 * a permission they do not have.
 *
 * Kept in step with `desktop/src/filing.ts`, which is the same file: the two
 * clients share a contract and not a package, and a rule about who may do what
 * is the last thing that should be allowed to drift between them.
 *
 * This is the same question `may_share` asks on the server
 * (`crates/ft-server/src/api/access.rs`). It is asked here as well, before the
 * control is drawn, and the two have to agree. The server is what enforces it;
 * this only decides what to show.
 */

/** Just enough of the signed-in person. */
export type Whoever = { slug: string; role: string } | null | undefined;

/** Just enough of a directory: what appears in a path, and what they may do. */
export type Reachable = { slug: string; level?: string | null };

/**
 * Whether this person may move this thing.
 *
 * Three ways to yes, and they are the three the server allows:
 *
 * * it is in **their own space** — `u/<their slug>/…`, which needs no grant;
 * * they **administer the directory** it is filed in. Not writer: a writer may
 *   put their own things in and may not take somebody else's out, which is what
 *   stops a member pulling the fleet's shared machine out from under everybody;
 * * they **administer the organisation**, which exists so that a directory
 *   whose last administrator has left is fixable by somebody.
 *
 * `false` for anything *attached* — an agent account's credential, a
 * repository's variables, the installation's own secrets. Those have no path,
 * they move when the thing they belong to moves, and there is nothing to offer.
 */
export function mayMove(
  path: string | null | undefined,
  me: Whoever,
  directories: Reachable[],
): boolean {
  if (!path || !me) return false;

  const [root, label] = path.split("/");

  // Somebody's own root is theirs, and an administrator is not an exception.
  // Everywhere else being an administrator is the way back in when a
  // directory's last one has left; here it would be the way into somebody's
  // private work, and handing that to a third party is the one outcome its
  // owner never agreed to. The only way out of a personal root is its owner.
  if (root === "u") return label === me.slug;
  if (me.role === "admin") return true;
  if (root === "d") return directories.some((d) => d.slug === label && d.level === "admin");
  return false;
}

/**
 * Where something may be moved *to*.
 *
 * Writer, not admin, and deliberately a different question from `mayMove`:
 * putting your own work into a directory you can work in is ordinary, and it is
 * taking something out that needs administering. The server checks both ends —
 * `may_share` for the thing, and at least writer on the directory it is going
 * to.
 */
export function destinations<T extends Reachable>(directories: T[]): T[] {
  return directories.filter((d) => d.level === "writer" || d.level === "admin");
}

/** `u/kevin/thing` → `["u", "kevin"]`. The first two labels are the whole of
 *  what decides access; everything after them is a name with slashes in it. */
export function rootOf(path: string): [string, string] {
  const parts = path.split("/");
  return [parts[0] ?? "", parts[1] ?? ""];
}

/** What a chip says: `yours`, or the directory root as it appears in the path. */
export function where(path: string | null | undefined, me: Whoever): string {
  if (!path) return "";
  const [root, label] = rootOf(path);
  if (root === "u") return label === me?.slug ? "yours" : `u/${label}`;
  return `d/${label}`;
}

/**
 * A name, as an `ltree` label — what `d/<this>` will be.
 *
 * **Must agree with `ft_core::slug`.** The server derives it from the same name
 * a moment later, and a field previewing a different answer is worse than one
 * previewing nothing: somebody reads `d/ledger-work`, gets `d/ledger_work`, and
 * has no reason to trust the next thing the screen tells them.
 *
 * Labels are `[A-Za-z0-9_-]`, so every run of anything else becomes one `_`.
 * `Ledger  Work!` and `ledger work` are the same label, which is exactly why
 * two directories can collide on names that look different.
 */
export function pathSlug(text: string): string {
  let out = "";
  let gap = false;
  for (const ch of text) {
    if (/[a-zA-Z0-9]/.test(ch)) {
      if (gap && out) out += "_";
      gap = false;
      out += ch.toLowerCase();
    } else {
      gap = true;
    }
  }
  return out || "untitled";
}
