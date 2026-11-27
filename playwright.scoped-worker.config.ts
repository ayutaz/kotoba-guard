import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";

function readOutput(): string {
  const sourceCommit = process.env.SOURCE_COMMIT;
  const output = process.env.KOTOBA_SCOPED_WORKER_OUTPUT;
  const expected = sourceCommit
    ? path.resolve(
        "artifacts/scoped-worker-observer",
        sourceCommit,
        "report.json",
      )
    : "";
  if (
    !/^[a-f0-9]{40}$/.test(sourceCommit ?? "") ||
    !output ||
    !path.isAbsolute(output) ||
    output !== expected
  )
    throw new Error(
      "SOURCE_COMMIT and KOTOBA_SCOPED_WORKER_OUTPUT must identify the scoped observer report",
    );
  return output;
}

const output = readOutput();
const reporterOutput = path.join(path.dirname(output), "playwright.json");
if (existsSync(output) || existsSync(reporterOutput))
  throw new Error("Scoped observer evidence already exists");

export default defineConfig({
  testDir: "./tests/diagnostics",
  testMatch: "scoped-worker-observer.spec.ts",
  timeout: 180_000,
  expect: { timeout: 5_000 },
  workers: 1,
  retries: 0,
  outputDir: path.join(path.dirname(output), "playwright-results"),
  reporter: [["list"], ["json", { outputFile: reporterOutput }]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
