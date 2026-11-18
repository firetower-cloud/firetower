/**
 * What changed across every version being jumped — the changelog *span*.
 *
 * General access is a pin, not a filter: a maintainer moves it forward
 * deliberately, so it skips versions as a matter of course and an upgrade is
 * routinely a jump of six or sixteen. Showing the newest release's notes and
 * calling that "what changed" would be wrong on most upgrades, so the screen
 * assembles every version in the jump, per package.
 *
 * **Read here rather than from the control plane.** The API returns the notes
 * for one release — the one being offered — and there is no span on the
 * contract. The feed is public and anonymous, the budget is sixty requests an
 * hour against a button somebody presses, and `connect-src` already allows it.
 *
 * **Capped at three pages, and the shortfall is named.** An installation that
 * has not upgraded in a year would otherwise issue dozens of requests and hit
 * a rate limit *during an upgrade*, which is when it is least wanted. Silently
 * truncating is not an option in any case: a list that looks complete and is
 * not is worse than showing one version.
 */

/** The two packages that release separately, and so are jumped separately. */
export type Pkg = "controlPlane" | "desktop";

/** How each package's releases are tagged. */
const PREFIX: Record<Pkg, string> = {
  controlPlane: "firetower-v",
  desktop: "desktop-v",
};

export const PACKAGE_NAME: Record<Pkg, string> = {
  controlPlane: "The control plane",
  desktop: "The app",
};

const FEED = "https://api.github.com/repos/firetower-cloud/firetower/releases";
const COMPARE = "https://github.com/firetower-cloud/firetower/compare";

/**
 * How deep the feed is read. Three pages of thirty is about thirty releases of
 * any one package, the other two packages' tags being interleaved with it.
 */
export const PAGES = 3;
const PER_PAGE = 30;

/** One version in the jump. */
export type Note = {
  version: string;
  /** When it was published, as the feed gives it. */
  publishedAt: string | null;
  /** The changelog section, as markdown. */
  notes: string | null;
  /** Where it is on the host. */
  url: string | null;
};

/** The whole jump, and what could not be shown of it. */
export type Span = {
  package: Pkg;
  from: string;
  to: string;
  /** Newest first, as the feed returns them. */
  versions: Note[];
  /**
   * The oldest version a section was found for, when the read stopped before
   * reaching `from`. `null` when the span is whole.
   *
   * **A boundary rather than a count, deliberately.** A client that stopped at
   * the cap cannot know how many versions it did not fetch — the drawing could
   * only put a number there because its releases were a fixed array. Naming
   * the boundary and linking the comparison says the same true thing without
   * inventing a figure.
   */
  shortfallBelow: string | null;
  /** The full comparison, for whatever the span could not carry. */
  compareHref: string;
  /** Why the span is short or empty, when the feed would not answer. */
  trouble: string | null;
};

/** `0.9.2` → a number that sorts. Three parts, each under a thousand. */
export function order(version: string): number {
  const parts = version.split("-")[0].split(".").map((p) => Number(p) || 0);
  return (parts[0] ?? 0) * 1_000_000 + (parts[1] ?? 0) * 1_000 + (parts[2] ?? 0);
}

export function isNewer(a: string, b: string): boolean {
  return order(a) > order(b);
}

/**
 * Every version in `(from, to]` for one package, newest first.
 *
 * `from` is what is running and is **not** included; `to` is what is being
 * moved to and is. A span of one is still a span — it is the ordinary case and
 * reads the same way.
 */
