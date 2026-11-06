"use client";

/**
 * Two or three mutually exclusive things, one of them on.
 *
 * A recessed track with a raised knob — the artifact's `.seg`. The selected
 * segment lifts rather than inverting: at this size a filled bone block reads
 * as the page's primary action, which a filter is not.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className = "",
}: {
  options: [T, string][];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={`seg shrink-0 ${className}`}>
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-pressed={id === value}
          onClick={() => onChange(id)}
          className="max-md:min-h-[44px]"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
