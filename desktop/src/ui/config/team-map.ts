/**
 * The map's model: a draft tree, what it would write, and where every card
 * lands.
 *
 * All of it pure. The screen holds one `Seat` tree in state and nothing else —
 * the diff, the geometry and the request body are derived from it — which is
 * what makes **Save the only commit** a property of the data rather than a
 * rule the component has to remember, and what lets Discard be an assignment.
 *
 * ## Hybrid, and why it is not an organigramme throughout
 *
 * The lead and its children spread horizontally with elbow connectors; from
 * the second level down the shape is a chain, and a chain indents. This was
 * measured rather than preferred: a full organigramme throughout came out at
 * 4640px on the hardest lane, 3.9 screens, because an org chart gives each
 * card one parent and the same profile under three managers becomes three
 * cards. The width is the duplication, not the card. Hybrid came out at 504px
 * and complete. `agent-org` has the six arrangements and the measurements.
 *
 * Every number below is the prototype's, and `team-map.test.ts` asserts the
 * two seeded lanes come out at the sizes it measured — 648 × 296 and
 * 862 × 226 — so a change to any of them fails rather than drifts.
 */
import type { NewPosition, Position } from "~/api/generated/model";

/* ── The draft ───────────────────────────────────────────────────────────── */

/**
 * One position, as the map holds it while it is being drawn.
 *
 * `id` is the server's, and **absent means this seat does not exist yet**.
 * Carrying it back on the save is what keeps `sessions.position_id` pointing
 * at a row when somebody saves a team an agent is running in — see
 * `NewPosition.id`. `key` is this window's own and never leaves it: two new
 * seats of one profile need telling apart before either has an id.
 */
export type Seat = {
  key: string;
  id: string | null;
  profile: string;
  instructions: string;
  children: Seat[];
};

let minted = 0;
/** A key for a seat this window has just made up. Never sent anywhere. */
export const mintKey = () => `new-${++minted}`;

/**
 * The tree, from the flat list the API answers with.
 *
 * `positions` arrives lead first and then depth-first in sibling order, so a
 * single pass that hangs each seat off the parent it names rebuilds the tree
 * in the order the server meant. A team whose lead profile was deleted has no
 * positions at all — a real state, not a broken one — and answers `null`.
 */
export function fromPositions(positions: Position[]): Seat | null {
  const seats = new Map<string, Seat>();
  for (const p of positions) {
    seats.set(p.id, { key: p.id, id: p.id, profile: p.profile, instructions: p.instructions, children: [] });
  }
  let root: Seat | null = null;
  for (const p of positions) {
    const seat = seats.get(p.id);
    if (!seat) continue;
    if (!p.parent) {
      root ??= seat;
      continue;
    }
    seats.get(p.parent)?.children.push(seat);
  }
  return root;
}

/** The whole tree as the one nested body `POST` and `PUT` both take. */
export function toNewPosition(seat: Seat): NewPosition {
  return {
    ...(seat.id ? { id: seat.id } : {}),
    profile: seat.profile,
    ...(seat.instructions ? { instructions: seat.instructions } : {}),
    ...(seat.children.length ? { children: seat.children.map(toNewPosition) } : {}),
  };
}

/* ── Reading a draft ─────────────────────────────────────────────────────── */

/** Every seat, lead first and then depth-first, the way the API reads them. */
export function flatten(root: Seat | null): Seat[] {
  if (!root) return [];
  const out: Seat[] = [];
  const walk = (s: Seat) => {
    out.push(s);
    s.children.forEach(walk);
  };
  walk(root);
  return out;
}

/** How deep the tree is, counting the lead. `0` for no tree at all. */
export function depthOf(root: Seat | null): number {
  if (!root) return 0;
  return 1 + Math.max(0, ...root.children.map(depthOf));
}

/** What a seat has under it, however far down. */
export function countUnder(seat: Seat): number {
  return seat.children.reduce((n, k) => n + 1 + countUnder(k), 0);
}

/** Which seat holds this key, and which seat holds that one. */
export function find(root: Seat | null, key: string): Seat | null {
  return flatten(root).find((s) => s.key === key) ?? null;
}

