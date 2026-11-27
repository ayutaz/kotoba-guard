import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";

const output = process.env.KOTOBA_PARENT_HEAP_OUTPUT;
if (
  !output ||
  !path.isAbsolute(output) ||
  path.resolve(output) !==
    path.resolve(
      "artifacts/parent-worker-heap-calibration",
      process.env.SOURCE_COMMIT ?? "",
      "report.json",
    ) ||
  !/^[0-9a-f]{40}$/.test(process.env.SOURCE_COMMIT ?? "")
)
  throw new Error("invalid-heap-probe-environment");
const reporterOutput = path.join(path.dirname(output), "playwright.json");
if (existsSync(output) || existsSync(reporterOutput))
  throw new Error("heap-artifact-already-exists");
export default defineConfig({
  testDir: "./tests/diagnostics",
  testMatch: "parent-heap-calibration.spec.ts",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  outputDir: path.join(path.dirname(output), "playwright-results"),
  reporter: [["list"], ["json", { outputFile: reporterOutput }]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
