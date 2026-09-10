"use client";

import { useEffect, useRef, useState } from "react";
import { useSessionDiff } from "@/src/api/generated/sessions/sessions";
import { ApiError } from "@/src/api/http";
import { useOpen, useTabs } from "@/src/workspace/tabs";
import { useCodeSize } from "@/src/workspace/code";

/**
 * What changed in one file.
 *
 * One file rather than the whole list, because the list already exists in the
 * panel on the right — and a tab that reproduced it would mean two places to
 * choose a file and a selection that disagreed between them.
 *
 * ## A patch is 80 columns and a phone is about 40
 *
 * So it wraps, and a wrapped line says so. This is the single largest
 * difference between a diff that can be read on a phone and one that cannot:
 * unwrapped, every line of every hunk is a horizontal scroll, and the `+` and
 * `−` that say what happened are the part that scrolls off.
 *
 * Saying so is a hanging indent rather than a glyph in the margin. A glyph
 * would have to be placed at the point the line broke, and only the browser
 * knows where that is — putting one there means measuring the text ourselves
 * at three font sizes and every window width, to draw an arrow. The indent
 * needs none of that and answers the same question, which is the one a diff
 * must never get wrong: a continuation is inset past the marker column, so it
 * cannot be misread as a context line following an added one.
 *
 * Wrapping is the default and not the law — `⤢` turns it off for anybody who
 * wants the horizontal scroll back, on a wide screen or out of habit.
 */
export function DiffTab({
  sessionId,
  path,
  /** Pushed over a workspace, which draws the path and the way back itself. */
  bare,
}: {
  sessionId: string;
  path: string;
  bare?: boolean;
}) {
  const { data: files = [], isLoading, error } = useSessionDiff(sessionId, undefined, {
    query: { refetchInterval: 8_000 },
  });
  const { set } = useTabs();
  const open = useOpen();
  const { size, cycle } = useCodeSize();
  const [wrap, setWrap] = useState(true);

  const file = files.find((f) => f.path === path);

  /* Which of the changed files this is, so there is somewhere to go next.
     Only meaningful when it was opened from the list — which, below `xl`, is
     the only way to open one. */
  const at = files.findIndex((f) => f.path === path);
  const move = (by: number) => {
    const next = files[at + by];
    if (next) open.diff(next.path);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        {!bare && (
          <span className="min-w-0 flex-1 truncate font-mono text-meta text-slate" title={path}>
            {path}
          </span>
        )}
        {file && (
          <>
            <span className="shrink-0 font-mono text-micro text-sage">+{file.added}</span>
            <span className="shrink-0 font-mono text-micro text-brick">−{file.removed}</span>
          </>
        )}

        {bare && <span className="flex-1" />}

        {/* What pinch-to-zoom was doing before it was taken away.
            Better than pinch, which is why the trade is defensible: this
            re-wraps the patch to the new size instead of making a wide thing
            wider and pushing half of it off the screen. */}
        <Control
          label={`Code size — ${size}px`}
          onClick={cycle}
          className="font-narrow font-semibold"
        >
          A<span className="text-micro">a</span>
        </Control>

        <Control label={wrap ? "Stop wrapping long lines" : "Wrap long lines"} onClick={() => setWrap(!wrap)}>
          {wrap ? "⤢" : "⤡"}
        </Control>

        <Control label="Open the file itself" onClick={() => open.file(path)}>
          ▤
        </Control>

        {!bare && !set?.split && (
          <Control label="Open beside" onClick={() => open.diff(path, true)}>
            ⊞
          </Control>
        )}
      </header>

      <Patch
        patch={file?.patch}
        wrap={wrap}
        size={size}
        empty={
          isLoading
            ? "Reading the workspace…"
            : error
              ? error instanceof ApiError
                ? error.message
                : "Couldn't read the changes."
              : !file
                ? "Nothing has changed in that file — it may have been committed, or reverted, since this was opened."
                : undefined
        }
        onPrev={at > 0 ? () => move(-1) : undefined}
        onNext={at >= 0 && at < files.length - 1 ? () => move(1) : undefined}
      />

      {/* Where you are in the change, and the way through it.
          The swipe has a visible twin, always: a gesture nothing on screen
          admits to is a gesture only the person who built it knows about. */}
      {bare && files.length > 1 && at >= 0 && (
        <div className="flex shrink-0 items-center border-t border-line bg-panel pb-[env(safe-area-inset-bottom)]">
          <Step onClick={at > 0 ? () => move(-1) : undefined}>‹ Prev</Step>
          <span className="flex-1 text-center font-mono text-micro text-mute">
            {at + 1} of {files.length}
          </span>
          <Step onClick={at < files.length - 1 ? () => move(1) : undefined}>Next ›</Step>
        </div>
      )}
    </div>
  );
}

