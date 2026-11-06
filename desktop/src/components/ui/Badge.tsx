/**
 * A count, a label, a level.
 *
 * **Neutral by default, because almost all of them are facts rather than
 * states.** "administrator", "can delegate", "built in" and a label off a
 * tracker are all describing the row, not warning about it, and a tinted
 * block at this size reads as a warning whatever it says. The artifact draws
 * every one of them as the same quiet pill (`.ttag`).
 *
 * `tone` is still here for the few that do mean something — a refusal, a
 * limit — and it colours **the word**, never the ground behind it.
 */
type Tone = "sage" | "brick" | "slate" | "ember" | "amber" | "neutral";

const TONE: Record<Tone, string> = {
  sage: "text-sage",
  brick: "text-brick",
  slate: "text-slate",
  ember: "text-ember-ink",
  amber: "text-amber",
  neutral: "",
};

export function Badge({
  children,
  tone = "neutral",
  mono,
  style,
  className = "",
}: {
  children: React.ReactNode;
  tone?: Tone;
  mono?: boolean;
  style?: React.CSSProperties;
  className?: string;
}) {
  return (
    <span
      style={style}
      className={`ttag ${mono ? "font-mono" : ""} ${TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
