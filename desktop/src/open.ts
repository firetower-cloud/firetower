/**
 * Opening a link outside the app.
 *
 * The webview has no browser around it: `window.open` and `target="_blank"`
 * go nowhere. Inside the shell a URL is handed to the system, which opens it
 * in the default browser; in an ordinary tab it is a tab.
 *
 * Installed once on the document, so every anchor that points off the app
 * opens the right way without each one knowing.
 */
export async function openExternal(url: string) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (w.__TAURI_INTERNALS__) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Anchors to other origins leave the app; anchors within it stay routed. */
export function catchExternalLinks() {
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
    const a = (e.target as HTMLElement | null)?.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (!/^https?:\/\//.test(href) || href.startsWith(location.origin + "/")) return;
    e.preventDefault();
    void openExternal(href);
  });
}