/**
 * The patch itself.
 *
 * Split into a component of its own so the swipe listener has an element to
 * hang off that is exactly the region somebody would swipe across.
 */
function Patch({
  patch,
  wrap,
  size,
  empty,
  onPrev,
  onNext,
}: {
  patch?: string;
  wrap: boolean;
  size: number;
  empty?: string;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useSwipe(box, onPrev, onNext);

  if (empty) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <p className="max-w-[44ch] text-center text-ui text-mute">{empty}</p>
      </div>
    );
  }

  return (
    <div ref={box} className="min-h-0 flex-1 overflow-auto">
      <div
        className="px-3 py-2 font-mono leading-[1.6]"
        // The one place a size is not from the scale, because it is a control
        // rather than a decision: the reader picked it, out of the three in
        // `CYCLE`, and the scale has nothing to say about that.
        style={{ fontSize: `${size}px` }}
      >
        {(patch ?? "").split("\n").map((line, i) => (
          <div
            key={i}
            className={`${colour(line)} ${
              wrap
                ? // Wrapped lines hang under the first character *after* the
                  // marker column, so the `+`/`−` gutter stays one column wide
                  // all the way down and a continuation cannot be read as a
                  // line of its own.
                  "pl-[2ch] -indent-[2ch] break-words whitespace-pre-wrap"
                : "whitespace-pre"
            }`}
          >
            {line || " "}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Left and right, across the changed files.
 *
 * Touch rather than pointer events: a pointer listener on a scroller competes
 * with the scroll itself, and the browser has already decided this gesture is
 * horizontal by the time `touchend` arrives.
 *
 * Only a clearly horizontal, clearly deliberate movement counts — 60px across
 * and less than half that down. A diff is a tall thing people scroll, and a
 * thumb that drifts sideways on the way down must not turn the page.
 */
function useSwipe(
  on: React.RefObject<HTMLElement | null>,
  onPrev?: () => void,
  onNext?: () => void,
) {
  useEffect(() => {
    const el = on.current;
    if (!el) return;

    let from: { x: number; y: number } | null = null;

    const begin = (e: TouchEvent) => {
      // One finger. Two is a scroll or a gesture and neither means "next".
      from = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    };

    const end = (e: TouchEvent) => {
      const start = from;
      from = null;
      if (!start || e.changedTouches.length !== 1) return;
      const dx = e.changedTouches[0].clientX - start.x;
      const dy = e.changedTouches[0].clientY - start.y;
      if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) / 2) return;
      // Left drags the next file in from the right, which is the direction
      // every paged interface on the device already means by it.
      if (dx < 0) onNext?.();
      else onPrev?.();
    };

    el.addEventListener("touchstart", begin, { passive: true });
    el.addEventListener("touchend", end, { passive: true });
    return () => {
      el.removeEventListener("touchstart", begin);
      el.removeEventListener("touchend", end);
    };
  }, [on, onPrev, onNext]);
}

function Control({
  label,
  onClick,
  children,
  className = "",
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid h-8 min-w-8 shrink-0 place-items-center rounded-sm text-meta text-mute transition-colors hover:bg-raise hover:text-bone ${className}`}
    >
      {children}
    </button>
  );
}

function Step({ onClick, children }: { onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className="min-h-[44px] px-4 text-ui text-dim transition-colors enabled:hover:text-bone disabled:text-mute/50"
    >
      {children}
    </button>
  );
}

/** Added, removed, and the scaffolding around them. */
function colour(line: string) {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-mute";
  if (line.startsWith("+")) return "bg-sage/[0.07] text-sage";
  if (line.startsWith("-")) return "bg-brick/[0.07] text-brick";
  if (line.startsWith("@@")) return "text-slate";
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "text-mute";
  return "text-dim";
}
