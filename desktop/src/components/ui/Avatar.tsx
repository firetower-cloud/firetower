/**
 * A person or an agent, as a disc.
 *
 * **Derived from the name, never stored**, so the same person is the same
 * mark on every screen without anything having to remember it — and
 * **neutral**, because the design's one accent is ember and ember means an
 * agent is waiting on you. Five tinted discs on one list made six colours on
 * a screen that is allowed one.
 *
 * **Initials, not the first two letters.** `fleet.ts`'s `markOf` takes two
 * letters from a one-word organisation on purpose — two Firetowers whose names
 * share a first letter must stay apart, and there are only so many of them. A
 * person is not that: the list says the name in full on the same row, so one
 * letter is enough and `Ke` beside `kevin` is just noise.
 */

/** `ada lovelace` → `AL`; `kevin` → `K`. */
export function monogram(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return "?";
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0][0]).toUpperCase();
}

export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  return (
    <span
      title={name}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.44)) }}
      className="face"
    >
      {monogram(name)}
    </span>
  );
}
