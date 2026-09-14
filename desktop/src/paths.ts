/**
 * File paths in text, and what they point at.
 *
 * Agents and build tools both print paths — `src/ui/Chat.tsx:412`,
 * `crates/ft-core/src/lib.rs` — and a path you can read but not open is a
 * small daily irritation. This finds them, and asks the workspace whether
 * they are real before anything is opened: `find_files` by the last segment,
 * then the candidate that ends with what was written.
 */
import { findFiles } from "~/api/generated/sessions/sessions";

export type Found = { text: string; path: string; line?: number; start: number; end: number };

/** A path is either something with a directory in it, or a bare name with a source-ish extension. */
const PATH = /(?<![\w/@.-])((?:\.{1,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[a-zA-Z0-9]{1,8}|[\w@-][\w@.-]*\.(?:tsx?|jsx?|mjs|cjs|rs|py|go|rb|java|kt|swift|c|h|cpp|cs|php|lua|zig|sh|bash|zsh|json|ya?ml|toml|md|mdx|css|scss|html|sql|txt|env))(?::(\d{1,6}))?(?::\d{1,6})?(?![\w/@-])/g;

export function findPaths(text: string): Found[] {
  const out: Found[] = [];
  for (const m of text.matchAll(PATH)) {
    const path = m[1].replace(/^\.\//, "");
    // A URL host or a version is not a path.
    if (/^(https?|www)\./.test(path) || /^\d+(\.\d+)+$/.test(path)) continue;
    out.push({ text: m[0], path, line: m[2] ? Number(m[2]) : undefined, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

const known = new Map<string, Promise<string | null>>();

/** The workspace path a written one means, or nothing if it is not there. */
export function resolvePath(sessionId: string, written: string): Promise<string | null> {
  const key = `${sessionId}\n${written}`;
  let hit = known.get(key);
  if (!hit) {
    const name = written.split("/").pop() ?? written;
    hit = findFiles(sessionId, { q: name, limit: 100 })
      .then((paths) => {
        const clean = written.replace(/^(\.\.\/)+/, "");
        const exact = paths.find((p) => p === clean || p.endsWith(`/${clean}`));
        if (exact) return exact;
        const same = paths.filter((p) => p.split("/").pop() === name);
        return same.length === 1 ? same[0] : null;
      })
      .catch(() => null);
    known.set(key, hit);
  }
  return hit;
}

/**
 * Mark the paths in rendered text so they can be clicked.
 *
 * Walks text nodes only, and leaves links alone; a `<code>` holding just a
 * path becomes the link itself rather than gaining a span inside it.
 */
export function markPaths(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("a, [data-path], pre") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  for (const t of texts) {
    const found = findPaths(t.data);
    if (found.length === 0) continue;
    const parent = t.parentElement;
    if (parent?.tagName === "CODE" && found.length === 1 && found[0].text === t.data.trim()) {
      parent.dataset.path = found[0].path;
      if (found[0].line) parent.dataset.line = String(found[0].line);
      parent.classList.add("path-link");
      continue;
    }
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const f of found) {
      if (f.start > at) frag.append(t.data.slice(at, f.start));
      const span = document.createElement("span");
      span.textContent = f.text;
      span.dataset.path = f.path;
      if (f.line) span.dataset.line = String(f.line);
      span.className = "path-link";
      frag.append(span);
      at = f.end;
    }
    if (at < t.data.length) frag.append(t.data.slice(at));
    t.replaceWith(frag);
  }
}

// Reachable from the console while developing, since the pieces above run
// inside event handlers that are awkward to poke at.
if (import.meta.env.DEV) (window as unknown as { __ftPaths?: unknown }).__ftPaths = { findPaths, resolvePath };
