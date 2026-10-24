/**
 * A thumbnail of an artifact: the artifact itself, scaled.
 *
 * No screenshot service and no headless browser on the control plane — the
 * client already has something that can render the page, so a transform is the
 * whole job. That is the one thing this buys, and it charges an iframe's
 * event behaviour in return, which is what the two awkward parts below are.
 *
 * **The scale is measured, never assumed.** It used to be computed from the
 * tile width the grid was *expected* to have, while the columns are
 * `minmax(14rem, 1fr)` — so any column wider than that drew the page at its
 * assumed size and left white beside it. A thumbnail that is mostly blank
 * reads as a broken artifact rather than a wide column.
 *
 * **The pane over the frame is load-bearing.** `pointer-events: none` stops
 * clicks but does not reliably stop the wheel in WKWebView: the event reaches
 * the inner document and scrolls *that*, so scrolling a grid of thumbnails
 * scrolled whichever thumbnail the pointer was over. A sibling above it in
 * z-order catches the wheel first, and clicks still land on whatever this is
 * nested inside.
 */
import { useEffect, useRef, useState } from "react";
import type { Artifact } from "~/api/generated/model";

/** The width the page is laid out at before being scaled down. */
const PAGE = 1180;

export function ArtifactShot({
  artifact,
  ratio = 16 / 10,
  className = "",
}: {
  artifact: Artifact;
  /** Width over height. The crop keeps this shape at every size. */
  ratio?: number;
  className?: string;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const watch = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  return (
    <span
      ref={box}
      style={{ aspectRatio: String(ratio) }}
      className={`relative block w-full overflow-hidden rounded-md border border-line bg-white transition-colors ${className}`}
    >
      {/* Nothing until the width is known: mounting at scale 0 would load the
          page once and lay it out again a frame later. */}
      {width > 0 && (
        <iframe
          src={artifact.url}
          title=""
          tabIndex={-1}
          aria-hidden
          scrolling="no"
          style={{
            width: PAGE,
            height: PAGE / ratio,
            transform: `scale(${width / PAGE})`,
            transformOrigin: "0 0",
          }}
          className="pointer-events-none absolute inset-0 border-0"
        />
      )}
      <span className="absolute inset-0 z-10" aria-hidden />
    </span>
  );
}
