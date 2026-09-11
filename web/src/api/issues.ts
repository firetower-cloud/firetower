/**
 * Linking a pull request to the issues it answers.
 *
 * ## Why the trailer is composed here and not by the model
 *
 * The description is written by an agent reading a diff. Asking it to write
 * `Closes #32` as well means occasionally getting `Closes #23` — and a wrong
 * number does not fail, it silently closes somebody else's issue when the
 * branch merges. Review does not catch it, because the sentence reads fine.
 *
 * So the prose is the model's and the reference is ours: composed from the key
 * a workspace was cut with, or from something a person clicked. Everything the
 * model *noticed* being mentioned arrives as a suggestion and becomes a
 * reference only when somebody accepts it.
 *
 * ## Why the trailer is shown before it is sent
 *
 * It is appended at the moment the request is opened, so the body in the box
 * is the prose and nothing else. That is only honest if the lines that will be
 * added are on screen — [`trailerFor`] is what the sheet renders, and what it
 * sends.
 *
 * ## Two trackers, one trailer
 *
 * A GitHub reference is a number and a Linear one is an identifier, and each
 * host ignores the other's: `Closes #32` means nothing to Linear, `Fixes
 * ENG-123` means nothing to GitHub. So both can be written into one body
 * without either acting on the other's line.
 */

/** Which tracker a reference belongs to. */
export type Tracker = "github" | "linear";

/** What a keyword does when the request merges. */
export type Keyword = "Closes" | "Fixes" | "Resolves" | "Refs";

/** The ones that close an issue, in the order they are offered. */
export const KEYWORDS: Keyword[] = ["Closes", "Fixes", "Resolves", "Refs"];

/** Whether this keyword ends with the issue closed. */
export function shuts(keyword: Keyword): boolean {
  return keyword !== "Refs";
}

/**
 * One issue, as it will be written down.
 *
 * `key` is `32` for GitHub and `ENG-123` for Linear. `repo` is the slug when a
 * GitHub issue lives somewhere other than where it is being referenced from,
 * and undefined when it is a bare `#32`. Which of those a given pull request
 * needs is decided per checkout, in [`trailerFor`] — the same issue is `#32` in
 * its own repository and `acme/web#32` everywhere else, and only the pull
 * request knows which it is. A Linear identifier is the same everywhere.
 */
export type Reference = {
  source: Tracker;
  /** `32`, or `ENG-123`. */
  key: string;
  /** `acme/web`, when it is known. GitHub only. */
  repo?: string;
  keyword: Keyword;
  /** What it is called, when anybody could read it. */
  title?: string;
  /** Somewhere to go and read it. */
  url?: string;
};

/** How a reference is identified, so the same issue cannot be added twice. */
export function idOf(ref: Pick<Reference, "source" | "key" | "repo">): string {
  return ref.source === "linear" ? `linear:${ref.key}` : `${ref.repo ?? ""}#${ref.key}`;
}

/**
 * Read what somebody typed or pasted.
 *
 * Five shapes, because all five are things people actually have in the
 * clipboard: a bare `#32`, a qualified `acme/web#32`, a GitHub URL, a Linear
 * URL, and a bare `ENG-123`. Anything else is not a reference — a bare `32`
 * most of all, which is far more often a version or a count.
 *
 * `within` is the repository the sheet is shipping to. A reference typed as
 * `#32` means "in this one", and saying so here is what lets the trailer
 * qualify it when a second repository needs it written the long way.
 */
