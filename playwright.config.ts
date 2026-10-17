/**
 * Browser tests for the core flows, against the local stack (see "Browser tests" in README.md):
 *   npx supabase start, npm run seed:demo, then `npm run test:browser`.
 * Playwright starts the API (`npm run dev:api` on :8787) unless it's already running, and serves a
 * production build of the web app on :4173 (reusing a running one, except in CI).
 */
import { defineConfig, devices } from "@playwright/test";

const CI = Boolean(process.env.CI);
const WEB = process.env.CREWTAVO_WEB_URL ?? "http://localhost:4173";
const API = process.env.CREWTAVO_API_URL ?? "http://localhost:8787";

export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e/.results",
  // The flows share one demo company; each test makes its own client, so they can run side by side.
  fullyParallel: true,
  workers: CI ? 2 : 4,
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["github"], ["html", { open: "never", outputFolder: "e2e/.report" }]] : [["list"], ["html", { open: "never", outputFolder: "e2e/.report" }]],
  globalTeardown: "./e2e/support/teardown.ts",
  use: {
    baseURL: WEB,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    timezoneId: "America/New_York", // the demo company's time zone, so "today" matches
    locale: "en-US",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, dependencies: ["setup"], testIgnore: /auth\.setup\.ts/ },
  ],
  webServer: [
    {
      // CI starts the API before seeding the demo company, so it's reused there too.
      command: "npm run dev:api",
      url: `${API}/api/health`,
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: "ignore",
    },
    {
      // A production build, so the tests also cover chunking and screen prefetching.
      command: "npx vite build --logLevel warn && npx vite preview --port 4173 --strictPort",
      cwd: "apps/web",
      url: WEB,
      reuseExistingServer: !CI,
      timeout: 180_000,
      env: { CREWTAVO_API_URL: API },
    },
  ],
});