function parentOf(root: Seat | null, key: string): Seat | null {
  for (const s of flatten(root)) if (s.children.some((k) => k.key === key)) return s;
  return null;
}

/** Who this seat reports to, by key. `null` for the lead. */
export function parentKeyOf(root: Seat | null, key: string): string | null {
  return parentOf(root, key)?.key ?? null;
}

/* ── Editing a draft ─────────────────────────────────────────────────────── */

/* Each returns a new tree. Nothing below mutates what it was given: the
   original tree is kept beside the draft so Discard is an assignment and the
   diff is a comparison, and sharing a child between the two would quietly
   make both of those lie. */

const copy = (s: Seat): Seat => ({ ...s, children: s.children.map(copy) });

/** A new seat for `profile`, under the seat `parentKey` names. */
export function addChild(root: Seat, parentKey: string, profile: string): Seat {
  const put = (s: Seat): Seat =>
    s.key === parentKey
      ? {
          ...s,
          children: [
            ...s.children.map(copy),
            { key: mintKey(), id: null, profile, instructions: "", children: [] },
          ],
        }
      : { ...s, children: s.children.map(put) };
  return put(root);
}

/**
 * Take a seat out, **and everything under it**.
 *
 * A position owns its subtree, so there is nothing to re-parent and no
 * orphans to invent a home for. The lead cannot be removed — removing it
 * would remove the team, which is done from the list — so a root key is a
 * no-op rather than an empty tree.
 */
export function removeSeat(root: Seat, key: string): Seat {
  if (root.key === key) return root;
  const cut = (s: Seat): Seat => ({
    ...s,
    children: s.children.filter((k) => k.key !== key).map(cut),
  });
  return cut(root);
}

/**
 * What this seat says, which applies here and nowhere else.
 *
 * **Part of the draft**, so it joins the pending count and Discard puts it
 * back — the map holds one tree and Save is the only commit, and a field that
 * wrote as it was typed would be a second commit on a screen whose whole
 * design note is that there is one. The drawer's *Custom* tab calls this.
 */
export function say(root: Seat, key: string, instructions: string): Seat {
  const put = (s: Seat): Seat =>
    s.key === key
      ? { ...s, instructions, children: s.children.map(copy) }
      : { ...s, children: s.children.map(put) };
  return put(root);
}

/** Every seat this one could be moved under: not itself, and not below it. */
export function couldReportTo(root: Seat | null, key: string): Seat[] {
  const seat = find(root, key);
  if (!root || !seat || root.key === key) return [];
  const below = new Set(flatten(seat).map((s) => s.key));
  return flatten(root).filter((s) => !below.has(s.key));
}

/** Every profile from the lead down to this seat, the seat's own included. */
export function lineage(root: Seat | null, key: string): string[] {
  const walk = (s: Seat, trail: string[]): string[] | null => {
    const here = [...trail, s.profile];
    if (s.key === key) return here;
    for (const k of s.children) {
      const found = walk(k, here);
      if (found) return found;
    }
    return null;
  };
  return (root && walk(root, [])) ?? [];
}

/**
 * **What the add-a-seat list says about a profile, and whether it may be
 * picked.**
 *
 * Two structural rules decide a seat before the server is asked, and
 * `agent_teams::check` refuses on either of them every time — they are a
 * property of the tree on screen, not of anything the server knows and the
 * client does not.
 *
 * * **One profile at most once among one position's children.** A lead hands
 *   work off by name, so two sibling seats of one profile would be a name
 *   that does not say which is meant.
 * * **A profile may not report to itself, however far up.** A chain of agents
 *   of one kind handing the same work down is the shape with no natural end.
 *
 * Both are said on the row, and **both block it**. The second used to be said
 * and left pickable, so pressing it drew the seat into the draft and spent a
 * Save to come back 400 — a choice already known to fail, offered anyway,
 * which the drawer one screen over states the rule against: *so that Save is
 * not a button that looks live and comes back refused.*
 *
 * A blocked row is still drawn rather than hidden: a profile missing from a
 * list somebody is searching reads as a profile that does not exist, and the
 * reason it cannot be picked is the thing worth saying.
 */
