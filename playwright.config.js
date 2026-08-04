import { defineConfig, devices } from "@playwright/test";

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
  // Tests run in installed Edge rather than a downloaded Chromium. The app renders in
  // WebView2, which is Edge's engine and on this machine the identical build, so this
  // exercises the real rendering engine instead of an approximation of it. It also means
  // no browser download, which matters on a restricted network and in CI.
  projects: [
    {
      name: "edge",
      use: { ...devices["Desktop Edge"], channel: "msedge" },
    },
  ],
  webServer: {
    command: "node tests/frontend/serve-ui.js",
    url: "http://127.0.0.1:4317/index.html?fixture",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
