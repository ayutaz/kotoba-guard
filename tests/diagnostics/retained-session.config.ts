import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /retained-session\.spec\.ts/,
  timeout: 360_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
