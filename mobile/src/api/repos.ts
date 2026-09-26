/**
 * Which repositories are still worth offering.
 *
 * The phone connects a repository the only way it can: the control plane
 * already holds this person's git token, so `/providers/github/repos` is a
 * list of what they could clone, and connecting one is a `POST /repos` with
 * the slug and the remote off that list. No authorization happens here — a
 * device flow is a desk job and the desktop owns it.
 *
 * What is left is a fold, and it is here rather than in the screen because it
 * is the part that can be wrong quietly: a picker that offers a repository
 * Firetower already has produces a second row for the same thing, and the
 * person who tapped it has no way to tell which of the two their workspaces
 * will be cut from.
 *
 * **Matched on the slug, not the remote.** `acme/backend` reached over ssh and
 * the same repository reached over https are two strings and one repository,
 * and a repository connected by pasting a remote on the desktop has whichever
 * of them somebody pasted. The slug is what both agree on.
 */
import type { RemoteRepo, Repo } from "~/api/generated/model";

/** `Acme/Backend` and `acme/backend` are the same repository. */
const key = (slug: string) => slug.trim().toLowerCase();

/**
 * What this account can see and Firetower does not have yet, newest first.
 *
 * Narrowing is [`matching`], separately, because the two are asked different
 * questions: this one answers *is there anything to add at all*, which is what
 * decides whether the screen offers a filter box, and a count that shrank as
 * somebody typed would take the box away mid-word.
 */
export function importable(seen: RemoteRepo[], connected: Repo[]): RemoteRepo[] {
  const have = new Set(connected.map((r) => key(r.slug)));
  return seen.filter((r) => !have.has(key(r.slug))).sort(newestFirst);
}

/**
 * Narrowed by what somebody typed.
 *
 * Matched against the slug alone. It is the only part anybody types from
 * memory, and matching the remote too would have `github` find every row on
 * the screen.
 */
export function matching(repos: RemoteRepo[], query: string): RemoteRepo[] {
  const want = key(query);
  return want ? repos.filter((r) => key(r.slug).includes(want)) : repos;
}

/**
 * Most recently pushed first, which is the order people actually want — and
 * the one the host already sends, so this only has to survive three pages
 * being concatenated.
 *
 * A repository that has never been pushed to sorts last rather than first,
 * which is what an absent date would do on its own.
 */
function newestFirst(a: RemoteRepo, b: RemoteRepo): number {
  const at = when(a.pushedAt);
  const bt = when(b.pushedAt);
  if (at !== bt) return bt - at;
  return key(a.slug).localeCompare(key(b.slug));
}

function when(iso: string | null | undefined): number {
  if (!iso) return 0;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
}

/**
 * Whether a filter box is worth the row it costs.
 *
 * On a desk the picker always has one. A phone pays for it in the place it can
 * least afford to — the top of the list — so a handful of repositories get the
 * screen to themselves and a hundred get a box.
 */
export const worthFiltering = (count: number) => count > 8;

/** `acme/backend` → `backend`, the half that is not the same on every row. */
export function repoName(slug: string): string {
  const cut = slug.lastIndexOf("/");
  return cut === -1 ? slug : slug.slice(cut + 1);
}

/** `acme/backend` → `acme`, or nothing for a slug with no owner in it. */
export function repoOwner(slug: string): string | null {
  const cut = slug.lastIndexOf("/");
  return cut === -1 ? null : slug.slice(0, cut);
}
