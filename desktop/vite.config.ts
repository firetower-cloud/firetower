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
    resolveId(source: string) {
      const m = source.match(/^@\/(components|src)\/(.+)$/);
      if (!m) return null;
      const tail = m[2].replace(/\.(tsx?|jsx?)$/, "");
      for (const ext of [".tsx", ".ts"]) {
        const hit = path.join(overrides, `${m[1]}/${tail}${ext}`);
        if (existsSync(hit)) return hit;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [overrideFirst(), react(), tailwindcss()],
  clearScreen: false,
  server: { port: 5273, strictPort: true },
  resolve: {
    alias: [
      // Next.js coupling. Three shims, ~80 lines, and everything else ports.
      { find: /^next\/link$/, replacement: path.resolve(here, "src/shims/next-link.tsx") },
      { find: /^next\/navigation$/, replacement: path.resolve(here, "src/shims/next-navigation.ts") },
      { find: /^next\/font\/google$/, replacement: path.resolve(here, "src/shims/next-font.ts") },

      // The whole API surface, mocked by replacing one module. `orval.config.ts`
      // points all 86 endpoints at this mutator, so there is nothing else to fake.
      { find: /^@\/src\/api\/http$/, replacement: path.resolve(here, "src/mock/http.ts") },
      { find: /^@\/src\/api\/socket$/, replacement: path.resolve(here, "src/mock/socket.tsx") },

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
