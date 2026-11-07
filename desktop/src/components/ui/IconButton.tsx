import type { LucideIcon } from "lucide-react";
import { Icon } from "./Icon";

/**
 * An action with no room for a word.
 *
 * A 28px rounded square that shows its ground only on hover — the artifact's
 * `.gbtn`. It is the shape every header glyph, every close and every quiet
 * row action takes, and before this existed each of them was hand-rolled as
 * `grid h-7 w-7 place-items-center rounded-md …` at four different sizes.
 *
 * `round` is the one exception the design draws: send and stop, which are
 * filled discs rather than glyphs on the sheet.
 */
type Variant = "ghost" | "primary" | "outline";

const VARIANT: Record<Variant, string> = {
  ghost: "",
  primary: "bg-bone text-ground hover:opacity-90 disabled:bg-overlay disabled:text-mute",
  outline: "border border-line",
};

const SIZE = {
  /** The design's one icon-button size. */
  sm: "h-7 w-7 max-md:h-11 max-md:w-11",
  /** For the round ones, which are a target rather than a glyph. */
  md: "h-9 w-9 max-md:h-11 max-md:w-11",
} as const;

export function IconButton({
  of,
  onClick,
  label,
  hint,
  variant = "ghost",
  size = "sm",
  round,
  disabled,
  glyph,
  className = "",
}: {
  /** The icon. Omit it and pass `glyph` for the one control that is a shape. */
  of?: LucideIcon;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Named for a screen reader and, as a title, for everyone else. */
  label: string;
  /**
   * When the tooltip differs from the name.
   *
   * Most of the time they are the same sentence and `label` is both. A few
   * controls want a name that does not change — "Reveal" to a screen reader —
   * beside a tooltip that says what pressing it costs, or a keystroke. Those
   * were hand-rolled rather than use this, which is most of why nine screens
   * wrote `.gbtn` themselves.
   */
  hint?: string;
  variant?: Variant;
  size?: keyof typeof SIZE;
  /** Send and stop. Everything else is the square. */
  round?: boolean;
  disabled?: boolean;
  glyph?: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={hint ?? label}
      className={`gbtn ${round ? "rounded-full" : ""} disabled:cursor-not-allowed ${SIZE[size]} ${VARIANT[variant]} ${className}`}
    >
      {of ? <Icon of={of} size={16} /> : glyph}
    </button>
  );
}
