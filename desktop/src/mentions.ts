/**
 * Mentioning an artifact in a turn.
 *
 * Two halves of one text format, kept in one file so they cannot drift: what
 * the composer writes under a message, and what the transcript reads back out
 * of it to draw a chip. The agent sees only the text — the same channel an
 * attached file is named on — so everything a chip knows is in it:
 *
 *     Make it match @pricing — same type scale and the same button weight.
 *
 *     Mentioned artifacts:
 *     - @pricing is "Pricing, three tiers" (v3), published 2h ago from the
 *       workspace "pricing rework". Page: .firetower/attachments/pricing-v3.html
 *
 * The handle stays in the sentence where it was typed, and the line under it
 * is what resolves it. A mention is an attachment — the page is a file the
 * control plane placed in the workspace (`mention_artifact`) — and the block
 * is to the agent what the bare paths appended for a dropped file are.
 */
import type { Artifact } from "~/api/generated/model";
import { elapsed, minutesSince } from "~/api/view";

/** What a chip holds once the page has landed in the workspace. */
export type Mention = { handle: string; artifact: Artifact; path: string };

/** One line of the block, read back. */
export type Read = { handle: string; title: string; version: number; path: string };

export const HEADING = "Mentioned artifacts:";

/**
 * Eight rows in all — the cap the `/` list already has — of which artifacts
 * take at most five. The files fill what is left.
 */
export const MOST_ARTIFACTS = 5;
export const MOST_ROWS = 8;

/**
 * The artifacts worth offering for what has been typed after `@`.
 *
 * This workspace's first, then the rest newest first — the library's own
 * order. With a query, a title or slug that starts with it beats a word in
 * either that does, which beats a substring, which beats a match on where it
 * came from. A `/` in the query is a path and offers nothing: the files take
 * over.
 */
export function rankArtifacts(all: Artifact[], query: string, sessionId: string): Artifact[] {
  const q = query.trim().toLowerCase();
  if (q.includes("/")) return [];
  const here = (a: Artifact) => (a.fromSessionId === sessionId ? 1 : 0);
  const score = (a: Artifact) => {
    if (!q) return 1;
    const title = a.title.toLowerCase();
    const slug = a.slug.toLowerCase();
    if (title.startsWith(q) || slug.startsWith(q)) return 6;
    if (title.split(/[\s,]+/).some((w) => w.startsWith(q)) || slug.split("-").some((w) => w.startsWith(q))) return 5;
    if (title.includes(q) || slug.includes(q)) return 4;
    if (originOf(a, sessionId).label.toLowerCase().includes(q)) return 2;
    return 0;
  };
  return all
    .map((a, order) => ({ a, s: score(a), order }))
    .filter((x) => x.s > 0)
    .sort(
      (x, y) =>
        y.s - x.s ||
        here(y.a) - here(x.a) ||
        y.a.updatedAt.localeCompare(x.a.updatedAt) ||
        x.order - y.order,
    )
    .map((x) => x.a);
}

/**
 * Where an artifact came from — as a row says it, and as the agent is told.
 *
 * Three cases, the same three the library's tiles draw: made in this very
 * workspace, made in another of yours, or shared with you through a
 * directory. The sentence carries the elapsed time for your own, because a
 * version is a moment and the agent may as well know which.
 */
export function originOf(a: Artifact, sessionId: string): { label: string; sentence: string } {
  if (a.fromSessionId === sessionId) return { label: "this workspace", sentence: "made in this workspace" };
  if (!a.mine) {
    const directory = a.path.split("/")[1] || "a directory";
    return { label: directory, sentence: `shared with you in "${directory}"` };
  }
  const when = `${elapsed(minutesSince(a.updatedAt))} ago`;
  return a.fromWorkspaceName
    ? { label: a.fromWorkspaceName, sentence: `published ${when} from the workspace "${a.fromWorkspaceName}"` }
    : { label: "no workspace", sentence: `published ${when}` };
}

