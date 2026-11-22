/**
 * Where every card on a team map goes.
 *
 * **Hybrid, not a classic organigramme.** The lead and its first two levels
 * spread horizontally under their parent with elbow connectors; everything
 * below indents. The arrangement was chosen by measuring both on the hardest
 * lane the prototype draws: a classic organigramme throughout is 4640px wide —
 * 3.9 screens — and the hybrid is 504px and complete. Spreading buys
 * separation where a parent has several children and buys nothing at all where
 * the shape is a chain, which is what everything below level two is.
 *
 * Pure, and takes no React: the numbers are the thing being tested, and a
 * layout that can only be checked by rendering it cannot be checked at all.
 * Every constant here is the prototype's own, measured on the rendered card.
 */
import type { AgentTeam, Position } from "~/api/generated/model";

/** The card, and the space around it. The prototype's measurements.
 *
 * **These grew.** The first cut drew a 176×34 card, which is the panel row's
 * geometry — right for a list and wrong for a canvas, where a card is a thing
 * you arrange rather than a line you read down. On a map there is no column
 * to keep to, so the card is sized for the name it carries: 208×40, and a
 * level of air between siblings that the eye can actually cross. */
export const CW = 208;
export const CH = 40;
/** Gap between siblings that spread, across and down. */
export const HG = 18;
export const VG = 44;
/** The canvas's own padding, so a card's controls are never against an edge. */
export const PX = 28;
export const PY = 34;
/** One step of indent, below the level that stops spreading. */
export const IND = 26;
/**
 * Where spreading stops. The lead is depth 0, so the lead's own children are
 * drawn across under it with elbows, and everything from the grandchildren
 * down indents — which is the hybrid the measurements chose.
 */
export const SPREAD_TO = 2;

/** A card that carries extra instructions is one line taller, and shows them. */
export const BRIEF_H = 17;

/** A node of the drafted tree, before it has a position on the canvas. */
export type Node = {
  /** The position's id, or a draft key for one that has not been saved. */
  key: string;
  position: Position;
  depth: number;
  parent: Node | null;
  kids: Node[];
  /** What the draft has done to it and Save has not committed. */
  pending: "add" | "move" | null;
};

/** A node with somewhere to be drawn. */
export type Card = Node & { x: number; y: number; w: number; h: number };

export type Link = { from: Card; to: Card; kind: "elbow" | "indent" };

export type Laid = { cards: Card[]; links: Link[]; w: number; h: number };

/** The tree a team's flat position list describes, in sibling order. */
export function treeOf(positions: Position[]): Node | null {
  const lead = positions.find((p) => !p.parent);
  if (!lead) return null;
  const build = (position: Position, depth: number, parent: Node | null): Node => {
    const node: Node = { key: position.id, position, depth, parent, kids: [], pending: null };
    node.kids = positions
      .filter((p) => p.parent === position.id)
      .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))
      .map((p) => build(p, depth + 1, node));
    return node;
  };
  return build(lead, 0, null);
}

/** Every node of a tree, parents before children. */
export function flatten(root: Node | null): Node[] {
  if (!root) return [];
  const out: Node[] = [];
  const walk = (n: Node) => {
    out.push(n);
    n.kids.forEach(walk);
  };
  walk(root);
  return out;
}

/** Everything under this node, not counting itself. */
export function subtreeOf(node: Node): Node[] {
  const out: Node[] = [];
  const walk = (n: Node) => n.kids.forEach((k) => (out.push(k), walk(k)));
  walk(node);
  return out;
}

/** How tall one card wants to be: the base, plus a line for instructions. */
export function heightOf(node: Node): number {
  return CH + (node.position.extraInstructions.trim() ? BRIEF_H : 0);
}

/**
 * How tall each card actually is, with a spread row levelled off.
 *
 * **Siblings drawn across share a height.** Two of four carrying a line of
 * instructions and two not left the row bottom-ragged — four cards on one
 * level reading as four different kinds of thing, which is the opposite of
 * what a level means. They are the same kind of thing and they sit on the
 * same baseline.
 *
 * Only a spread row. Indented children are a stack, where each one's height
 * is its own business and levelling them would add space to say nothing.
 */
