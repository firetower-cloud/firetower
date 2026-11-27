/**
 * One line of a ⋯ menu.
 *
 * **Extracted the second time it was wanted, not the third.** `GitHosts` wrote
 * this first and the plugin library needed exactly the same thing — the same
 * padding, the same hover, the same quiet danger tone that goes brick only on
 * hover rather than shouting from the moment the menu opens. A second copy is
 * how two menus start drifting apart, and the one that ships twice is the one
 * nobody notices has drifted.
 */
export function MenuItem({
  children,
  onClick,
  tone,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  /** Destructive. Quiet until the pointer is on it. */
  tone?: "danger";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left text-ui hover:bg-raise/60 disabled:opacity-40 ${
        tone === "danger" ? "text-dim hover:text-brick" : "text-text hover:text-bone"
      }`}
    >
      {children}
    </button>
  );
}
