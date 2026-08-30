/**
 * Who it belongs to, in the space of a bullet point.
 *
 * The tint is derived from the name rather than stored, so the same person is
 * the same colour on every screen without anything having to remember it.
 */
const TINTS = [
  "bg-sage-tint text-sage",
  "bg-slate-tint text-slate",
  "bg-ember-tint text-ember-soft",
  "bg-brick-tint text-brick",
  "bg-overlay text-dim",
];

export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;

  return (
    <span
      title={name}
      style={{ width: size, height: size }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full text-micro font-semibold uppercase ${
        TINTS[hash % TINTS.length]
      }`}
    >
      {name.slice(0, 1)}
    </span>
  );
}
