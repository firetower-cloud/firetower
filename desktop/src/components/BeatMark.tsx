import { Check, CircleSlash2, TriangleAlert } from "lucide-react";
import { BEAT, BEAT_TONE, type Beat } from "~/api/view";
import type { SessionStatus } from "~/api/generated/model";

/**
 * One mark per state, in the colour that state already has.
 *
 * **No new hue.** `BEAT_TONE` is the one table that says what a status means
 * — working: slate, blocked: ember, done: sage, broken: brick, over: mute —
 * and this is the only place that draws it.
 *
 * **Never hue alone.** `broken` is a warning glyph and not a second circle: a
 * brick dot beside an ember dot is one shape told from another by colour,
 * which `STYLE.md` forbids and a dichromat cannot do. A tick and a triangle
 * read apart with the colour off.
 *
 * **Here rather than in two files.** It lived inside `OverviewTab` as
 * `TeamMark`, and the home's chips drew a plain `.dot` for every beat —
 * so a failed workspace was a brick circle on one screen and a triangle on
 * the other. Two surfaces drawing one alphabet two ways is the thing this
 * project keeps finding.
 */
export function BeatMark({ beat, says }: { beat: Beat; says?: string }) {
  const tone = BEAT_TONE[beat];
  if (beat === "blocked") return <span className="dot" title={says ?? "asked you a question"} />;
  if (beat === "working") {
    return (
      <span className={`typing ${tone}`} title={says ?? "working"}>
        <i />
        <i />
        <i />
      </span>
    );
  }
  /* Before the tick below, which is what this used to fall through to: a
     workspace whose machine had restarted drew "handed back" in sage. */
  if (beat === "stopped") {
    return (
      <CircleSlash2
        className={`h-3.5 w-3.5 ${tone}`}
        strokeWidth={2}
        aria-label={says ?? "machine restarted"}
      />
    );
  }
  if (beat === "broken") {
    return <TriangleAlert className={`h-3.5 w-3.5 ${tone}`} strokeWidth={2} aria-label={says ?? "failed"} />;
  }
  return (
    <Check
      className={`h-3.5 w-3.5 ${tone}`}
      strokeWidth={2}
      aria-label={says ?? (beat === "over" ? "ended" : "handed back")}
    />
  );
}

/** The same mark, asked of a session rather than of a beat. */
export function StatusMark({ status }: { status: SessionStatus }) {
  return <BeatMark beat={BEAT[status]} says={LABEL[status]} />;
}

/** What each status is called out loud, where it differs from its beat's. */
const LABEL: Partial<Record<SessionStatus, string>> = {
  NeedsYou: "asked you a question",
  Stranded: "machine restarted",
  HandedBack: "handed back",
  Ready: "handed back",
  Ended: "ended",
  Failed: "failed",
};
