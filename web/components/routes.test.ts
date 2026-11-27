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

/** `{ A, B as C }` → the names as the module being imported from spells them. */
function names(clause: string): string[] {
  return clause
    .split(",")
    .map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

/**
 * A barrel's `export { X } from "./M"` lines, as identifier → module.
 *
 * **A barrel is why a dead module can look alive.** `components/ui/index.ts`
 * re-exports a dozen primitives, so a walk that follows every line in it marks
 * all of them reached the moment one page imports `{ Icon }`. `Segmented.tsx`
 * sat there unused through a deletion pass that way. Followed per identifier,
 * the question is asked properly.
 */
function barrel(file: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [, clause, spec] of readFileSync(file, "utf8").matchAll(
    /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g,
  )) {
    const target = moduleAt(spec, file);
    if (target) for (const name of names(clause)) map.set(name, target);
  }
  return map;
}

/** Every page, and the layout that wraps all of them. */
function seeds(): string[] {
  const out = [join(root, "app/layout.tsx")];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "page.tsx") out.push(path);
    }
  };
  walk(join(root, "app"));
  return out;
}

/**
 * Every module a visitor actually loads, from the layout and each page down.
 *
 * Reachability rather than "everything under `components/`", because the two
 * were not the same here and the difference is the whole point: this site
 * carried most of a workbench — new workspace, machines, hosts, repositories —
 * from when it was the whole product, none of it rendered by any of the three
 * pages that are left.
 */
function rendered(): { path: string; text: string }[] {
  const seen = new Map<string, string>();
  const queue: string[] = seeds();
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file) || !/\.tsx?$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    seen.set(file, text);

    const ask = (spec: string, asked: string[] | null) => {
      const target = moduleAt(spec, file);
      if (!target) return;
      const members = /\/index\.tsx?$/.test(target) ? barrel(target) : new Map<string, string>();
      if (members.size === 0) return void queue.push(target);
      seen.set(target, readFileSync(target, "utf8"));
      // A default or namespace import asks for the lot; a named one does not.
      for (const [name, module] of members) if (asked === null || asked.includes(name)) queue.push(module);
    };

    for (const [, clause, spec] of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g))
      ask(spec, names(clause));
    for (const [, spec] of text.matchAll(/import\s+(?:type\s+)?(?:\w+|\*\s+as\s+\w+)(?:\s*,\s*\{[^}]*\})?\s+from\s+["']([^"']+)["']/g))
      ask(spec, null);
    for (const [, spec] of text.matchAll(/import\s+["']([^"']+)["']/g)) ask(spec, null);
    for (const [, spec] of text.matchAll(/(?:import|require)\(\s*["']([^"']+)["']\s*\)/g)) ask(spec, null);
  }
  return [...seen].map(([path, text]) => ({ path: relative(root, path).split(sep).join("/"), text }));
}

/** Every module this site ships, generated clients and tests aside. */
function carried(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "generated") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
        out.push(relative(root, path).split(sep).join("/"));
    }
  };
  walk(join(root, "components"));
  walk(join(root, "src"));
  return out.sort();
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

/** The suite. A name only a test asks for is still a name somebody asks for. */
function tests(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "generated") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.test\.tsx?$/.test(entry.name))
        out.push({ path: relative(root, path).split(sep).join("/"), text: readFileSync(path, "utf8") });
    }
  };
  walk(join(root, "components"));
  walk(join(root, "src"));
  return out;
}

describe("the site's own links", () => {
  it("exports the three routes that are reachable, and no others", () => {
    // Not a restatement of the directory listing: `/` and six organisation
    // routes were exported until the renderer took over their subjects, and
    // this is what says the deletion happened and stays happened.
    expect(exported()).toEqual(["/account", "/login", "/setup"]);
  });

  /**
   * **The sibling of the test below, and the one nobody was running.**
   *
   * A link to a page that does not exist is caught there. This is the other
   * direction: a page's worth of code that no page reaches. Neither errors,
   * neither fails a build, and both are how a tree stops describing the
   * product — `tsc` compiles an orphan happily and `next build` leaves it out
   * of the bundle without mentioning it.
   *
   * It had accumulated two layers deep. Narrowing this site to administration
   * left a workbench behind it — new workspace, compute, hosts, repositories,
   * the GitHub authorization screen — and deleting the organisation pages left
   * seven interface primitives and six API helpers behind that. Each layer was
   * invisible until the one above it went.
   *
   * Reached from the layout and the pages, which is the only definition that
   * means anything: a module nothing renders cannot be looked at, whatever it
   * still compiles into.
   */
  it("renders everything it carries", () => {
    const live = new Set(rendered().map((f) => f.path));
    expect(carried().filter((f) => !live.has(f))).toEqual([]);
  });

  /**
   * And the same question one level down, for a name rather than a file.
   *
   * A module can be rendered while half of what it exports is not — which is
   * how a whole onboarding step, a status indicator and a layout hook outlived
   * everything that called them. Asked of `components/` and `src/` only, never
   * of `app/`: Next reads `metadata`, `viewport` and `generateMetadata` by
   * convention rather than by import, and a check that cannot tell a framework
   * hook from dead code is a check that fails somebody honestly adding one.
   */
  it("exports nothing nobody asks for", () => {
    const all = rendered();
    // Asked of what this site wrote; `src/api/generated/` is orval's and is
    // written whole whether or not a screen has reached for a given operation.
    const files = all.filter((f) => /^(components|src)\//.test(f.path) && !f.path.includes("/generated/"));
    const asked = new Map<string, Set<string>>();
    const want = (module: string, name: string) => {
      if (!asked.has(module)) asked.set(module, new Set());
      asked.get(module)!.add(name);
    };
    // Every rendered module is an asker, `app/` included — a page importing
    // `{ Shell }` is what keeps `Shell` alive.
    for (const f of [...all, ...tests()]) {
      const from = join(root, f.path);
      for (const [, clause, spec] of f.text.matchAll(
        /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g,
      )) {
        const target = moduleAt(spec, from);
        if (target) for (const name of names(clause)) want(relative(root, target).split(sep).join("/"), name);
      }
    }

    const dead: string[] = [];
    for (const f of files) {
      const code = withoutComments(f.text);
      const here = asked.get(f.path) ?? new Set<string>();
      for (const [, name] of code.matchAll(/export\s+(?:async\s+)?(?:function|const|class|type|interface)\s+(\w+)/g)) {
        if (here.has(name)) continue;
        const declares = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class|type|interface)\\s+${name}\\b`);
        const usedHere = code
          .split("\n")
          .some((line) => new RegExp(`\\b${name}\\b`).test(line) && !declares.test(line));
        if (!usedHere) dead.push(`${f.path} → ${name}`);
      }
    }
    expect(dead).toEqual([]);
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