export function parseReference(text: string, within?: string): Reference | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // A Linear link. The workspace name sits between the host and `issue`, and
  // is not worth reading — the identifier is unique on its own.
  const ticket = trimmed.match(/^(?:https?:\/\/)?linear\.app\/[^/\s]+\/issue\/([A-Za-z][\w]*-\d+)/);
  if (ticket) {
    return {
      source: "linear",
      key: ticket[1].toUpperCase(),
      keyword: "Refs",
      url: trimmed.startsWith("http") ? trimmed.split(/[?#]/)[0] : undefined,
    };
  }

  // A GitHub URL, from the browser. The host is skipped rather than matched,
  // so a self-hosted git server works without being named.
  const link = trimmed.match(
    /^(?:https?:\/\/)?[^/\s]+\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull|pulls)\/(\d+)/,
  );
  if (link) {
    return {
      source: "github",
      key: link[3],
      repo: `${link[1]}/${link[2]}`,
      keyword: "Refs",
      url: trimmed.startsWith("http") ? trimmed.split(/[?#]/)[0] : undefined,
    };
  }

  // `acme/web#32`, or `#32`.
  const hash = trimmed.match(/^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/);
  if (hash) {
    return {
      source: "github",
      key: hash[2],
      repo: hash[1] ?? within,
      keyword: "Refs",
    };
  }

  // `ENG-123`. Looser than the shapes above, and deliberately still narrow:
  // a team prefix of letters and digits, then a number, and nothing else.
  // Something like `UTF-8` gets through, which is survivable — a reference
  // read this way arrives as `Refs` and has to be clicked before it is
  // written, and nothing here closes an issue on its own.
  const identifier = trimmed.match(/^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/);
  if (identifier) {
    return {
      source: "linear",
      key: `${identifier[1].toUpperCase()}-${identifier[2]}`,
      keyword: "Refs",
    };
  }

  return null;
}

/** `#32`, or `acme/web#32` when it is somewhere else. `ENG-123` as it is. */
export function label(ref: Reference, within?: string): string {
  if (ref.source === "linear") return ref.key;
  return !ref.repo || ref.repo === within ? `#${ref.key}` : `${ref.repo}#${ref.key}`;
}

/**
 * The lines appended to one pull request's body.
 *
 * `within` is the repository *this* request is opening in, and it is the whole
 * reason this takes an argument rather than being a property of the list: a
 * closing keyword only closes an issue in its own repository. A session that
 * changed two repositories opens two requests, and the issue it was cut for
 * can only be closed by one of them — the other references it, which is the
 * honest thing to write and the thing GitHub will actually do.
 *
 * Linear is not qualified by repository at all. It reads the identifier out of
 * the body wherever the request is opened, so the only translation it needs is
 * `Refs`, which it does not know, into `Part of`, which it does.
 */
export function trailerFor(refs: Reference[], within?: string): string {
  return refs
    .map((ref) => {
      if (ref.source === "linear") {
        return `${ref.keyword === "Refs" ? "Part of" : ref.keyword} ${ref.key}`;
      }
      const here = !ref.repo || ref.repo === within;
      // Downgraded rather than dropped. A reference that cannot close is still
      // worth having in the body — it is the link a reviewer follows.
      const keyword = here ? ref.keyword : "Refs";
      return `${keyword} ${label(ref, within)}`;
    })
    .join("\n");
}

/** The body as it will be sent: the prose, then the references. */
export function withTrailer(body: string, refs: Reference[], within?: string): string {
  const trailer = trailerFor(refs, within);
  const prose = body.trim();
  if (!trailer) return prose;
  return prose ? `${prose}\n\n${trailer}` : trailer;
}

/**
 * Whether any of these only work if a tracker's own git integration is on.
 *
 * A `Fixes ENG-123` in a pull request body does nothing at all unless Linear
 * is connected to the repository at Linear's end. That is not something this
 * can check or fix, so the sheet says so rather than writing a line somebody
 * assumes is working.
 */
export function needsIntegration(refs: Reference[]): boolean {
  return refs.some((ref) => ref.source === "linear");
}

/**
 * The reference a workspace was cut for, from what the session remembers.
 *
 * `taskKey` is `#32` or `ENG-123` and `taskUrl` is where to read it. The URL is
 * the better source — it names the repository, which a GitHub key does not —
 * so the key is only a fallback for a session bound before URLs were kept.
 *
 * Defaults to closing, because that is what starting work on an issue means.
 * Everything added by hand defaults to referencing instead: adding a link to
 * an issue is not the same as promising to close it.
 */
export function fromTask(
  taskKey: string | null | undefined,
  taskUrl: string | null | undefined,
  within?: string,
): Reference | null {
  const found =
    (taskUrl ? parseReference(taskUrl, within) : null) ??
    (taskKey ? parseReference(taskKey, within) : null);
  return found && { ...found, keyword: "Closes", url: found.url ?? taskUrl ?? undefined };
}

/**
 * What the describing run said it saw, as things that could be linked.
 *
 * Already filtered on the worker, and filtered again here: this is a list a
 * model produced, and everything on it is one click away from closing an
 * issue. Anything already referenced is dropped so the suggestions are only
 * ever news.
 */
export function suggestionsFrom(
  issues: string[] | undefined,
  held: Reference[],
  within?: string,
): Reference[] {
  const have = new Set(held.map(idOf));
  const out: Reference[] = [];

  for (const raw of issues ?? []) {
    const ref = parseReference(raw, within);
    if (!ref) continue;
    const id = idOf(ref);
    if (have.has(id)) continue;
    have.add(id);
    out.push(ref);
  }

  return out;
}
