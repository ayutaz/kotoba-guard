import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    // Keep filesystem-heavy fixtures within their existing deadlines on
    // developer machines and small CI runners without oversubscribing workers.
    maxWorkers: 4,
    include: [
      "packages/**/*.test.ts",
      "extension/**/*.test.ts",
      "tests/unit/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    environment: "jsdom",
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**/*.ts", "extension/src/**/*.ts"],
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        statements: 80,
        lines: 80,
        "packages/core/src/**": { statements: 90, lines: 90 },
      },
    },
  },
});
