/**
 * Which desktop this is, for the few things that differ.
 *
 * The app is one codebase on three platforms; what differs is the modifier
 * key's name, whether the window draws its own buttons, and whether the
 * sidebar is translucent. Everything reads those from here, so "Windows"
 * is a value and not a search through the tree.
 */
export type Platform = "macos" | "windows" | "linux";

function detect(): Platform {
  /* `?platform=windows` draws the app as another desktop would, in
     development only. A dozen small things differ by platform — the modifier's
     name, the window buttons, the translucent sidebar, the words in the
     microphone dialog — and without this the only way to look at any of them
     is to be on that machine. Overriding the user agent does not work: the
     answer below comes from `userAgentData`, which a flag cannot forge. */
  if (import.meta.env.DEV && typeof location !== "undefined") {
    const asked = new URLSearchParams(location.search).get("platform");
    if (asked === "macos" || asked === "windows" || asked === "linux") return asked;
  }

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
