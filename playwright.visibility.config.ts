import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { readVisibilityEnvironment } from "./tests/diagnostics/worker-visibility";

const { output } = readVisibilityEnvironment();
const reporterOutput = path.join(path.dirname(output), "playwright.json");
if (existsSync(output) || existsSync(reporterOutput))
  throw new Error("Visibility evidence already exists");
export default defineConfig({
  testDir: "./tests/diagnostics",
  testMatch: "worker-visibility.spec.ts",
  timeout: 180_000,
  expect: { timeout: 5_000 },
  workers: 1,
  retries: 0,
  outputDir: path.join(path.dirname(output), "playwright-results"),
  reporter: [["list"], ["json", { outputFile: reporterOutput }]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
