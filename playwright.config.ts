import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  projects: [
    ...(process.env.KOTOBA_GUARD_E2E_MODE !== "real"
      ? [{ name: "mock", testMatch: /.*\.mock\.spec\.ts/ }]
      : []),
    ...(process.env.KOTOBA_GUARD_E2E_MODE !== "mock"
      ? [{ name: "real", testMatch: /.*\.real\.spec\.ts/ }]
      : []),
  ],
  reporter: [["list"], ["json", { outputFile: "artifacts/playwright.json" }]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
