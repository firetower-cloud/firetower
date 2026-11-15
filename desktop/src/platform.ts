/**
 * Which desktop this is, for the few things that differ.
 *
 * The app is one codebase on three platforms; what differs is the modifier
 * key's name, whether the window draws its own buttons, and whether the
 * sidebar is translucent. Everything reads those from here, so "Windows"
 * is a value and not a search through the tree.
 */
export type Platform = "macos" | "windows" | "linux";

/**
 * Pretend to be another platform, while developing.
 *
 * `?platform=windows` in the address bar, and only in a dev build. The usual
 * way to do this — override the user agent — does not work here, because
 * detection reads `userAgentData`, which a browser flag cannot forge. And the
 * things that vary by platform are not obscure: the title bar, the modifier
 * in every shortcut, the sidebar's translucency, and the instructions in the
 * microphone dialog, which name a different settings application on each one.
 * None of that was inspectable from a Mac, so none of it was looked at.
 */
function asked(): Platform | null {
  if (!import.meta.env.DEV || typeof location === "undefined") return null;
  const said = new URLSearchParams(location.search).get("platform");
  return said === "macos" || said === "windows" || said === "linux" ? said : null;
}

function detect(): Platform {
  const pretend = asked();
  if (pretend) return pretend;
  const hint = ((navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "").toLowerCase();
  if (hint.includes("mac")) return "macos";
  if (hint.includes("win")) return "windows";
  return "linux";
}

export const platform: Platform = detect();
export const isMac = platform === "macos";

/** The modifier's name where a shortcut is written down. */
export const mod = isMac ? "⌘" : "Ctrl";
/** A shortcut as text: `key("J")` → "⌘J" or "Ctrl+J". */
export const key = (k: string) => (isMac ? `${mod}${k}` : `${mod}+${k}`);

/**
 * The *other* modifier: for something local to one pane, where ⌘ is the
 * window's.
 *
 * The rail's destinations took ⌘1–⌘7, which the workbench's inspector tabs
 * used to hold the first three of. A destination is global so it takes the global modifier;
 * a panel tab is local to one workspace, so it takes this. On a Mac that is
 * ⌃, which is free. **Everywhere else Ctrl *is* the global modifier**, so the
 * local one has to be Alt or the two collide — which is the kind of thing
 * that is only found on the platform nobody is developing on.
 */
export const localMod = isMac ? "⌃" : "Alt";
/** A local shortcut as text: `localKey("1")` → "⌃1" or "Alt+1". */
export const localKey = (k: string) => (isMac ? `${localMod}${k}` : `${localMod}+${k}`);
/**
 * Whether a key event carries the global modifier, or the local one.
 *
 * **Mutually exclusive, which is the whole point of having both.** The
 * window's handlers used to test `e.metaKey || e.ctrlKey` — convenient while
 * nothing on a Mac used Ctrl alone, and wrong the moment the inspector's tabs
 * moved onto it: ⌃2 reached the rail's handler first and navigated to Tasks
 * instead of switching a tab. One keystroke, two meanings, and only the app
 * running said so.
 *
 * So each asks for exactly its own modifier and refuses the other. Alt is
 * excluded from both because on a Mac it composes characters and off one it
 * *is* the local modifier.
 */
export const isGlobalMod = (e: { ctrlKey: boolean; altKey: boolean; metaKey: boolean }) =>
  isMac ? e.metaKey && !e.ctrlKey && !e.altKey : e.ctrlKey && !e.metaKey && !e.altKey;
export const isLocalMod = (e: { ctrlKey: boolean; altKey: boolean; metaKey: boolean }) =>
  isMac ? e.ctrlKey && !e.metaKey && !e.altKey : e.altKey && !e.ctrlKey && !e.metaKey;

/* Told to the stylesheet, so the chrome tokens can differ by platform. */
if (typeof document !== "undefined") document.documentElement.dataset.platform = platform;
