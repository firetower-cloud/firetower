/**
 * What the map has drawn and Save has not written.
 *
 * **The map writes a draft and Save is the only commit.** Adding, removing,
 * moving and re-parenting all show as pending on the map, and Discard restores
 * the whole state — including a removed subtree, because the subtree was never
 * touched. There is therefore no confirmation dialog on the remove control:
 * the undo is Discard, and it is on screen the whole time.
 *
 * A draft is the whole team as a flat list, which is also exactly what the API
 * takes (`NewAgentTeam`). So saving is sending the draft, and there is no
 * translation layer to get wrong — a position that has an id keeps its row and
 * the sessions standing on it, and one with a `draft:` key is minted.
 */
import type { AgentTeam, DraftPosition, Position } from "~/api/generated/model";

/** A team being edited: its name, its positions, and where it came from. */
export type Draft = {
  id: string;
  name: string;
  /** Flat, in sibling order, exactly as the API reads and writes it. */
  positions: Position[];
};

/** A key for a position that does not exist on the server yet. */
export function draftKey(): string {
  return `draft:${Math.random().toString(36).slice(2, 10)}`;
}

/** Whether a position is one the server knows about. */
export function isSaved(id: string): boolean {
  return !id.startsWith("draft:");
}

export function draftOf(team: AgentTeam): Draft {
  return { id: team.id, name: team.name, positions: team.positions.map((p) => ({ ...p })) };
}

/** Every position under this one, not counting itself. */
export function descendants(positions: Position[], id: string): Position[] {
  const out: Position[] = [];
  const walk = (parent: string) => {
    for (const p of positions) {
      if (p.parent !== parent) continue;
      out.push(p);
      walk(p.id);
    }
  };
  walk(id);
  return out;
}

/**
 * Put a profile under a position.
 *
 * It appends, because sibling order is authoritative and a new card belongs
 * where the hand that made it was looking — at the end of the row, not in the
 * middle of it.
 */
export function add(draft: Draft, parent: string, profile: string, name: string, does: string, agent: string | null): Draft {
  const siblings = draft.positions.filter((p) => p.parent === parent);
  return {
    ...draft,
    positions: [
      ...draft.positions,
      {
        id: draftKey(),
        parent,
        profile,
        name,
        does,
        agent,
        redacted: false,
        extraInstructions: "",
        extraSkills: [],
        ordinal: siblings.length,
      },
    ],
  };
}

/** Take a position out, and everything under it. */
export function remove(draft: Draft, id: string): Draft {
  const going = new Set([id, ...descendants(draft.positions, id).map((p) => p.id)]);
  return { ...draft, positions: draft.positions.filter((p) => !going.has(p.id)) };
}

/**
 * Change what a position *adds*, here and nowhere else.
 *
 * **Empty means nothing extra, not everything.** A profile's own scope reads
 * an empty list as "all the owner can reach"; a position's extras are the
 * opposite — the profile already said what the agent is, and this adds to it.
 */
export function grant(draft: Draft, id: string, extraSkills: string[]): Draft {
  return {
    ...draft,
    positions: draft.positions.map((p) => (p.id === id ? { ...p, extraSkills } : p)),
  };
}

/** Change what a position is told, here and nowhere else. */
export function tell(draft: Draft, id: string, extraInstructions: string): Draft {
  return {
    ...draft,
    positions: draft.positions.map((p) => (p.id === id ? { ...p, extraInstructions } : p)),
  };
}

/**
 * Move a position, and its subtree, under another.
 *
 * Refuses to put a position under its own descendant, which is the one move
 * that would not be a tree — and the only one, because a tree has no other way
 * to become a cycle.
 */
export function reparent(draft: Draft, id: string, parent: string): Draft {
  if (id === parent) return draft;
  if (descendants(draft.positions, id).some((p) => p.id === parent)) return draft;
  const siblings = draft.positions.filter((p) => p.parent === parent && p.id !== id);
  return {
    ...draft,
    positions: draft.positions.map((p) => (p.id === id ? { ...p, parent, ordinal: siblings.length } : p)),
  };
}

/** What a draft sends. The API takes exactly this, and the keys are the ids. */
export function toWrite(draft: Draft): { name: string; positions: DraftPosition[] } {
  return {
    name: draft.name.trim(),
    positions: draft.positions.map((p) => ({
      key: p.id,
      parent: p.parent ?? null,
      profile: p.profile,
      extraInstructions: p.extraInstructions,
      extraSkills: p.extraSkills ?? [],
    })),
  };
}

/** One kind of difference between the stored team and the draft. */
export type Change =
  | { kind: "added"; name: string }
  | { kind: "removed"; name: string }
  | { kind: "moved"; name: string }
  | { kind: "told"; name: string }
  | { kind: "granted"; name: string }
  | { kind: "renamed"; name: string }
  | { kind: "lead"; name: string };

/**
 * What Save would write, as a list somebody can read before pressing it.
 *
 * The count on the status strip is this list's length, so the number and the
 * sentence can never disagree — which is the thing a separate counter always
 * eventually does.
 */
export function pending(team: AgentTeam, draft: Draft): Change[] {
  const out: Change[] = [];
  if (team.name.trim() !== draft.name.trim()) out.push({ kind: "renamed", name: draft.name.trim() });
  const was = new Map(team.positions.map((p) => [p.id, p]));
  const now = new Map(draft.positions.map((p) => [p.id, p]));
  for (const p of draft.positions) {
    const before = was.get(p.id);
    if (!before) {
      out.push({ kind: "added", name: p.name });
      continue;
    }
    // The lead position is the team's one fixed row, so a different profile on
    // it is a change of lead rather than an add and a remove.
    if (before.profile !== p.profile && !p.parent) out.push({ kind: "lead", name: p.name });
    if (before.parent !== p.parent) out.push({ kind: "moved", name: p.name });
    if (before.extraInstructions !== p.extraInstructions) out.push({ kind: "told", name: p.name });
    // **Order does not count as a change.** The picker appends as things are
    // ticked, so the same set chosen in another order is the same set — and a
    // Save button lit by a list that reordered itself is a button nobody
    // trusts.
    if (!sameSet(before.extraSkills ?? [], p.extraSkills ?? [])) {
      out.push({ kind: "granted", name: p.name });
    }
  }
  for (const p of team.positions) {
    if (!now.has(p.id)) out.push({ kind: "removed", name: p.name });
  }
  return out;
}

/** Whether two id lists hold the same things, whatever order they are in. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const held = new Set(a);
  return b.every((id) => held.has(id));
}

/** The pending state of one card, for the ring the map draws on it. */
export function markOf(team: AgentTeam, draft: Draft, id: string): "add" | "move" | null {
  const before = team.positions.find((p) => p.id === id);
  if (!before) return "add";
  const now = draft.positions.find((p) => p.id === id);
  if (now && before.parent !== now.parent) return "move";
  return null;
}
