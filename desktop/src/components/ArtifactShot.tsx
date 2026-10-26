/**
 * A thumbnail of an artifact: a picture of it, not a running copy of it.
 *
 * **This used to be an iframe, and that was the whole problem.** Every tile in
 * the library, every row of the list and every card in the transcript mounted
 * the published page at 1180px and scaled it down — so a library of six was
 * six page loads of six separate origins, six copies of the injected picker
 * runtime, and six documents whose scripts and timers went on running behind a
 * grid nobody was interacting with. The white box people saw was this
 * component's own background, waiting.
 *
 * What replaces it is an `<img>` against a poster rendered once per version
 * (`posters.tsx`), cacheable forever because a version's bytes cannot change.
 * The live page survives in one ordinary place — `ArtifactTab`, where somebody
 * is actually reading it — and in one unusual one, below.
 *
 * **The iframe is a fallback, and only that.** It is *not* used because a
 * poster has not arrived yet; that is the placeholder's job, and rendering
 * live "just until the picture comes" would quietly keep the whole cost for
 * the case that hurts most — a fresh library with every tile missing at once.
 * It is used when `useExpectPoster` reports that capture does not work on this
 * machine, which only the running application can discover: the Windows path
 * compiles and has never been executed. Degrading to what shipped before beats
 * a library of grey plates.
 *
 * Even then it is cheaper than what shipped: `?ft-shot` tells the server not to
 * inject the picker, so the fallback carries neither the 21 KB runtime nor the
 * layout timer that was the worst of the original cost.
 */
import { useEffect, useRef, useState } from "react";
import { Shapes } from "lucide-react";
import { apiBase } from "~/client/http";
import { useExpectPoster } from "~/artifacts/posters";
import type { Artifact } from "~/api/generated/model";

/** The width the page is laid out at before being scaled down. */
const PAGE = 1180;

export function ArtifactShot({
  artifact,
  ratio = 16 / 10,
  className = "",
  framed = true,
}: {
  artifact: Artifact;
  /** Width over height. The crop keeps this shape at every size. */
  ratio?: number;
  className?: string;
  /** Its own border and corners. Off when something around it draws them. */
  framed?: boolean;
}) {
  /* A poster the server says exists can still fail to load — an old row whose
     bytes went with a deleted version, or a request that lost the network. The
     placeholder is the same either way, so this collapses into one flag. */
  const [broken, setBroken] = useState(false);
  /* Only consulted when there is no picture: a poster that exists is always
     preferred to rendering the page over again. */
  const expected = useExpectPoster();
  const showing = artifact.hasPoster && !broken;
  const live = !showing && !expected;

  return (
    <span
      style={{ aspectRatio: String(ratio) }}
      className={`relative block w-full overflow-hidden ${
        /* Not `bg-white`. A white rectangle is what a page looks like before it
           has painted, so it read as a broken artifact rather than as one that
           has not been photographed yet.
           Not `bg-panel` either, which was the first attempt at that: the tile
           around this is already `bg-panel`, so the two met with nothing
           between them and the whole card read as one blank slab.
           `--color-line` is the lightest grey the palette has, and a plate is
           the one place it is used as a fill rather than an edge.
           A live page keeps the white — that is the page's own paper. */
        showing || live ? "bg-white" : "bg-line"
      } ${framed ? "rounded-md border border-line" : ""} ${className}`}
    >
      {showing ? (
        <img
          src={`${apiBase()}${artifact.posterUrl}`}
          alt=""
          /* Decorative: every caller draws the title beside this, so announcing
             it again is one more thing to listen past. */
          aria-hidden
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
          /* `top` rather than `center`: a page is read from the top, and a tall
             document cropped to 16:10 from the middle shows its middle, which
             is the one part nobody recognises it by. */
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
      ) : live ? (
        <LivePage url={artifact.url} ratio={ratio} />
      ) : (
        /* Sized off the tile rather than fixed, because this same component is
           84px wide in the list, ~224px in the grid and up to 416px in the
           transcript — one pixel size is lost at the top of that range and
           crowded at the bottom. The clamps stop it going silly either way. */
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid aspect-square w-[16%] max-w-9 min-w-5 place-items-center">
            <Shapes className="h-full w-full text-dim" strokeWidth={1.5} />
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * The artifact itself, scaled — the old thumbnail, kept for machines that
 * cannot photograph one.
 *
 * Its own component so none of this runs on the ordinary path: the measuring,
 * the observer and the frame all arrive with it and leave with it.
 *
 * **The scale is measured, never assumed.** The grid's columns are
 * `minmax(14rem, 1fr)`, so a column wider than its minimum drew the page at an
 * assumed size and left white beside it — and a thumbnail that is mostly blank
 * reads as a broken artifact rather than as a wide column.
 *
 * **The pane over the frame is load-bearing.** `pointer-events: none` stops
 * clicks but does not reliably stop the wheel in WKWebView: the event reaches
 * the inner document and scrolls *that*, so scrolling a grid of thumbnails
 * scrolled whichever one the pointer was over. A sibling above it in z-order
 * catches the wheel first, and clicks still land on whatever this is nested in.
 */
function LivePage({ url, ratio }: { url: string; ratio: number }) {
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
    <span ref={box} className="absolute inset-0 block">
      {/* Nothing until the width is known: mounting at scale 0 would load the
          page once and lay it out again a frame later. */}
      {width > 0 && (
        <iframe
          src={`${url}?ft-shot`}
          title=""
          tabIndex={-1}
          aria-hidden
          scrolling="no"
          loading="lazy"
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
