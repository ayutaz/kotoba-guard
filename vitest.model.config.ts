import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/core/tests/**/*.integration.ts"],
    testTimeout: 60_000,
  },
});
