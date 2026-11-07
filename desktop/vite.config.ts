import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // The renderer awaits the keychain before it draws, which needs top-level await.
  build: { target: "es2022" },
  esbuild: { target: "es2022" },
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 5273, strictPort: true },
  resolve: {
    alias: [{ find: /^~\/(.*)$/, replacement: path.resolve(here, "src") + "/$1" }],
  },
});
