import path from "node:path";

const expectedOutputDirectory = "artifacts/offscreen-idle-recreation";

export function compareOffscreenProcessCohorts(
  snapshots: ReadonlyArray<{
    phase: string;
    memory: {
      status: string;
      missingPids: number[];
      rows: Array<{ pid: number; role: string; currentBytes: number }>;
    };
  }>,
) {
  const unknown = { ratio: null, cohortMatch: false };
  const phases = ["resume-1", "resume-2"].map((phase) =>
    snapshots.filter((row) => row.phase === phase),
  );
  if (phases.some((rows) => rows.length !== 1)) return unknown;
  const [before, after] = phases.map((rows) => rows[0]!);
  const valid = (row: typeof before) =>
    row !== undefined &&
    row.memory.status === "measured" &&
    row.memory.missingPids.length === 0 &&
    row.memory.rows.length > 0 &&
    row.memory.rows.every(
      (item) =>
        Number.isSafeInteger(item.pid) &&
        item.pid > 0 &&
        typeof item.role === "string" &&
        item.role.length > 0 &&
        Number.isSafeInteger(item.currentBytes) &&
        item.currentBytes > 0,
    ) &&
    new Set(row.memory.rows.map((item) => item.pid)).size ===
      row.memory.rows.length;
  if (!valid(before) || !valid(after)) return unknown;
  const cohort = (row: NonNullable<typeof before>) =>
    row.memory.rows
      .map(({ pid, role }) => ({ pid, role }))
      .sort((a, b) => a.pid - b.pid);
  if (JSON.stringify(cohort(before!)) !== JSON.stringify(cohort(after!)))
    return unknown;
  const bytes = (row: NonNullable<typeof before>) =>
    row.memory.rows.reduce((sum, item) => sum + item.currentBytes, 0);
  const first = bytes(before!),
    second = bytes(after!);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second))
    return unknown;
  return { ratio: second / first, cohortMatch: true };
}

export type OffscreenIdleTrial = {
  readonly sourceCommit: string;
  readonly runtimeSourceCommit: string;
  readonly output: string;
  readonly preflightSha256: string;
};

export function parseOffscreenIdleTrialEnvironment(
  environment: Record<string, string | undefined>,
): OffscreenIdleTrial {
  const sourceCommit = environment.SOURCE_COMMIT;
  const runtimeSourceCommit = environment.RUNTIME_SOURCE_COMMIT;
  const output = environment.KOTOBA_OFFSCREEN_IDLE_OUTPUT;
  const preflightSha256 = environment.KOTOBA_OFFSCREEN_IDLE_PREFLIGHT_SHA256;
  if (
    !sourceCommit ||
    !/^[0-9a-f]{40}$/.test(sourceCommit) ||
    runtimeSourceCommit !== sourceCommit ||
    !output ||
    !path.isAbsolute(output) ||
    path.normalize(output) !==
      path.resolve(expectedOutputDirectory, sourceCommit, "report.json") ||
    !preflightSha256 ||
    !/^[0-9a-f]{64}$/.test(preflightSha256)
  )
    throw new Error("invalid-offscreen-idle-trial");
  return { sourceCommit, runtimeSourceCommit, output, preflightSha256 };
}

type Asset = { readonly bytes: number; readonly sha256: string };

export function validateOffscreenIdlePreflight(
  value: unknown,
  trial: OffscreenIdleTrial,
  actualSha256: string,
  expectedModelSha256: string,
): Record<string, Asset> {
  if (!value || typeof value !== "object")
    throw new Error("invalid-offscreen-idle-preflight");
  const candidate = value as Record<string, unknown>;
  const assets = candidate.assets;
  if (
    actualSha256 !== trial.preflightSha256 ||
    candidate.source_commit !== trial.sourceCommit ||
    candidate.runtime_source_commit !== trial.runtimeSourceCommit ||
    candidate.source_clean !== true ||
    !assets ||
    typeof assets !== "object" ||
    Array.isArray(assets) ||
    Object.keys(assets).length !== 81
  )
    throw new Error("invalid-offscreen-idle-preflight");
  const normalized = assets as Record<string, unknown>;
  for (const entry of Object.values(normalized)) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as Asset).bytes !== "number" ||
      !Number.isSafeInteger((entry as Asset).bytes) ||
      (entry as Asset).bytes <= 0 ||
      typeof (entry as Asset).sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test((entry as Asset).sha256)
    )
      throw new Error("invalid-offscreen-idle-preflight");
  }
  const model = normalized["models/onnx/model_quantized.onnx"] as
    Asset | undefined;
  if (!model || model.sha256 !== expectedModelSha256)
    throw new Error("invalid-offscreen-idle-model-preflight");
  return normalized as Record<string, Asset>;
}

export function isSuccessfulOffscreenIdleNotice(
  value: unknown,
  expectedCount: number,
  currentDocumentId: string,
): boolean {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "documentId,releases,senderDocumentId" ||
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 1 ||
    !currentDocumentId
  )
    return false;
  const candidate = value as {
    documentId?: unknown;
    releases?: unknown;
    senderDocumentId?: unknown;
  };
  if (
    candidate.documentId !== currentDocumentId ||
    typeof candidate.documentId !== "string" ||
    (candidate.senderDocumentId !== null &&
      candidate.senderDocumentId !== candidate.documentId)
  )
    return false;
  if (!candidate.releases || typeof candidate.releases !== "object")
    return false;
  const releases = candidate.releases as Record<string, unknown>;
  if (
    Array.isArray(releases) ||
    Object.keys(releases).sort().join(",") !==
      "completed,failed,sendFailed,timedOut" ||
    !["completed", "failed", "timedOut", "sendFailed"].every(
      (key) =>
        Number.isSafeInteger(releases[key]) && (releases[key] as number) >= 0,
    )
  )
    return false;
  return (
    releases.completed === expectedCount &&
    releases.failed === 0 &&
    releases.timedOut === 0 &&
    releases.sendFailed === 0
  );
}
