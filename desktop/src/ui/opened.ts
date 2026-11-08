/**
 * Which one of a list a path is asking for.
 *
 * **A link has to name the thing, and the screen has to read the name.** Both
 * halves were missing in places: the rail panel's rows navigated to the
 * destination rather than the item — a skill row went to Skills, an artifact
 * row to the library — and `Routes` matched `/artifacts` with `startsWith`,
 * so `/artifacts/a_1` rendered the list and dropped the id on the floor. From
 * the outside both read the same way: you click a named thing and get the
 * page it lives on.
 *
 * The panes keep their own "which is open" state, because most of the time it
 * is opened by clicking a row and no address is involved. This is how an
 * address gets a word in: seed from the path, and follow it when it changes,
 * which is the case that matters — clicking a second rail row while the first
 * one is already open.
 */
import { useState } from "react";

/** The id after a pane's own segment, or null. `/configuration/skills/sk_1`. */
export function askedFor(path: string, depth: number): string | null {
  const bits = path.split("/").filter(Boolean);
  const asked = bits[depth];
  return asked ? decodeURIComponent(asked) : null;
}

/**
 * `[open, setOpen]`, seeded from the address and following it afterwards.
 *
 * Derived during render rather than in an effect: an effect would paint the
 * list for one frame and then the item, which is the flash this exists to
 * avoid.
 */
export function useOpened(want: string | null): [string | null, (id: string | null) => void] {
  const [open, setOpen] = useState<string | null>(want);
  const [saw, setSaw] = useState<string | null>(want);
  if (want !== saw) {
    setSaw(want);
    setOpen(want);
  }
  return [open, setOpen];
}
