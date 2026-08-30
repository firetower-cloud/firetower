"use client";

/**
 * Text in, and one of a list.
 *
 * Both were written inline in eight shapes across the app, at four heights, so
 * a search box and the select beside it never sat on the same line.
 */
const BASE =
  "h-8 min-w-0 rounded-md border border-line bg-ground px-2.5 text-ui text-bone transition-colors placeholder:text-mute focus:border-dim focus:outline-none";

export function Input({
  value,
  onChange,
  placeholder,
  mono,
  className = "",
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className">) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      className={`${BASE} ${mono ? "font-mono text-meta" : ""} ${className}`}
      {...rest}
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  className = "",
}: {
  value: T;
  onChange: (value: T) => void;
  options: [T, string][];
  className?: string;
}) {
  return (
    <select
      // Chrome restores form controls across a reload and fires change as it
      // does, which quietly narrows a page to a scope nobody picked this time.
      autoComplete="off"
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={`${BASE} cursor-pointer pr-7 text-dim ${className}`}
    >
      {options.map(([id, label]) => (
        <option key={id} value={id}>
          {label}
        </option>
      ))}
    </select>
  );
}