function heights(root: Node): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (node: Node) => {
    if (!out.has(node.key)) out.set(node.key, heightOf(node));
    if (node.kids.length && node.depth + 1 < SPREAD_TO) {
      const tallest = Math.max(...node.kids.map(heightOf));
      for (const kid of node.kids) out.set(kid.key, tallest);
    }
    node.kids.forEach(walk);
  };
  walk(root);
  return out;
}

/**
 * Place every card.
 *
 * Two passes, which is what keeps a parent centred over children it has not
 * been measured against yet: `block` measures a subtree bottom-up, and `place`
 * walks top-down putting each card where its measured block says.
 */
export function layout(root: Node | null): Laid {
  if (!root) return { cards: [], links: [], w: PX * 2, h: PY * 2 };
  const links: Link[] = [];
  const at = new Map<string, { x: number; y: number }>();
  const tall = heights(root);
  const hOf = (node: Node) => tall.get(node.key) ?? heightOf(node);

  type Block = { w: number; h: number; node: Node; kids: Block[]; indent?: boolean; rw?: number };
  const block = (node: Node): Block => {
    const own = hOf(node);
    if (!node.kids.length) return { w: CW, h: own, node, kids: [] };
    const kids = node.kids.map(block);
    if (node.depth + 1 >= SPREAD_TO) {
      // Indented: the block is as wide as its widest child plus the step, and
      // as tall as the children stacked.
      const w = Math.max(CW, IND + Math.max(...kids.map((k) => k.w)));
      const h = own + 12 + kids.reduce((s, k) => s + k.h + 9, 0) - 9;
      return { w, h, node, kids, indent: true };
    }
    const rw = kids.reduce((s, k) => s + k.w, 0) + (kids.length - 1) * HG;
    return { w: Math.max(CW, rw), h: own + VG + Math.max(...kids.map((k) => k.h)), node, kids, rw };
  };

  const cards: Card[] = [];
  const made = new Map<string, Card>();
  const card = (node: Node, x: number, y: number): Card => {
    const c: Card = { ...node, x, y, w: CW, h: hOf(node) };
    cards.push(c);
    made.set(node.key, c);
    at.set(node.key, { x, y });
    return c;
  };

  const place = (b: Block, x: number, y: number): Card => {
    const own = hOf(b.node);
    if (b.indent) {
      const self = card(b.node, x, y);
      let yy = y + own + 12;
      for (const k of b.kids) {
        const child = place(k, x + IND, yy);
        links.push({ from: self, to: child, kind: "indent" });
        yy += k.h + 9;
      }
      return self;
    }
    // Centred over the block its children fill, which is what makes a parent
    // sit above the middle of its row rather than above its first child.
    const self = card(b.node, x + (b.w - CW) / 2, y);
    if (!b.kids.length) return self;
    let xx = x + (b.w - (b.rw ?? CW)) / 2;
    const yy = y + own + VG;
    for (const k of b.kids) {
      const child = place(k, xx, yy);
      links.push({ from: self, to: child, kind: "elbow" });
      xx += k.w + HG;
    }
    return self;
  };

  const measured = block(root);
  place(measured, PX, PY);
  /* **Measured off the cards, not off the blocks.** A block's height is the
     room its subtree was *allowed*, and for an indented branch that is more
     than the cards in it occupy — so sizing the canvas from it left a third
     of the box empty under the tree. The cards are the drawing; they are
     what it is measured by. */
  const right = cards.reduce((x, c) => Math.max(x, c.x + c.w), 0);
  const bottom = cards.reduce((y, c) => Math.max(y, c.y + c.h), 0);
  return { cards, links, w: right + PX, h: bottom + PY };
}

/** How deep a team goes, the lead's level being the first. */
export function depthOf(team: AgentTeam): number {
  const root = treeOf(team.positions);
  return flatten(root).reduce((d, n) => Math.max(d, n.depth + 1), 0);
}

/** The lead of a team, which is its one position with no parent. */
export function leadOf(team: AgentTeam): Position | undefined {
  return team.positions.find((p) => !p.parent);
}