export async function span(pkg: Pkg, from: string, to: string, fetcher = fetch): Promise<Span> {
  const compareHref = `${COMPARE}/${PREFIX[pkg]}${from}...${PREFIX[pkg]}${to}`;
  const found: Note[] = [];
  let reached = false;
  let trouble: string | null = null;

  for (let page = 1; page <= PAGES && !reached; page++) {
    let body: unknown;
    try {
      const answer = await fetcher(`${FEED}?per_page=${PER_PAGE}&page=${page}`, {
        headers: { accept: "application/vnd.github+json" },
      });
      if (!answer.ok) {
        /* A rate limit, an outage, a repository that moved. Said, with
           whatever was already read kept: half a span and a sentence is more
           use than an empty panel. */
        trouble = `The releases feed answered ${answer.status}, so ${found.length === 0 ? "the changelog could not be read" : "the rest of the changelog could not be read"}.`;
        break;
      }
      body = await answer.json();
    } catch (e) {
      trouble = `The releases feed could not be reached${(e as Error)?.message ? ` — ${(e as Error).message}` : ""}.`;
      break;
    }

    const releases = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
    if (releases.length === 0) {
      // The feed ran out before the cap did, so the span is whole.
      reached = true;
      break;
    }
    for (const release of releases) {
      const note = read(release, PREFIX[pkg]);
      if (!note) continue;
      /* The feed is newest first, so the first release at or below `from` is
         the end of the span — and proof that nothing is missing. */
      if (!isNewer(note.version, from)) {
        reached = true;
        break;
      }
      if (isNewer(note.version, to)) continue;
      found.push(note);
    }
    if (releases.length < PER_PAGE) reached = true;
  }

  return {
    package: pkg,
    from,
    to,
    versions: found,
    shortfallBelow: reached || found.length === 0 ? null : found[found.length - 1].version,
    compareHref,
    trouble,
  };
}

/** One release document, if it is this package's and not a draft. */
function read(release: Record<string, unknown>, prefix: string): Note | null {
  if (release.draft === true) return null;
  const tag = typeof release.tag_name === "string" ? release.tag_name : null;
  if (!tag || !tag.startsWith(prefix)) return null;
  const version = tag.slice(prefix.length);
  if (!/^\d+\.\d+\.\d+/.test(version)) return null;
  return {
    version,
    publishedAt: typeof release.published_at === "string" ? release.published_at : null,
    notes: typeof release.body === "string" ? release.body.trim() || null : null,
    url: typeof release.html_url === "string" ? release.html_url : null,
  };
}

/** The first bullet of a release, for a row that is closed. */
export function firstSubject(notes: string | null): string | null {
  return bullets(notes)[0] ?? null;
}

/**
 * How many features and fixes a release carries, counted off its own sections.
 *
 * The headings release-please writes are the authority — "Features",
 * "Bug Fixes" — and a release with neither is reported by its bullet count
 * rather than by a wrong pair of zeroes.
 */
export function counts(notes: string | null): string | null {
  if (!notes) return null;
  let features = 0;
  let fixes = 0;
  let other = 0;
  let kind: "features" | "fixes" | null = null;
  for (const line of notes.split("\n")) {
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      const said = heading[1].toLowerCase();
      kind = said.includes("feature") ? "features" : said.includes("fix") ? "fixes" : null;
      continue;
    }
    if (!/^\s*[*-]\s+\S/.test(line)) continue;
    if (kind === "features") features += 1;
    else if (kind === "fixes") fixes += 1;
    else other += 1;
  }
  const bits: string[] = [];
  if (features) bits.push(`${features} ${features === 1 ? "feature" : "features"}`);
  if (fixes) bits.push(`${fixes} ${fixes === 1 ? "fix" : "fixes"}`);
  if (bits.length === 0 && other) bits.push(`${other} ${other === 1 ? "change" : "changes"}`);
  return bits.length > 0 ? bits.join(", ") : null;
}

/**
 * A release's bullets, as plain sentences.
 *
 * release-please writes markdown with a heading per kind, a link on every
 * subject and a commit hash in brackets at the end of each line. A panel
 * somebody reads before agreeing to an upgrade wants the sentences, so the
 * decoration comes off and the scope stays — `**server:** …` becomes
 * `server: …`, which is the half that says where a change landed.
 */
export function bullets(notes: string | null): string[] {
  if (!notes) return [];
  const out: string[] = [];
  for (const line of notes.split("\n")) {
    const bullet = line.match(/^\s*[*-]\s+(.*)$/);
    if (!bullet) continue;
    const said = bullet[1]
      .replace(/\(\[[0-9a-f]{6,}\]\([^)]*\)\)\s*$/i, "")
      .replace(/\(#\d+\)\s*$/, "")
      .replace(/\*\*(.+?):\*\*\s*/, "$1: ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .trim();
    if (said) out.push(said);
  }
  return out;
}

/** "15 Nov", from an ISO timestamp. Empty when the feed gave none. */
export function on(at: string | null): string {
  if (!at) return "";
  const when = new Date(at);
  return Number.isNaN(when.getTime())
    ? ""
    : when.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
