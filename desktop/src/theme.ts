/**
 * Light, dark, or whatever the Mac is set to.
 *
 * The token sheet (`globals.css`) keeps every dark value as its default and
 * puts light behind `[data-theme="light"]`, with **no `prefers-color-scheme`
 * media query in it**. That is deliberate: the sheet is shared with the web
 * client and compiled into the phone's tokens, and a media default there would
 * move both of them the moment somebody's machine was in light mode. So
 * following the system is this file's job — it resolves the preference and
 * writes the attribute, and the two other clients stay exactly where they are
 * until they do the same.
 *
 * Applied at import, before the first render, because a frame of the wrong
 * theme is the thing everybody notices and nobody can un-see.
 *
 * The island does not import this. It has its own entry point, its own window
 * and a palette that is deliberately not the app's — the pill is the black the
 * notch is made of, in any appearance.
 */
import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";

/** What the attribute can say. `system` is resolved before it is written. */
export type Resolved = "light" | "dark";

const KEY = "firetower.theme";

const THEMES: Theme[] = ["system", "light", "dark"];

/** The stored choice, defaulting to following the system. */
export function theme(): Theme {
  try {
    const held = window.localStorage.getItem(KEY);
    return THEMES.includes(held as Theme) ? (held as Theme) : "system";
  } catch {
    /* a private window; the choice just does not survive a reload */
    return "system";
  }
}

const watchers = new Set<() => void>();

export function onTheme(fn: () => void): () => void {
  watchers.add(fn);
  return () => void watchers.delete(fn);
}

export function setTheme(next: Theme) {
  try {
    window.localStorage.setItem(KEY, next);
  } catch {
    /* as above: it applies now, it just will not survive a restart */
  }
  paint();
  watchers.forEach((w) => w());
}

/**
 * Which of the two a choice means right now.
 *
 * Exported for the tests and for the one label that has to say what *system*
 * currently resolves to — "System" alone cannot be checked against the screen.
 */
export function resolve(choice: Theme, prefersLight: boolean): Resolved {
  if (choice === "light" || choice === "dark") return choice;
  return prefersLight ? "light" : "dark";
}

/** Does the machine ask for light? False anywhere the query is unavailable. */
function prefersLight(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: light)").matches;
}

/**
 * Write the attribute.
 *
 * Dark is written out rather than left off. An absent attribute means dark
 * too — the sheet's defaults are the dark branch — but a stylesheet that can
 * be read off the DOM is worth the four characters, and `data-theme="dark"`
 * is what the style page and anybody debugging expects to find.
 */
function paint() {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolve(theme(), prefersLight());
}

/* Applied at import, and kept in step with the machine for as long as the
   window is open — a Mac on automatic appearance flips at dusk, and an app
   that only reads the preference at launch is the one still in light at
   midnight. The listener costs nothing while the choice is not `system`:
   `paint` reads the choice again and ignores what the system said. */
if (typeof window !== "undefined") {
  paint();
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener("change", () => {
    paint();
    watchers.forEach((w) => w());
  });
}

/** The choice, and a way to change it, for the control in the profile menu. */
export function useTheme(): [Theme, Resolved, (next: Theme) => void] {
  const [, tick] = useState(0);
  useEffect(() => onTheme(() => tick((n) => n + 1)), []);
  return [theme(), resolve(theme(), prefersLight()), setTheme];
}
