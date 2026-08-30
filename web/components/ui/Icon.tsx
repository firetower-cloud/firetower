import type { LucideIcon } from "lucide-react";

/**
 * Every icon in the app, at one size and one stroke weight.
 *
 * Ten files used to draw their own `<path>` at three different stroke widths
 * and four sizes, which is why nothing lined up: an icon a half-pixel heavier
 * than the one beside it reads as a mistake long before anyone can say what the
 * mistake is. Call sites choose *which* icon, never how heavy it is.
 */
export function Icon({
  of: Glyph,
  size = 16,
  className,
}: {
  of: LucideIcon;
  size?: 12 | 14 | 16 | 20;
  className?: string;
}) {
  return <Glyph size={size} strokeWidth={1.5} className={className} aria-hidden />;
}
