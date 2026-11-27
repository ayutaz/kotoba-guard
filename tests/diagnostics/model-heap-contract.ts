import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseResourceTrialEnvironment } from "./resource-contract";

type Asset = { bytes: number; sha256: string };
export async function boundedDiagnosticCommand<T>(
  operation: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("model-heap-command-timeout")),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
const prefix = Buffer.from('import "./memory-probe.mjs";\n');
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const entry = (value: Buffer): Asset => ({
  bytes: value.length,
  sha256: sha(value),
});
export function memoryWorkerOverlay(original: Buffer): Buffer {
  return Buffer.concat([prefix, original]);
}
export function assertMemoryOverlay(input: {
  baseline: Record<string, Asset>;
  variant: Record<string, Asset>;
  baseWorker: Buffer;
  worker: Buffer;
  baseManifest: Buffer;
  manifest: Buffer;
  probe: Buffer;
  expectedProbe: Buffer;
  origin: string;
}) {
  const { baseline, variant } = input;
  const fail = () => {
    throw new Error("invalid-model-heap-overlay");
  };
  if (
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(input.origin) ||
    Object.keys(baseline).length !== 81 ||
    Object.hasOwn(baseline, "memory-probe.mjs")
  )
    fail();
  const expectedNames = [...Object.keys(baseline), "memory-probe.mjs"].sort();
  if (!isDeepStrictEqual(Object.keys(variant).sort(), expectedNames)) fail();
  if (
    !input.worker.equals(memoryWorkerOverlay(input.baseWorker)) ||
    !input.probe.equals(input.expectedProbe)
  )
    fail();
  const expectedManifest = {
    ...JSON.parse(input.baseManifest.toString("utf8")),
    host_permissions: [`${input.origin}/*`],
  };
  if (
    !isDeepStrictEqual(
      JSON.parse(input.manifest.toString("utf8")),
      expectedManifest,
    )
  )
    fail();
  for (const [name, value] of Object.entries({
    "worker.js": input.baseWorker,
    "manifest.json": input.baseManifest,
  }))
    if (!isDeepStrictEqual(baseline[name], entry(value))) fail();
  for (const [name, value] of Object.entries({
    "worker.js": input.worker,
    "manifest.json": input.manifest,
    "memory-probe.mjs": input.probe,
  }))
    if (!isDeepStrictEqual(variant[name], entry(value))) fail();
  const unchanged = Object.keys(baseline).filter(
    (name) => !["worker.js", "manifest.json"].includes(name),
  );
  for (const name of unchanged)
    if (!isDeepStrictEqual(baseline[name], variant[name])) fail();
  return {
    unchangedAssets: unchanged.length,
    variantAssetCount: expectedNames.length,
    workerSuffixSha256: sha(input.baseWorker),
    probeSha256: sha(input.probe),
    workerPrefixBytes: prefix.length,
  };
}
export function parseModelHeapTrial(
  environment: Record<string, string | undefined>,
) {
  const trial = parseResourceTrialEnvironment({
    ...environment,
    KOTOBA_RESOURCE_OUTPUT: environment.KOTOBA_MODEL_HEAP_OUTPUT,
    KOTOBA_RESOURCE_PREFLIGHT_SHA256:
      environment.KOTOBA_MODEL_HEAP_PREFLIGHT_SHA256,
  });
  if (
    path.resolve(trial.output) !==
    path.resolve(
      "artifacts/model-worker-heap-observation",
      trial.sourceCommit,
      "report.json",
    )
  )
    throw new Error("invalid-model-heap-output");
  return trial;
}
export function createModelHeapBudget(
  startedAt: number,
  clock: () => number = () => performance.now(),
) {
  const deadline = startedAt + 190000;
  const assertActive = (requiredMs = 0) => {
    if (!Number.isFinite(clock()) || clock() + requiredMs >= deadline)
      throw new Error("model-heap-observation-deadline");
  };
  return {
    assertActive,
    timeout: (maximum: number) => {
      assertActive();
      return Math.min(maximum, deadline - clock());
    },
  };
}

type GrowthRecord = {
  phase: string;
  memory: {
    status: string;
    rows: Array<{ pid: number; role: string; currentBytes: number }>;
    missingPids: number[];
  };
  workerObservation: {
    status: string;
    heap: { wasm: { totalBytes: number }; heap: { usedSize: number } } | null;
  } | null;
};
export function classifyModelHeapGrowth(records: GrowthRecord[]) {
  const unknown = {
    classification: "unknown",
    processRatio: null,
    wasmRatio: null,
    jsUsedRatio: null,
  };
  const values = (phase: string) => {
    const matching = records.filter((row) => row.phase === phase);
    if (matching.length !== 1) return null;
    const row = matching[0]!,
      observation = row.workerObservation;
    if (
      row.memory.status !== "measured" ||
      row.memory.missingPids.length ||
      row.memory.rows.length === 0 ||
      observation?.status !== "completed" ||
      !observation.heap
    )
      return null;
    const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
    if (
      !row.memory.rows.every(
        (item) =>
          positive(item.currentBytes) &&
          positive(item.pid) &&
          typeof item.role === "string" &&
          item.role.length > 0,
      ) ||
      new Set(row.memory.rows.map((item) => item.pid)).size !==
        row.memory.rows.length
    )
      return null;
    const cohort = row.memory.rows
      .map(({ pid, role }) => ({ pid, role }))
      .sort((a, b) => a.pid - b.pid);
    const processBytes = row.memory.rows.reduce(
        (sum, item) => sum + item.currentBytes,
        0,
      ),
      wasmBytes = observation.heap.wasm.totalBytes,
      usedBytes = observation.heap.heap.usedSize;
    if (![processBytes, wasmBytes, usedBytes].every(positive)) return null;
    return { processBytes, wasmBytes, usedBytes, cohort };
  };
  const before = values("resume-1"),
    after = values("resume-2");
  if (!before || !after || !isDeepStrictEqual(before.cohort, after.cohort))
    return unknown;
  const processRatio = after.processBytes / before.processBytes,
    wasmRatio = after.wasmBytes / before.wasmBytes,
    jsUsedRatio = after.usedBytes / before.usedBytes;
  return {
    processRatio,
    wasmRatio,
    jsUsedRatio,
    classification:
      processRatio <= 1.25
        ? "no_large_process_growth_this_condition"
        : wasmRatio > 1.25
          ? "current_worker_wasm_growth"
          : jsUsedRatio > 1.25
            ? "current_worker_js_growth"
            : "process_growth_not_reflected_in_current_worker_wasm_or_used_js",
  };
}
