import assert from "node:assert/strict";
import { memoryComparison } from "./retention_trial_evidence.mjs";

const PHASES = [
  "before-inference",
  "shared-inference",
  "idle-1",
  "resume-1",
  "idle-2",
  "resume-2",
];
const ACTIVE = [false, true, false, true, false, true];
const RELEASE = { completed: 1, failed: 0, timedOut: 0, sendFailed: 0 };
function identity(value, max) {
  assert.ok(
    typeof value === "string" && value.length > 0 && value.length <= max,
  );
}
function duration(value, maximum) {
  assert.ok(
    typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value < maximum,
  );
}
function keys(value, allowed) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  for (const key of Object.keys(value))
    assert.ok(allowed.includes(key), `undeclared report field: ${key}`);
}

/** Default retention0 lifecycle only. External binding must verify source/assets. */
export function validateRuntimeCompatibility(report, expected) {
  keys(report, [
    "sourceCommit",
    "runtimeSourceCommit",
    "status",
    "arm",
    "testSha256",
    "expectedModelSha256",
    "modelSha256",
    "browserVersion",
    "platform",
    "node",
    "completedInferences",
    "storageContainsInput",
    "unexpectedRequests",
    "pageErrors",
    "backend",
    "wasmThreads",
    "fixturePermission",
    "workerObservationMethod",
    "workerObservation",
    "snapshots",
    "cycles",
    "observedNotices",
    "finalExpiry",
    "assets",
    "clone",
    "retentionMs",
    "limitations",
    "elapsedMs",
    "cleanup",
    "cleanupPhases",
  ]);
  assert.match(expected.sourceCommit, /^[0-9a-f]{40}$/);
  assert.match(expected.runtimeSourceCommit, /^[0-9a-f]{40}$/);
  assert.match(expected.modelSha256, /^[0-9a-f]{64}$/);
  for (const key of [
    "sourceCommit",
    "runtimeSourceCommit",
    "browserVersion",
    "platform",
    "node",
    "modelSha256",
  ]) {
    identity(expected[key], 128);
    assert.equal(report[key], expected[key], key);
  }
  assert.equal(report.status, "completed");
  assert.equal(report.expectedModelSha256, report.modelSha256);
  assert.equal(report.arm, "control");
  assert.equal(report.retentionMs, 0);
  assert.equal(report.backend, "wasm");
  assert.equal(report.wasmThreads, 1);
  assert.equal(report.completedInferences, 4);
  assert.equal(report.storageContainsInput, false);
  assert.equal(report.unexpectedRequests, 0);
  assert.equal(report.pageErrors, 0);
  assert.equal(report.cleanup, "completed");
  assert.equal(report.finalExpiry, null);
  assert.deepEqual(
    report.snapshots.map((s) => s.phase),
    PHASES,
  );
  assert.deepEqual(
    report.workerObservation.map((s) => s.phase),
    PHASES,
  );
  for (let i = 0; i < PHASES.length; i++) {
    const s = report.snapshots[i];
    const obs = report.workerObservation[i];
    keys(s, [
      "phase",
      "elapsedMs",
      "sampleDurationMs",
      "modelReady",
      "offscreenDocumentId",
      "workerTargetIds",
      "memory",
    ]);
    keys(obs, [
      "phase",
      "status",
      "parentBound",
      "workers",
      "pendingCommands",
      "ownedParentSessions",
      "disposed",
    ]);
    keys(s.memory, [
      "status",
      "scope",
      "rows",
      "missingPids",
      "requestedProcessCount",
      "countExact",
    ]);
    for (const row of s.memory.rows)
      keys(row, ["pid", "role", "type", "currentBytes", "peakBytes"]);
    assert.equal(s.modelReady, ACTIVE[i]);
    assert.equal(obs.status, "complete");
    assert.equal(obs.parentBound, ACTIVE[i]);
    assert.equal(obs.workers, ACTIVE[i] ? 1 : 0);
    assert.equal(obs.pendingCommands, 0);
    assert.equal(obs.ownedParentSessions, ACTIVE[i] ? 1 : 0);
    assert.equal(obs.disposed, false);
    assert.ok(Array.isArray(s.workerTargetIds));
    assert.equal(s.workerTargetIds.length, ACTIVE[i] ? 1 : 0);
    if (ACTIVE[i]) {
      identity(s.workerTargetIds[0], 256);
      identity(s.offscreenDocumentId, 128);
    } else assert.equal(s.offscreenDocumentId, null);
  }
  const active = [1, 3, 5].map((i) => report.snapshots[i]);
  assert.equal(new Set(active.map((s) => s.workerTargetIds[0])).size, 3);
  assert.equal(new Set(active.map((s) => s.offscreenDocumentId)).size, 3);
  assert.equal(report.cycles.length, 2);
  for (let i = 0; i < 2; i++) {
    const cycle = report.cycles[i];
    keys(cycle, [
      "cycle",
      "worker",
      "document",
      "releases",
      "releaseObservedAfterMs",
      "idleStartedAfterLastInputMs",
      "releaseObservedAfterLastInputMs",
    ]);
    assert.equal(cycle.cycle, i + 1);
    assert.equal(cycle.worker, active[i + 1].workerTargetIds[0]);
    assert.equal(cycle.document, active[i + 1].offscreenDocumentId);
    assert.deepEqual(cycle.releases, RELEASE);
    duration(cycle.releaseObservedAfterMs, 85000);
    duration(cycle.idleStartedAfterLastInputMs, 240000);
    duration(cycle.releaseObservedAfterLastInputMs, 240000);
    assert.ok(cycle.releaseObservedAfterLastInputMs >= 60000);
    assert.ok(
      Math.abs(
        cycle.releaseObservedAfterLastInputMs -
          cycle.idleStartedAfterLastInputMs -
          cycle.releaseObservedAfterMs,
      ) < 0.001,
    );
  }
  assert.equal(report.observedNotices.length, 2);
  for (let i = 0; i < 2; i++) {
    const notice = report.observedNotices[i];
    keys(notice, ["documentId", "senderDocumentId", "releases"]);
    assert.equal(notice.documentId, active[i].offscreenDocumentId);
    assert.ok(
      notice.senderDocumentId === null ||
        notice.senderDocumentId === notice.documentId,
    );
    assert.deepEqual(notice.releases, RELEASE);
  }
  assert.deepEqual(
    report.cleanupPhases.map((p) => p.resource),
    ["worker-observer", "cdp-session", "browser-context", "fixture-server"],
  );
  for (const phase of report.cleanupPhases) {
    keys(phase, ["resource", "status", "elapsedMs"]);
    assert.equal(phase.status, "completed");
    duration(phase.elapsedMs, 5000);
  }
  const memory = memoryComparison(report.snapshots);
  return {
    boundedCompatibilityAcceptance: true,
    senderIdentityAuthenticated: report.observedNotices.every(
      (n) => n.senderDocumentId === n.documentId,
    ),
    staleNoticeSecurityAcceptance: false,
    memoryGrowthAcceptance: false,
    fullM5Acceptance: false,
    memory,
  };
}
