import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertMemoryOverlay,
  memoryWorkerOverlay,
  parseModelHeapTrial,
  createModelHeapBudget,
  classifyModelHeapGrowth,
  boundedDiagnosticCommand,
} from "../diagnostics/model-heap-contract";
afterEach(() => vi.useRealTimers());

it("bounds a silent diagnostic command rather than waiting for the whole test timeout", async () => {
  vi.useFakeTimers();
  const result = boundedDiagnosticCommand(new Promise(() => undefined)).catch(
    (error: Error) => error.message,
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toBe("model-heap-command-timeout");
});

const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const baseWorker = Buffer.from(
    'import "./core.js";\nself.onmessage=()=>{};\n',
  );
  const expectedProbe = Buffer.from("export const localProbe = true;\n");
  const baseManifest = Buffer.from(
    JSON.stringify({
      manifest_version: 3,
      permissions: ["offscreen"],
      optional_host_permissions: ["https://*/*"],
    }),
  );
  const manifest = Buffer.from(
    JSON.stringify({
      ...JSON.parse(baseManifest.toString()),
      host_permissions: ["http://127.0.0.1:12345/*"],
    }),
  );
  const entry = (value: Buffer) => ({
    bytes: value.length,
    sha256: sha(value),
  });
  const baseline = Object.fromEntries(
    Array.from({ length: 79 }, (_, i) => [
      `asset-${i}.js`,
      entry(Buffer.from(`${i}`)),
    ]),
  );
  baseline["worker.js"] = entry(baseWorker);
  baseline["manifest.json"] = entry(baseManifest);
  const worker = memoryWorkerOverlay(baseWorker);
  const variant: Record<string, ReturnType<typeof entry>> = {
    ...baseline,
    "worker.js": entry(worker),
    "manifest.json": entry(manifest),
    "memory-probe.mjs": entry(expectedProbe),
  };
  return {
    baseline,
    variant,
    baseWorker,
    worker,
    baseManifest,
    manifest,
    probe: expectedProbe,
    expectedProbe,
    origin: "http://127.0.0.1:12345",
  };
}
it("preserves every original worker byte and permits only the fixed diagnostic overlay", () => {
  const value = fixture();
  expect(assertMemoryOverlay(value)).toMatchObject({
    unchangedAssets: 79,
    variantAssetCount: 82,
    workerSuffixSha256: sha(value.baseWorker),
    probeSha256: sha(value.probe),
  });
});

it("clips waits and refuses a new OS query or inference when the body budget is exhausted", () => {
  let now = 0;
  const budget = createModelHeapBudget(0, () => now);
  expect(budget.timeout(85000)).toBe(85000);
  now = 180000;
  expect(budget.timeout(85000)).toBe(10000);
  expect(() => budget.assertActive(15000)).toThrow(
    "model-heap-observation-deadline",
  );
  now = 190000;
  expect(() => budget.assertActive()).toThrow();
});

it("classifies only complete positive phase-matched measurements", () => {
  const row = (phase: string, currentBytes: number, capacity: number) => ({
    phase,
    memory: {
      status: "measured",
      rows: [{ pid: 1, role: "renderer", currentBytes }],
      missingPids: [],
    },
    workerObservation: {
      status: "completed",
      heap: { wasm: { totalBytes: capacity }, heap: { usedSize: 100 } },
    },
  });
  const before = row("resume-1", 100, 65536),
    after = row("resume-2", 240, 65536);
  expect(classifyModelHeapGrowth([before, after])).toMatchObject({
    processRatio: 2.4,
    wasmRatio: 1,
    jsUsedRatio: 1,
    classification:
      "process_growth_not_reflected_in_current_worker_wasm_or_used_js",
  });
  expect(
    classifyModelHeapGrowth([
      before,
      { ...after, memory: { ...after.memory, status: "partial" } },
    ]).classification,
  ).toBe("unknown");
  expect(
    classifyModelHeapGrowth([row("resume-1", 0, 0), after]).classification,
  ).toBe("unknown");
  for (const replacement of [
    { pid: 2, role: "renderer", currentBytes: 240 },
    { pid: 1, role: "GPU", currentBytes: 240 },
    { pid: 1, role: "renderer", currentBytes: 120 },
  ]) {
    const rows =
      replacement.currentBytes === 120
        ? [replacement, replacement]
        : [replacement];
    expect(
      classifyModelHeapGrowth([
        before,
        { ...after, memory: { ...after.memory, rows } },
      ]).classification,
    ).toBe("unknown");
  }
});
it("rejects model/core changes, extra code, nonlocal host permission and altered worker suffix", () => {
  const changed = fixture();
  changed.variant["asset-0.js"] = { bytes: 1, sha256: "0".repeat(64) };
  expect(() => assertMemoryOverlay(changed)).toThrow();
  const extra = fixture();
  extra.variant["remote.js"] = { bytes: 1, sha256: "0".repeat(64) };
  expect(() => assertMemoryOverlay(extra)).toThrow();
  const worker = fixture();
  worker.worker = Buffer.from('import "remote";');
  expect(() => assertMemoryOverlay(worker)).toThrow();
  const manifest = fixture();
  manifest.manifest = Buffer.from(
    JSON.stringify({
      manifest_version: 3,
      permissions: ["tabs"],
      host_permissions: ["<all_urls>"],
    }),
  );
  expect(() => assertMemoryOverlay(manifest)).toThrow();
});
it("binds the trial to the source-specific artifact directory and pinned runtime", () => {
  const source = "a".repeat(40);
  const env = {
    SOURCE_COMMIT: source,
    RUNTIME_SOURCE_COMMIT: "0f99811fb1a78a0a40c86ada6bda1fa5a42b10f7",
    KOTOBA_MODEL_HEAP_OUTPUT: path.resolve(
      "artifacts/model-worker-heap-observation",
      source,
      "report.json",
    ),
    KOTOBA_MODEL_HEAP_PREFLIGHT_SHA256: "b".repeat(64),
  };
  expect(parseModelHeapTrial(env).sourceCommit).toBe(source);
  expect(() =>
    parseModelHeapTrial({
      ...env,
      KOTOBA_MODEL_HEAP_OUTPUT: path.resolve("artifacts/report.json"),
    }),
  ).toThrow();
  expect(() =>
    parseModelHeapTrial({ ...env, RUNTIME_SOURCE_COMMIT: source }),
  ).toThrow();
});
