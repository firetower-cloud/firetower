import type { LucideIcon } from "lucide-react";
import { Icon } from "./Icon";

/**
 * The four things a button can be, as the design draws them.
 *
 * A **pill**, 33px, with one filled variant per screen. `primary` is bone on
 * the sheet — white is the accent in this system, not orange. Ember is a
 * signal that something is waiting on you, and a button that is always there
 * is never waiting on anything.
 *
 * ## Why this file matters more than any screen
 *
 * Twenty-seven screens render this. Restyling a screen does nothing while the
 * components it is composed from are untouched — Skills was rebuilt to its
 * drawing and still drew a grey outline where the page's one action should
 * have been a black pill, because that control belonged to `CreateMenu` and
 * not to Skills. The shapes live in `styles.css` under the artifact's own
 * names (`.btn .primary .plain .quiet .harm`), so the drawing and the build
 * can be read side by side.
 */
type Variant = "primary" | "default" | "quiet" | "danger";

/** The artifact's class for each. `default` is `.plain` — a raised pill. */
const VARIANT: Record<Variant, string> = {
  primary: "primary",
  default: "plain",
  quiet: "quiet",
  danger: "harm",
};

/**
 * One height, and a floor under it on a touch screen.
 *
 * The design has a single button height — 33px — and `sm` is not a second
 * variant but the same pill in a toolbar, where a row of them beside a 28px
 * icon button would otherwise set the row's height on its own.
 *
 * `max-md:min-h-[44px]` costs nothing at a desk and makes every button in the
 * app a real target below `md` without a third size to remember.
 */
const SIZE = {
  sm: "h-7 gap-1.5 px-3 text-meta max-md:min-h-[44px]",
  md: "max-md:min-h-[44px]",
} as const;

export function Button({
  children,
  onClick,
  variant = "default",
  size = "md",
  icon,
  trailing,
  disabled,
  title,
  type = "button",
  className = "",
}: {
  children?: React.ReactNode;
  onClick?: () => void;
  variant?: Variant;
  size?: keyof typeof SIZE;
  icon?: LucideIcon;
  trailing?: LucideIcon;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`btn ${VARIANT[variant]} justify-center disabled:cursor-not-allowed ${SIZE[size]} ${className}`}
    >
      {icon && <Icon of={icon} size={size === "sm" ? 12 : 14} />}
      {children}
      {trailing && <Icon of={trailing} size={size === "sm" ? 12 : 14} className="opacity-70" />}
    </button>
  );
}