export function seatTag(
  profile: string,
  siblings: Iterable<string>,
  above: Iterable<string>,
): { says: string; blocked: boolean } | null {
  if ([...siblings].includes(profile)) {
    return { says: "already reports here", blocked: true };
  }
  if ([...above].includes(profile)) {
    return { says: "already above this seat", blocked: true };
  }
  return null;
}

/**
 * Re-parent a seat, with its subtree.
 *
 * **The map draws no control for this and the drawer does.** The prototype
 * draws none either, so #492 would have had to invent one; the drawer is
 * where a position is edited, and *reports to* is a field of a position. The
 * draft is the map's, so a move joins the pending count and Discard puts it
 * back.
 */
export function moveSeat(root: Seat, key: string, parentKey: string): Seat {
  const seat = find(root, key);
  if (!seat || root.key === key || key === parentKey) return root;
  /* Into its own subtree would detach the branch from the tree entirely. */
  if (flatten(seat).some((s) => s.key === parentKey)) return root;
  const without = removeSeat(root, key);
  const moved = copy(seat);
  const put = (s: Seat): Seat =>
    s.key === parentKey
      ? { ...s, children: [...s.children.map(copy), moved] }
      : { ...s, children: s.children.map(put) };
  return put(without);
}

/* ── The pending diff ────────────────────────────────────────────────────── */

export type Change =
  | { kind: "add"; key: string; profile: string }
  | { kind: "remove"; id: string; profile: string; under: number }
  | { kind: "move"; id: string; profile: string }
  | { kind: "said"; id: string; profile: string };

/**
 * What the draft would do, derived rather than logged.
 *
 * Four kinds: a seat added, a seat taken out, a seat moved, and a seat whose
 * own instructions were changed. The last three only ever apply to a seat the
 * server already knows about; a seat that does not exist yet carries its
 * instructions and its place with it, and counting those separately would say
 * somebody pressed three things to add one card.
 *
 * **One entry per gesture, not per card.** Taking out a position with three
 * under it is one change and not four — the three went because the one did,
 * and a count of four would say somebody pressed four things. So a removed
 * seat whose parent also went is not counted; only the top of a removed
 * branch is. An added seat is counted on its own, because each one was a
 * separate press.
 *
 * Deriving it is also what makes adding a seat and then taking it out again
 * read as nothing pending, which an operation log gets wrong by default.
 */
export function changes(original: Seat | null, draft: Seat | null): Change[] {
  const before = new Map(flatten(original).map((s) => [s.key, s]));
  const after = new Map(flatten(draft).map((s) => [s.key, s]));
  const out: Change[] = [];

  for (const s of flatten(draft)) {
    if (!before.has(s.key)) {
      /* A seat under a seat that is itself new is still a press of its own. */
      if (!s.id) out.push({ kind: "add", key: s.key, profile: s.profile });
      continue;
    }
    const was = parentOf(original, s.key);
    const now = parentOf(draft, s.key);
    if (s.id && was?.key !== now?.key) out.push({ kind: "move", id: s.id, profile: s.profile });
    /* **What a seat says is part of the draft too**, and it was not in this
       diff: the drawer's *Custom* tab wrote straight into the tree, the map
       redrew with the new line on the card, and the pending count stayed at
       nothing — so Save was never offered and the words went when the screen
       did. A tree-shape diff is not the whole of a tree. One entry per seat,
       however many characters were typed into it. */
    /* Not an `else`: moving a card and rewording it are two gestures on one
       card, and the count beside Save says how many decisions are waiting. */
    if (s.id && before.get(s.key)?.instructions !== s.instructions) {
      out.push({ kind: "said", id: s.id, profile: s.profile });
    }
  }

  for (const s of flatten(original)) {
    if (after.has(s.key)) continue;
    const was = parentOf(original, s.key);
    /* Its parent went too, so this one went with it rather than on its own. */
    if (was && !after.has(was.key)) continue;
    if (s.id) out.push({ kind: "remove", id: s.id, profile: s.profile, under: countUnder(s) });
  }

  return out;
}

/* ── Geometry ────────────────────────────────────────────────────────────── */

/**
 * The card, and the arrangement around it.
 *
 * `SPREAD_TO` is where the organigramme stops: levels 0 and 1 spread their
 * children horizontally, and a card at level 1 or below indents its own.
 * Raising it is what measured at 4640px.
 */
