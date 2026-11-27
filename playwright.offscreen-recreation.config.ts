import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseOffscreenIdleTrialEnvironment } from "./tests/diagnostics/offscreen-recreation-contract";

const trial = parseOffscreenIdleTrialEnvironment(process.env);
const reporterOutput = path.join(path.dirname(trial.output), "playwright.json");
if (existsSync(reporterOutput) || existsSync(trial.output))
  throw new Error("offscreen-idle-artifact-already-exists");

export default defineConfig({
  testDir: "./tests/diagnostics",
  testMatch: "offscreen-recreation.spec.ts",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  outputDir: path.join(path.dirname(trial.output), "playwright-results"),
  reporter: [["list"], ["json", { outputFile: reporterOutput }]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
