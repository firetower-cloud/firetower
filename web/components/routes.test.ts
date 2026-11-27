/**
 * Every link on this site goes somewhere this site exports.
 *
 * **This is the defect that survived the audit.** Deleting `/organization` and
 * `/` started from a grep for `href="/…"`, which found three destinations and
 * missed six: `Shell.tsx` keeps its rail in an array of
 * `{ href, label, icon }`, so the only page left — `/account` — drew a rail
 * linking to five organisation pages and a download page that had just been
 * deleted. Nothing errors when that happens. The rail renders, the links look
 * live, and clicking one is a 404 in the product's own navigation.
 *
 * So the question is asked of the routes rather than of a spelling: walk
 * `app/` for what is actually exported, walk the imports for what is actually
 * rendered, and compare. A destination written in an object, in an attribute
 * or in a `router` call is the same destination.
 *
 * **`/` is the exception and is not an exception to the rule.** It is the
 * renderer — a different bundle, embedded beside this one — so it is not a
 * route of this site and must not be reached with this site's client router,
 * which would ask for a page that does not exist and fetch no document at all.
 * It is reached by document load, through the one rule in `src/api/http.ts`.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Every route `next build` will export, read from the files that make them. */
function exported(): string[] {
  const out: string[] = [];
  const walk = (dir: string, route: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, `${route}/${entry.name}`);
      else if (entry.name === "page.tsx") out.push(route || "/");
    }
  };
  walk(join(root, "app"), "");
  return out.sort();
}

/** Resolve one import specifier the way Next and `vitest.config.ts` both do. */
function moduleAt(spec: string, from: string): string | null {
  if (!spec.startsWith("@/") && !spec.startsWith(".")) return null;
  const base = spec.startsWith("@/") ? join(root, spec.slice(2)) : resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Every module a visitor actually loads, from the layout and each page down.
 *
 * Reachability rather than "everything under `components/`", because the two
 * are not the same here and the difference is the whole point: this site still
 * carries screens from when it was the whole application, and they link to
 * routes it has never exported. They are not rendered, so they cannot send
 * anybody anywhere.
 */
function rendered(): { path: string; text: string }[] {
  const seeds = [join(root, "app/layout.tsx")];
  const pages = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pages(path);
      else if (entry.name === "page.tsx") seeds.push(path);
    }
  };
  pages(join(root, "app"));

  const seen = new Map<string, string>();
  const queue = [...seeds];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file) || !/\.tsx?$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    seen.set(file, text);
    for (const [, spec] of text.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
      const next = moduleAt(spec, file);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen].map(([path, text]) => ({ path: `${relative(root, path).split(sep).join("/")}`, text }));
}

/**
 * The file with its prose taken out.
 *
 * Every destination in here is also written about in a comment somewhere —
 * this file included — and a sweep that cannot tell a link from a sentence
 * about a link either fails on documentation or is quietly satisfied by it.
 * `//` after a colon is a URL scheme and is left alone.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Where one file sends somebody, however the destination is written.
 *
 * `href:` in an object is the shape the rail uses and is the one a search for
 * `href="…"` cannot see. `router.push`/`replace` are the same question asked
 * imperatively.
 */
function destinations(text: string): string[] {
  const code = withoutComments(text);
  return [
    ...code.matchAll(/href[:=]\s*\{?\s*["'`](\/[^"'`]*)["'`]/g),
    ...code.matchAll(/router\.(?:push|replace)\(\s*["'`](\/[^"'`$]*)["'`]/g),
  ].map((m) => m[1]);
}

describe("the site's own links", () => {
  it("exports the three routes that are reachable, and no others", () => {
    // Not a restatement of the directory listing: `/` and six organisation
    // routes were exported until the renderer took over their subjects, and
    // this is what says the deletion happened and stays happened.
    expect(exported()).toEqual(["/account", "/login", "/setup"]);
  });

  it("never points at a route it does not export", () => {
    const routes = exported();
    const dangling = rendered().flatMap((file) =>
      destinations(file.text)
        .filter((to) => !routes.includes(to))
        .map((to) => `${file.path} → ${to}`),
    );
    expect(dangling).toEqual([]);
  });

  /**
   * Anywhere that is not this site is reached by loading a document, which is
   * what the client router cannot do.
   *
   * Asserted over the sources rather than by driving a navigation, because
   * every call site is inside a mutation callback behind a real sign-in. The
   * invariant is cheap and it is the one that was broken: two screens finish
   * by leaving for `/`, and `router.replace("/")` leaves them on a blank
   * client route of a site that has no such page.
   *
   * Named screens rather than a count, so that a third one arriving is a
   * decision somebody made rather than something that slipped in — the shape
   * `desktop/src/ui/replace-password.test.ts` uses for the same reason.
   */
  it("leaves by document load, from both of the screens that leave", () => {
    const files = rendered();
    const leaving = files
      .filter((f) => /\b(toApplication|leaveFor)\(/.test(withoutComments(f.text)))
      .map((f) => f.path)
      .sort();
    expect(leaving).toEqual([
      "components/SignIn.tsx",
      "components/Setup.tsx",
      "src/api/http.ts",
    ].sort());

    const rule = files.find((f) => f.path === "src/api/http.ts")!.text;
    expect(rule).toMatch(/export function leaveFor\(path: string\)/);
    expect(rule).toMatch(/window\.location\.replace\(path\)/);

    /* And neither screen reaches `location` around it. The rule is only a
       rule while it is the only way out. (`Shell.tsx` is deliberately not in
       this list: its sign-out is a hop to `/login`, which is this site's own
       page and not a leaving.) */
    for (const path of ["components/SignIn.tsx", "components/Setup.tsx"]) {
      const text = withoutComments(files.find((f) => f.path === path)!.text);
      expect(text, path).not.toMatch(/window\.location\.(replace|assign|href)/);
    }
  });

  /**
   * The return path exists, and the one screen that needs it asks for it.
   *
   * `/account` holds the only voluntary password form in the product and it
   * needs a session. A browser sent there by the desktop app's *change
   * password* button does not have one — the renderer keeps its token under
   * `firetower.servers` and this site under `firetower.token`, so being
   * signed in to one is not being signed in to the other — and before this it
   * was bounced to `/login` and then returned to the application, which is
   * where it had just come from.
   */
  it("remembers where somebody was when it sends them to sign in", () => {
    const rule = withoutComments(rendered().find((f) => f.path === "src/api/http.ts")!.text);
    expect(rule).toMatch(/\/login\?next=\$\{next\}/);
    expect(rule).toMatch(/encodeURIComponent\(window\.location\.pathname\)/);
  });
});
