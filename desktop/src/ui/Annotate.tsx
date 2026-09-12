/**
 * Writing a note against a selection.
 *
 * It opens **where you selected**, not at the foot of the window: the whole
 * point of annotating rather than typing into the composer is that the note is
 * attached to a specific piece of text, and a panel three hundred pixels away
 * loses the connection the gesture just made.
 *
 * Anchored in viewport coordinates and clamped to the window. It deliberately
 * does not follow the text on scroll — you scrolled to leave, and it closes on
 * Escape, on a click outside, or on keeping the note.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CornerDownLeft, MessageSquarePlus } from "lucide-react";

export type Anchor = { quote: string; line: number; x: number; y: number };

const W = 360;

export function Annotate({
  at,
  onKeep,
  onCancel,
}: {
  at: Anchor;
  onKeep: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [box, setBox] = useState({ left: at.x, top: at.y });
  const card = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const height = card.current?.offsetHeight ?? 150;
    // Below the selection by default, above it when there is no room.
    const below = at.y + 10;
    const top = below + height > window.innerHeight - 12 ? Math.max(12, at.y - height - 18) : below;
    const left = Math.min(Math.max(12, at.x - W / 2), window.innerWidth - W - 12);
    setBox({ left, top });
  }, [at]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

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
          <span className="text-meta text-dim">Note on line {at.line}</span>
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