export const CARD_W = 176;
export const CARD_H = 34;
/** A line for the extra instructions this seat carries, when it carries any. */
const BRIEF_H = 16;
const GAP_X = 16;
const GAP_Y = 38;
const PAD_X = 22;
const PAD_Y = 30;
const INDENT = 22;
const INDENT_GAP = 8;
const INDENT_DROP = 10;
const SPREAD_TO = 2;
/** Where an indented rail hangs: under the card's glyph, not its edge. */
const RAIL_X = 13;

/**
 * A skill chip, measured off the rendered pill rather than estimated.
 *
 * 9px in a grey pill with 7px of padding each side costs 14px plus about
 * 4.4px a character, so two chips share a row whenever their names are short
 * enough — which is what dropping the per-chip glyph bought. A glyph cost a
 * third of the chip's width at this size, and `docs/built-in-skills.md`
 * rejects per-skill icons outright as decoration standing in for the
 * description.
 */
const CHIP_INNER = 143;
const CHIP_PAD = 14;
const CHIP_CHAR = 4.45;
const CHIP_GAP = 3;
export const CHIP_ROW_H = 14;

/**
 * How many chips a card draws before it stops and counts the rest.
 *
 * **Ten, and it was five.** The argument for five was that ten reached a
 * 155px card — four and a half times its neighbours, and a node towering over
 * its own subtree stops reading as a tree. Dropping the per-chip glyph cut
 * that to 120px and cut the gap between five and ten to fourteen pixels and
 * one row, and a skills view that hides skills to save fourteen pixels is
 * answering its own question badly. A cap still has to exist: uncapped, a
 * twenty-skill profile is fourteen rows on a 34px card.
 */
export const SKILL_CAP = 10;

const chipW = (name: string) => name.length * CHIP_CHAR + CHIP_PAD;

/**
 * Whole names, in order, filling each row before opening the next.
 *
 * **Not first-fit across open rows.** True first-fit packs seven skills into
 * four rows instead of five by dropping a later chip into an earlier gap — one
 * row cheaper, and it breaks the alphabetical run, which is the thing somebody
 * scanning for "does this one know X" is actually reading. Order beat the row.
 *
 * Nothing is clipped mid-word: a half a skill name can be neither read nor
 * searched for, so the cap is a row budget and the remainder is a count.
 */
export function chipRows(names: string[], cap: number = SKILL_CAP): string[][] {
  const take = names.slice(0, cap);
  const extra = names.length - take.length;
  const rows: string[][] = [];
  let row: string[] = [];
  let left = CHIP_INNER;
  const put = (n: string) => {
    const w = chipW(n) + (row.length ? CHIP_GAP : 0);
    if (row.length && w > left) {
      rows.push(row);
      row = [n];
      left = CHIP_INNER - chipW(n);
    } else {
      row.push(n);
      left -= w;
    }
  };
  for (const n of take) put(n);
  if (extra) put(`+${extra}`);
  if (row.length) rows.push(row);
  return rows;
}

export type Card = {
  seat: Seat;
  depth: number;
  parent: Card | null;
  children: Card[];
  x: number;
  y: number;
  w: number;
  h: number;
  /** Whether its own children spread beneath it or indent under it. */
  spread: boolean;
  /** This profile has been drawn higher up the same map. */
  again: boolean;
};

/** One hairline. Boxes rather than paths, so the map is spans and no SVG. */
export type Rule = { x: number; y: number; w: number; h: number };

export type Laid = {
  cards: Card[];
  rules: Rule[];
  width: number;
  height: number;
  /** How many profiles hold more than one position here. */
  repeats: number;
};

/**
 * Where everything goes.
 *
 * `skills` is the names, by profile id, and **only when the map is showing
 * them**: the switch changes a card's height and never its width, which is
 * what `team-map.test.ts` pins at every cap.
 */
