/**
 * Writing a note against a selection.
 *
 * It opens **where you pointed**, not at the foot of the window: the whole
 * point of annotating rather than typing into the composer is that the note is
 * attached to a specific piece of text, and a panel three hundred pixels away
 * loses the connection the gesture just made.
 *
 * Anchored in viewport coordinates and clamped to the window. It deliberately
 * does not follow the text on scroll — you scrolled to leave, and it closes on
 * Escape, on a click outside, or on keeping the note.
 *
 * **Selecting text is two questions, not one** — note it, or take it away —
 * and this card used to answer only the first. Worse, it broke the second:
 * the textarea takes focus the moment the card opens, so the ⌘C that a hand
 * reaches for next lands on an empty box. So the header carries a copy, and
 * ⌘C means it while the note is still blank. See `copy` on `Anchor`.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Copy, CornerDownLeft, MessageSquarePlus } from "lucide-react";
import { write } from "~/components/ui/Copy";
import { key } from "~/platform";

/**
 * Where a note goes: a line of a file, or something the agent said (`line` 0,
 * named by `label`). `x` and `y` are a *point* in the window — where the
 * pointer was — not a corner of what was selected.
 */
export type Anchor = {
  quote: string;
  line: number;
  label?: string;
  x: number;
  y: number;
  /**
   * The whole of what was selected, when `quote` is an abridgement of it —
   * every caller clips the quote so the card stays a card, and nobody wants
   * four hundred characters and an ellipsis on their clipboard.
   *
   * Absent where there is no text behind the note: a point on an image, or an
   * element picked out of a page, where a copy would offer co-ordinates or
   * raw markup and neither is what the gesture asked for. The control is
   * drawn only when this is here.
   */
  copy?: string;
};

const W = 360;
/** Breathing room at the window's edge, and between the card and its point. */
const EDGE = 12;
const GAP = 10;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

export type Side = "below" | "above";
export type Box = { left: number; top: number; side: Side };

/**
 * Where the card goes, given the point it is about and how big it turned out.
 *
 * Two rules, in this order. The card reads best just below the point, or above
 * it when the window has no room underneath. And wherever that lands, it is
 * clamped inside the window — placement decides where it belongs, the clamp
 * decides that it is on screen at all, and the clamp is not allowed to lose.
 *
 * That order is the whole fix. Anchoring to the *edge* of a selection instead
 * of the point put the card off the bottom of the window whenever the element
 * or the passage was taller than the view, and a half-height clamp left it
 * there.
 *
 * `keep` holds the side a card already chose. A card that is re-measured
 * slides to stay in the window; it does not hop over the cursor to the other
 * side of a point you are still looking at.
 */
export function place(
  at: { x: number; y: number },
  card: { width: number; height: number },
  view: { width: number; height: number },
  keep?: Side,
): Box {
  const below = at.y + GAP;
  const above = at.y - card.height - GAP;
  const side = keep ?? (below + card.height <= view.height - EDGE || above < EDGE ? "below" : "above");
  return {
    side,
    left: clamp(at.x - card.width / 2, EDGE, view.width - card.width - EDGE),
    top: clamp(side === "below" ? below : above, EDGE, view.height - card.height - EDGE),
  };
}

export function Annotate({
  at,
  onKeep,
  onCancel,
  onParent,
}: {
  at: Anchor;
  onKeep: (text: string) => void;
  onCancel: () => void;
  /** Offered when the note is on an element and its parent might be the better one. */
  onParent?: () => void;
}) {
  const [text, setText] = useState("");
  const [box, setBox] = useState<Box>({ left: at.x, top: at.y, side: "below" });
  const card = useRef<HTMLDivElement>(null);
  /* Frozen for the life of the card. Stepping to the parent element picks a
     new selection under the same pointer, and a card that jumped away at that
     moment would take a half-written note with it. */
  const anchor = useRef(at);
  const side = useRef<Side | undefined>(undefined);
  /* Only the refusal is held. A copy that worked closes the card, so there is
     no state left to say so in — and a clipboard that *refused* needs a
     sentence rather than a shrug, because a self-hosted Firetower is often
     reached over plain http where `navigator.clipboard` is simply not there. */
  const [refused, setRefused] = useState(false);

  /* Taking the selection away instead of noting it.
     The card closes on success: you asked for the text, you have it, and the
     card is sitting on top of what you were reading. */
  const takeAway = async () => {
    if (!at.copy) return;
    if (await write(at.copy)) onCancel();
    else setRefused(true);
  };

  useLayoutEffect(() => {
    const node = card.current;
    if (!node) return;
    const fit = () => {
      const next = place(anchor.current, node.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, side.current);
      side.current = next.side;
      setBox(next);
    };
    fit();
    // The card is measured, so it is re-measured: a web font swapping in
    // changes its height after it opens, and the window can be resized under
    // it. Either way it stays inside the window.
    const watch = new ResizeObserver(fit);
    watch.observe(node);
    window.addEventListener("resize", fit);
    return () => {
      watch.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onCancel();
      /* ⌘C, which the card broke by taking focus — and only while the note is
         still blank, because once there are words in it ⌘C is about them. */
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && at.copy && !text) {
        e.preventDefault();
        void takeAway();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <>
      {/* Catches the click that dismisses, without dimming the file — you are
          meant to keep reading the code you just selected. */}
      <div className="fixed inset-0 z-40" onMouseDown={onCancel} />

      <div
        ref={card}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ left: box.left, top: box.top, width: W }}
        className="fixed z-50 overflow-hidden rounded-xl border border-line bg-overlay shadow-(--shadow-float)"
      >
        <div className="flex items-center gap-2 px-3.5 pt-3">
          <MessageSquarePlus className="h-3.5 w-3.5 shrink-0 text-slate" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate text-meta text-dim">{at.label ?? `Note on line ${at.line}`}</span>
          {at.copy && (
            <button
              onClick={takeAway}
              title={refused ? "Couldn't copy it" : `Copy the selection  ${key("C")}`}
              className={`grid h-6 w-6 shrink-0 place-items-center rounded transition-colors hover:bg-raise hover:text-bone ${
                refused ? "text-brick" : "text-mute"
              }`}
            >
              <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          )}
          {onParent && (
            <button onClick={onParent} title="Pick the element around this one" className="grid h-6 w-6 shrink-0 place-items-center rounded text-mute hover:bg-raise hover:text-bone">
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          )}
        </div>

        <p className="scroll-slim mx-3.5 mt-2 max-h-16 overflow-y-auto border-l-2 border-slate-deep pl-2.5 font-mono text-micro whitespace-pre-wrap text-mute">
          {at.quote}
        </p>

        <div className="mt-3 flex items-end gap-2 border-t border-line px-3 py-2.5">
          <textarea
            autoFocus
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (text.trim()) onKeep(text.trim());
              }
            }}
            placeholder="What should change here?"
            className="scroll-slim max-h-24 min-w-0 flex-1 resize-none bg-transparent text-ui text-bone placeholder:text-mute focus:outline-none"
          />
          <button
            disabled={!text.trim()}
            onClick={() => text.trim() && onKeep(text.trim())}
            title="Keep this note"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-bone text-ground transition-opacity hover:opacity-90 disabled:bg-raise disabled:text-mute"
          >
            <CornerDownLeft className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </>
  );
}
