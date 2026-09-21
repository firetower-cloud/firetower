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

/* Told to the stylesheet, so the chrome tokens can differ by platform. */
if (typeof document !== "undefined") document.documentElement.dataset.platform = platform;
