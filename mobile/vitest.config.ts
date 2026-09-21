import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * The logic, without a renderer.
 *
 * Everything under test here is a pure function over the contract — the
 * conversation fold, the scaffolding fold, the ship stages, the frame router.
 * They came from `desktop/` with their tests, which is most of the point of
 * having taken them rather than written them again: the same inputs have to
 * mean the same thing on all three clients.
 */
export default defineConfig({
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "src"),
      // See the note in the stub: Flow-typed source, and nothing under test
      // touches it.
      "react-native": path.resolve(__dirname, "src/test/react-native.stub.ts"),
      "react-native-mmkv": path.resolve(__dirname, "src/test/native.stub.ts"),
      "expo-secure-store": path.resolve(__dirname, "src/test/native.stub.ts"),
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