/**
 * The handle for an artifact among the mentions already held.
 *
 * The slug: unique per owner, no spaces, and it reads like a handle. The one
 * case it is not unique is yours against one shared with you under the same
 * name, and then the second gets a number — the way `free_name` on the worker
 * suffixes a second `report.csv`. The same artifact twice is the same handle.
 */
export function handleFor(artifact: Artifact, held: { artifact: Artifact; handle: string }[]): string {
  const same = held.find((m) => m.artifact.id === artifact.id);
  if (same) return same.handle;
  const taken = new Set(held.map((m) => m.handle));
  if (!taken.has(artifact.slug)) return artifact.slug;
  for (let n = 2; ; n++) {
    const handle = `${artifact.slug}-${n}`;
    if (!taken.has(handle)) return handle;
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What may follow a handle for it to count as one: a boundary, not a word. */
const AFTER = "(?=$|[\\s.,;:!?)\\]])";

/**
 * The text with `@handle` struck out wherever it stands on its own.
 *
 * Removing the chip removes the handle — the chip is the attachment, and a
 * handle that resolves to nothing would read as a reference the agent then
 * cannot follow. One following space goes with it, so the sentence closes up.
 */
export function withoutHandle(text: string, handle: string): string {
  const re = new RegExp(`(^|\\s)@${escape(handle)}(?:\\s|${AFTER})`, "g");
  return text.replace(re, "$1");
}

/** The block written under a message, or nothing when there is nothing to say. */
export function mentionBlock(mentions: Mention[], sessionId: string): string {
  if (mentions.length === 0) return "";
  const lines = mentions.map((m) => {
    const where = m.path.endsWith(".zip")
      ? `Files: ${m.path} (unzip it; the page is index.html)`
      : `Page: ${m.path}`;
    return `- @${m.handle} is "${m.artifact.title}" (v${m.artifact.version}), ${originOf(m.artifact, sessionId).sentence}. ${where}`;
  });
  return [HEADING, ...lines].join("\n");
}

const LINE = /^- @(\S+) is "(.+)" \(v(\d+)\), .* (?:Page|Files): (\S+?)(?: \(unzip it; the page is index\.html\))?$/;

/**
 * A message split into what was said and the mentions written under it.
 *
 * Strict on purpose: a block that does not parse line for line is left in the
 * text as it is. Drawing half a block as chips and the other half as prose
 * would be worse than drawing none.
 */
export function splitMentions(text: string): { said: string; mentions: Read[] } {
  const whole = { said: text, mentions: [] as Read[] };
  const at = text.lastIndexOf(HEADING);
  if (at < 0 || (at > 0 && text[at - 1] !== "\n")) return whole;
  const lines = text
    .slice(at + HEADING.length)
    .split("\n")
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) return whole;
  const mentions: Read[] = [];
  for (const line of lines) {
    const m = LINE.exec(line);
    if (!m) return whole;
    mentions.push({ handle: m[1], title: m[2], version: Number(m[3]), path: m[4] });
  }
  return { said: text.slice(0, at).replace(/\s+$/, ""), mentions };
}

/**
 * A sentence cut around its handles, so each can be drawn as one.
 *
 * Longest handle first: `@pricing-2` must not be read as `@pricing` plus
 * `-2`. The character before a handle stays text; a handle is only one when
 * it stands on its own.
 */
export function segments(text: string, handles: string[]): { kind: "text" | "handle"; value: string }[] {
  if (handles.length === 0 || !text) return text ? [{ kind: "text", value: text }] : [];
  const names = [...handles].sort((a, b) => b.length - a.length).map(escape).join("|");
  const re = new RegExp(`(^|[\\s(\\[])(@(?:${names}))${AFTER}`, "g");
  const out: { kind: "text" | "handle"; value: string }[] = [];
  let from = 0;
  for (const m of text.matchAll(re)) {
    const start = (m.index ?? 0) + m[1].length;
    if (start > from) out.push({ kind: "text", value: text.slice(from, start) });
    out.push({ kind: "handle", value: m[2] });
    from = start + m[2].length;
  }
  if (from < text.length) out.push({ kind: "text", value: text.slice(from) });
  return out;
}
