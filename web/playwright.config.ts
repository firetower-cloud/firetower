import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: "node e2e/serve.mjs",
    url: "http://localhost:3000/preview-annotations",
    reuseExistingServer: !process.env.CI,
  },
});
