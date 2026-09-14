/**
 * A state, said in one word.
 *
 * Tint behind, matching border, colour on top — never a flat block of colour,
 * which at this size reads as a warning whatever it says.
 */
type Tone = "sage" | "brick" | "slate" | "ember" | "neutral";

const TONE: Record<Tone, string> = {
  sage: "bg-sage-tint border-sage-deep text-sage",
  brick: "bg-brick-tint border-brick-deep text-brick",
  slate: "bg-slate-tint border-slate-deep text-slate",
  ember: "bg-ember-tint border-ember-deep text-ember",
  neutral: "bg-raise border-line text-dim",
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
      className={`inline-flex shrink-0 items-center rounded-sm border px-1.5 py-0.5 text-micro font-medium ${
        mono ? "font-mono" : ""
      } ${TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
