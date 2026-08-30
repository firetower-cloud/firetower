"use client";

/**
 * Two or three mutually exclusive things, one of them on.
 *
 * The active segment is bone on ground: the brightest thing in the group, so
 * the answer to "which one is selected" survives a glance from across a desk.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: [T, string][];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-raise p-0.5 shadow-raise">
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`h-7 rounded-sm px-2.5 text-ui transition-colors duration-150 ${
            id === value
              ? "bg-bone font-medium text-ground"
              : "text-dim hover:text-bone"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
