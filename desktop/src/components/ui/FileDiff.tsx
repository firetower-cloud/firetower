"use client";

/**
 * A unified diff, as the Inspector draws one.
 *
 * Lifted rather than written: `config/ImportProfiles.tsx` had this as a local
 * function over `.prose-diff`, and the channel switch wanted a third copy. Add
 * and delete take the tint pairs, a hunk header is slate, and **every line
 * scrolls rather than wrapping** — which is the house rule for code and the
 * reason a long image reference does not break mid-identifier.
 *
 * A `−` for a deletion rather than a hyphen, so the sign column reads at a
 * glance and is never mistaken for part of the line.
 */
export function FileDiff({ unified }: { unified: string }) {
  const lines = unified
    .split("\n")
    /* A diff ends with a newline, which would otherwise draw an empty row. */
    .filter((l, i, all) => !(i === all.length - 1 && l === ""))
    .map((text) => {
      const kind = text.startsWith("@@")
        ? "hunk"
        : text.startsWith("+++") || text.startsWith("---")
          ? "meta"
          : text.startsWith("+")
            ? "add"
            : text.startsWith("-")
              ? "del"
              : "ctx";
      return { kind, text: kind === "add" || kind === "del" ? text.slice(1) : text };
    });
  return (
    <div className="prose-diff">
      {lines.map(({ kind, text }, i) => (
        <div
          key={i}
          className={`ln ${
            kind === "add"
              ? "bg-sage-tint text-sage"
              : kind === "del"
                ? "bg-brick-tint text-brick"
                : kind === "hunk" || kind === "meta"
                  ? "text-slate"
                  : "text-dim"
          }`}
        >
          <span className="w-3 shrink-0 select-none opacity-60" aria-hidden>
            {kind === "add" ? "+" : kind === "del" ? "−" : " "}
          </span>
          <span className="flex-1 whitespace-pre">{text}</span>
        </div>
      ))}
    </div>
  );
}
