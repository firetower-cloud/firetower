/**
 * The editor strip, as a store rather than as component state.
 *
 * Ported in behaviour from `desktop/src/workspace/tabs.tsx`. Two rules carry
 * over unchanged, and they are the whole reason a strip is worth having on a
 * phone at all:
 *
 * - **The conversation is pinned first and cannot be closed.** It is what a
 *   workspace *is*, and a strip you can empty is one you can get lost in.
 * - **A single tap previews.** The tab opens in italic and the next preview
 *   replaces it; a long press keeps it. Skimming six files while reading a
 *   diff should leave one tab, not six — which matters more here, where six
 *   tabs do not fit.
 *
 * A store and not a hook's state because the strip outlives the screen that
 * opened it: tapping a file in the sheet pushes a viewer, and going back must
 * not throw the strip away.
 */
export type Tab = { id: "chat" } | { id: string; path: string; preview?: boolean };

let tabs: Tab[] = [{ id: "chat" }];
let active = "chat";
const watchers = new Set<() => void>();
const changed = () => watchers.forEach((w) => w());

export const snapshot = () => tabs;
export const activeId = () => active;

export function subscribe(fn: () => void) {
  watchers.add(fn);
  return () => void watchers.delete(fn);
}

/** Open a file. A preview replaces the last preview; a kept tab does not. */
export function open(path: string, keep = false) {
  const held = tabs.find((t) => "path" in t && t.path === path);
  if (held) {
    active = held.id;
    if (keep && "preview" in held) held.preview = false;
    tabs = [...tabs];
    return changed();
  }

  const tab: Tab = { id: path, path, preview: !keep };
  tabs = keep
    ? [...tabs, tab]
    : // The one preview slot: whatever was previewing gives it up.
      [...tabs.filter((t) => !("preview" in t && t.preview)), tab];
  active = tab.id;
  changed();
}

/** Promote the previewing tab to a kept one. */
export function keep(id: string) {
  tabs = tabs.map((t) => ("path" in t && t.id === id ? { ...t, preview: false } : t));
  changed();
}

export function close(id: string) {
  // The conversation is not closeable. Asked for, ignored.
  if (id === "chat") return;
  const at = tabs.findIndex((t) => t.id === id);
  tabs = tabs.filter((t) => t.id !== id);
  if (active === id) active = (tabs[at - 1] ?? tabs[0]).id;
  changed();
}

export function select(id: string) {
  active = id;
  changed();
}

export function reset() {
  tabs = [{ id: "chat" }];
  active = "chat";
  changed();
}
