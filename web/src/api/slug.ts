/**
 * A prompt, as something git will accept for a branch.
 *
 * This has to agree with `ft_core::slugify`. The control plane derives the
 * branch itself when the client sends none, so a field showing a different
 * answer from the one that would actually happen is worse than a field showing
 * nothing at all.
 *
 * Its own module rather than a function inside the composer: it is the one part
 * of that screen with rules worth testing, and a test that has to mount a form
 * to check a string is a test nobody will keep.
 */
export function slugify(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word && !SKIP.has(word))
    .slice(0, 4)
    .join("-");
}

/** Words that carry no meaning in a branch name. The same list Rust uses. */
const SKIP = new Set(["the", "a", "an", "for", "to", "in", "and", "of", "on", "with"]);
