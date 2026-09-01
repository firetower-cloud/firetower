import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * `@/` means the same thing under a test as it does under Next.
 *
 * Without this, a test can only reach a module whose own imports are all
 * relative — which quietly decides what is testable, and the answer was
 * "not components". Everything else stays default.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
});
