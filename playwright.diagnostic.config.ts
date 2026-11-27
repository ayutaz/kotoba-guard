import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseResourceTrialEnvironment } from "./tests/diagnostics/resource-contract";

const trial = parseResourceTrialEnvironment(process.env);
const reporterOutput = path.join(path.dirname(trial.output), "playwright.json");
if (existsSync(reporterOutput) || existsSync(trial.output))
  throw new Error("resource-artifact-already-exists");

export default defineConfig({
  testDir: "./tests/diagnostics",
  testMatch: "idle-no-related-attach.spec.ts",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: reporterOutput }]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