export function layout(root: Seat | null, skills?: Map<string, string[]>): Laid {
  if (!root) return { cards: [], rules: [], width: 0, height: 0, repeats: 0 };

  const seen = new Set<string>();
  const repeated = new Set<string>();
  const cards: Card[] = [];

  const heightOf = (seat: Seat) => {
    const chips = skills?.get(seat.profile) ?? [];
    return (
      CARD_H +
      (seat.instructions.trim() ? BRIEF_H : 0) +
      (chips.length ? chipRows(chips).length * CHIP_ROW_H : 0)
    );
  };

  const build = (seat: Seat, depth: number, parent: Card | null): Card => {
    const again = seen.has(seat.profile);
    if (again) repeated.add(seat.profile);
    seen.add(seat.profile);
    const card: Card = {
      seat,
      depth,
      parent,
      children: [],
      x: 0,
      y: 0,
      w: CARD_W,
      h: heightOf(seat),
      spread: depth + 1 < SPREAD_TO,
      again,
    };
    cards.push(card);
    card.children = seat.children.map((k) => build(k, depth + 1, card));
    return card;
  };
  const top = build(root, 0, null);

  /** The box a card and everything under it occupies. */
  type Block = { card: Card; w: number; h: number; kids: Block[]; row: number };
  const block = (card: Card): Block => {
    if (!card.children.length) return { card, w: CARD_W, h: card.h, kids: [], row: 0 };
    const kids = card.children.map(block);
    if (!card.spread) {
      return {
        card,
        w: Math.max(CARD_W, INDENT + Math.max(...kids.map((k) => k.w))),
        h: card.h + INDENT_DROP + kids.reduce((s, k) => s + k.h + INDENT_GAP, 0) - INDENT_GAP,
        kids,
        row: 0,
      };
    }
    const row = kids.reduce((s, k) => s + k.w, 0) + (kids.length - 1) * GAP_X;
    return {
      card,
      w: Math.max(CARD_W, row),
      h: card.h + GAP_Y + Math.max(...kids.map((k) => k.h)),
      kids,
      row,
    };
  };

  const place = (b: Block, x: number, y: number) => {
    const card = b.card;
    if (!card.spread) {
      card.x = x;
      card.y = y;
      let at = y + card.h + INDENT_DROP;
      for (const k of b.kids) {
        place(k, x + INDENT, at);
        at += k.h + INDENT_GAP;
      }
      return;
    }
    card.x = x + (b.w - CARD_W) / 2;
    card.y = y;
    if (!b.kids.length) return;
    let at = x + (b.w - b.row) / 2;
    const below = y + card.h + GAP_Y;
    for (const k of b.kids) {
      place(k, at, below);
      at += k.w + GAP_X;
    }
  };

  const whole = block(top);
  place(whole, PAD_X, PAD_Y);

  return {
    cards,
    rules: rulesFor(cards),
    width: whole.w + PAD_X * 2,
    height: whole.h + PAD_Y * 2,
    repeats: repeated.size,
  };
}

/**
 * The connectors.
 *
 * An elbow where the children spread — down from the bottom centre, across,
 * then down into each child — and a rail with ticks where they indent. The
 * trunk leaves a card at its bottom centre, which is why the control that
 * makes a child sits there and not in a corner.
 */
function rulesFor(cards: Card[]): Rule[] {
  const out: Rule[] = [];
  for (const a of cards) {
    if (!a.children.length) continue;
    if (!a.spread) {
      const last = a.children[a.children.length - 1];
      out.push({
        x: a.x + RAIL_X,
        y: a.y + a.h,
        w: 1,
        h: last.y + last.h / 2 - (a.y + a.h),
      });
      for (const k of a.children) {
        out.push({ x: a.x + RAIL_X, y: k.y + k.h / 2, w: k.x - a.x - RAIL_X, h: 1 });
      }
      continue;
    }
    const top = a.y + a.h;
    const mid = top + Math.round((a.children[0].y - top) / 2);
    const stem = a.x + a.w / 2;
    out.push({ x: stem, y: top, w: 1, h: mid - top });
    const centres = a.children.map((k) => k.x + k.w / 2);
    const from = Math.min(stem, ...centres);
    const to = Math.max(stem, ...centres);
    if (a.children.length > 1 || centres[0] !== stem) {
      out.push({ x: from, y: mid, w: to - from, h: 1 });
    }
    for (const k of a.children) out.push({ x: k.x + k.w / 2, y: mid, w: 1, h: k.y - mid });
  }
  return out;
}
