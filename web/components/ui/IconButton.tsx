import type { LucideIcon } from "lucide-react";
import { Icon } from "./Icon";

/**
 * A control that is only a glyph.
 *
 * Round, because the things that take this shape — send, stop, attach — are
 * single actions rather than named ones, and a pill with nothing written in it
 * reads as a button someone forgot to label.
 */
type Variant = "primary" | "ghost" | "outline";

const VARIANT: Record<Variant, string> = {
  primary: "bg-bone text-ground hover:bg-white disabled:bg-raise disabled:text-mute",
  ghost: "text-mute hover:bg-raise hover:text-bone disabled:text-mute disabled:hover:bg-transparent",
  outline: "border border-line text-dim hover:border-mute/60 hover:text-bone",
};

const SIZE = { sm: "h-8 w-8", md: "h-10 w-10" } as const;

export function IconButton({
  of,
  onClick,
  label,
  variant = "ghost",
  size = "md",
  disabled,
  glyph,
  className = "",
}: {
  /** The icon. Omit it and pass `glyph` for the one control that is a shape. */
  of?: LucideIcon;
  onClick?: () => void;
  /** Named for a screen reader and, as a title, for everyone else. */
  label: string;
  variant?: Variant;
  size?: keyof typeof SIZE;
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
      title={label}
      className={`grid shrink-0 place-items-center rounded-full transition-colors duration-150 disabled:cursor-not-allowed ${SIZE[size]} ${VARIANT[variant]} ${className}`}
    >
      {of ? <Icon of={of} size={16} /> : glyph}
    </button>
  );
}
