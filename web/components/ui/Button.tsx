import type { LucideIcon } from "lucide-react";
import { Icon } from "./Icon";

/**
 * The four things a button can be.
 *
 * `primary` is bone on ground — white is the accent in this system, not orange.
 * Ember is a signal that something is waiting on you, and a button that is
 * always there is never waiting on anything.
 */
type Variant = "primary" | "default" | "quiet" | "danger";

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-bone text-ground font-medium hover:bg-white disabled:bg-line disabled:text-mute",
  default:
    "bg-raise text-text border border-line shadow-raise hover:bg-overlay hover:text-bone disabled:text-mute disabled:hover:bg-raise",
  quiet: "text-dim hover:text-bone disabled:text-mute",
  danger:
    "text-brick border border-brick-deep hover:bg-brick-tint disabled:text-mute disabled:border-line",
};

const SIZE = {
  sm: "h-7 gap-1.5 px-2.5 text-meta rounded-sm",
  md: "h-8 gap-2 px-3 text-ui rounded-md",
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
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed ${SIZE[size]} ${VARIANT[variant]} ${className}`}
    >
      {icon && <Icon of={icon} size={size === "sm" ? 12 : 14} className="opacity-80" />}
      {children}
      {trailing && <Icon of={trailing} size={size === "sm" ? 12 : 14} className="opacity-60" />}
    </button>
  );
}
