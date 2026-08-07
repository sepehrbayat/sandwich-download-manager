import { defineConfig, devices } from "@playwright/test";

const portableBrowser = process.env.PLAYWRIGHT_BROWSER === "chromium";

// The interface is plain files served over http, so the test server is the same one used for
// looking at the UI by hand. Reusing it means these tests exercise exactly what a developer
// sees, not a separate build path that could drift.
export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4317",
    trace: "retain-on-failure",
  },
  // Windows uses installed Edge because it is the same engine as WebView2. Native macOS/Linux
  // runners select bundled Chromium; packaged-app smoke tests cover the platform WebKit layer.
  projects: [
    {
      name: portableBrowser ? "chromium" : "edge",
      use: portableBrowser ? { ...devices["Desktop Chrome"] } : { ...devices["Desktop Edge"], channel: "msedge" },
    },
  ],
  webServer: {
    command: "node tests/frontend/serve-ui.js",
    url: "http://127.0.0.1:4317/index.html?fixture",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
