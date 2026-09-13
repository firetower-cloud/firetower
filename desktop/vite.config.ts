import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "../web");
const overrides = path.resolve(here, "src/overrides");

/**
 * Alias, plus overrides.
 *
 * The prototype renders the *real* components out of `../web`, so what we learn
 * about them is true of the thing that ships rather than of a copy that drifted.
 * When one genuinely fights the native shell, it is copied into `src/overrides/`
 * and this resolver prefers it — which makes that directory the honest list of
 * what did not survive the move off the web.
 */
function overrideFirst() {
  return {
    name: "firetower:override-first",
    async resolveId(this: any, source: string, importer?: string) {
      const m = source.match(/^@\/(components|src)\/(.+)$/);
      if (!m) return null;
      const tail = m[2].replace(/\.(tsx?|jsx?)$/, "");
      for (const ext of [".tsx", ".ts"]) {
        const hit = path.join(overrides, `${m[1]}/${tail}${ext}`);
        // Through Vite's own resolver, so the id is the same one every other
        // route to this file gets. A raw path here is a second module instance.
        if (existsSync(hit)) return this.resolve(hit, importer, { skipSelf: true });
      }
      return null;
    },
  };
}

/**
 * Swap the mutator for the desktop's, however it is reached.
 *
 * Orval writes `import { http } from '../../http'` into all 86 generated files
 * — a **relative** path, which a `resolve.alias` entry on `@/src/api/http`
 * never sees. Without this the generated client quietly keeps using the real
 * mutator, every request 404s against the dev server, and the screens render
 * empty rather than wrong. That is a silent failure, so it is caught here by
 * resolved path rather than by specifier.
 */
const SWAPS: Record<string, string> = {
  [path.join(web, "src/api/http.ts")]: path.resolve(here, "src/client/http.ts"),
};

function swapMutator() {
  return {
    name: "firetower:swap-mutator",
    enforce: "pre" as const,
    async resolveId(this: any, source: string, importer?: string) {
      if (!importer || !source.startsWith(".")) return null;
      const from = path.resolve(path.dirname(importer), source);
      for (const ext of ["", ".ts", ".tsx"]) {
        const hit = SWAPS[from + ext];
        // Resolved by Vite rather than returned as a path: a raw absolute path
        // becomes an `/@fs/` id, which is a *different module* from the
        // `/src/…` id the app's own imports get. That split is how the real
        // socket ended up with a copy of the mutator that never learned which
        // server was current, and so never opened a socket to it.
        if (hit) return this.resolve(hit, importer, { skipSelf: true });
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [swapMutator(), overrideFirst(), react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 5273,
    strictPort: true,
    // The components, and the font files they are designed in, live outside
    // this package's root. Dev refuses to serve those without being told.
    fs: { allow: [here, web, path.resolve(here, "..")] },
  },
  resolve: {
    /* One copy of each, or there are two Reacts and two `lucide-react`s — the
       components come from `../web`, which has its own `node_modules`. Vite
       picks one on its own; saying so keeps the type-checker and the bundler
       agreeing about which. */
    dedupe: ["react", "react-dom", "lucide-react", "@tanstack/react-query", "zod"],
    alias: [
      // Next.js coupling. Three shims, ~80 lines, and everything else ports.
      { find: /^next\/link$/, replacement: path.resolve(here, "src/shims/next-link.tsx") },
      { find: /^next\/navigation$/, replacement: path.resolve(here, "src/shims/next-navigation.ts") },
      { find: /^next\/font\/google$/, replacement: path.resolve(here, "src/shims/next-font.ts") },

      // The whole API surface goes through one mutator (`orval.config.ts`
      // points all 86 endpoints at it), and the desktop's knows which server.
      { find: /^@\/src\/api\/http$/, replacement: path.resolve(here, "src/client/http.ts") },

      // Everything else resolves into the real web application.
      { find: /^@\/components\/(.*)$/, replacement: `${web}/components/$1` },
      { find: /^@\/src\/(.*)$/, replacement: `${web}/src/$1` },
      { find: /^@\/app\/(.*)$/, replacement: `${web}/app/$1` },
      { find: /^~\/(.*)$/, replacement: path.resolve(here, "src") + "/$1" },
    ],
  },
  // The components live outside this package's root, so Vite must be allowed to
  // read them and to pre-bundle the dependencies they reach for.
  optimizeDeps: {
    include: ["react", "react-dom", "@tanstack/react-query", "lucide-react"],
  },
});
