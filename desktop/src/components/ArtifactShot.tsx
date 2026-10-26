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
 * (`posters.ts`), which is cacheable forever because a version's bytes cannot
 * change. The live page survives in exactly one place now: `ArtifactTab`,
 * where somebody is actually reading it.
 *
 * **There is deliberately no iframe fallback.** "Render it live if there is no
 * poster yet" sounds safe and quietly keeps the entire cost for the one case
 * that hurts most — a fresh library where every tile is missing at once. A
 * placeholder is honest and costs nothing; the picture arrives a moment later.
 */
import { useState } from "react";
import { Shapes } from "lucide-react";
import { apiBase } from "~/client/http";
import type { Artifact } from "~/api/generated/model";

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
  const showing = artifact.hasPoster && !broken;

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
           the one place it is used as a fill rather than an edge: against
           `panel` it is unmistakably an area waiting for a picture, which
           neither `panel` nor `raise` managed. */
        showing ? "bg-white" : "bg-line"
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
      ) : (
        /* Sized off the tile rather than fixed, because this same component is
           84px wide in the list, ~224px in the grid and up to 416px in the
           transcript — one pixel size is lost at the top of that range and
           crowded at the bottom. The clamps stop it going silly either way.
           `text-dim` on this plate, not `text-mute`: at a glyph this large the
           quieter one still reads as a smudge rather than a mark. */
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid aspect-square w-[16%] max-w-9 min-w-5 place-items-center">
            <Shapes className="h-full w-full text-dim" strokeWidth={1.5} />
          </span>
        </span>
      )}
    </span>
  );
}
