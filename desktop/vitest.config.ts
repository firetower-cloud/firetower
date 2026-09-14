import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: { exclude: ["**/node_modules/**", "**/src-tauri/**"] },
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
});
