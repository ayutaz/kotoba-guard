// @vitest-environment node
import { describe, expect, it } from "vitest";
import { validateRuntimeCompatibility } from "./runtime_compatibility_acceptance.mjs";

const source = "a".repeat(40);
const runtime = "b".repeat(40);
const model = "c".repeat(64);
const contract = {
  sourceCommit: source,
  runtimeSourceCommit: runtime,
  browserVersion: "116.0.5845.96",
  platform: "win32",
  node: "v24.15.0",
  modelSha256: model,
};
function fixture() {
  const phases = [
    "before-inference",
    "shared-inference",
    "idle-1",
    "resume-1",
    "idle-2",
    "resume-2",
  ];
  const active = [false, true, false, true, false, true];
  const docs = [null, "doc1", null, "doc2", null, "doc3"];
  const workers = [[], ["w1"], [], ["w2"], [], ["w3"]];
  const releases = { completed: 1, failed: 0, timedOut: 0, sendFailed: 0 };
  return {
    ...contract,
    expectedModelSha256: model,
    status: "completed",
    arm: "control",
    retentionMs: 0,
    backend: "wasm",
    wasmThreads: 1,
    completedInferences: 4,
    storageContainsInput: false,
    unexpectedRequests: 0,
    pageErrors: 0,
    cleanup: "completed",
    finalExpiry: null,
    snapshots: phases.map((phase, i) => ({
      phase,
      modelReady: active[i],
      offscreenDocumentId: docs[i],
      workerTargetIds: workers[i],
      memory: {
        status: "measured",
        scope: "cdp-associated-browser-processes",
        requestedProcessCount: 1,
        missingPids: [],
        rows: [
          { pid: 10, role: "renderer", currentBytes: 100, peakBytes: 120 },
        ],
      },
    })),
    workerObservation: phases.map((phase, i) => ({
      phase,
      status: "complete",
      workers: active[i] ? 1 : 0,
      parentBound: active[i],
      pendingCommands: 0,
      ownedParentSessions: active[i] ? 1 : 0,
      disposed: false,
    })),
    cycles: [1, 2].map((cycle) => ({
      cycle,
      worker: `w${cycle + 1}`,
      document: `doc${cycle + 1}`,
      releaseObservedAfterMs: 60000,
      idleStartedAfterLastInputMs: 1000,
      releaseObservedAfterLastInputMs: 61000,
      releases: { ...releases },
    })),
    observedNotices: [1, 2].map((i) => ({
      documentId: `doc${i}`,
      senderDocumentId: null,
      releases: { ...releases },
    })),
    cleanupPhases: [
      "worker-observer",
      "cdp-session",
      "browser-context",
      "fixture-server",
    ].map((resource) => ({ resource, status: "completed", elapsedMs: 1 })),
  };
}

describe("source-bound default-runtime compatibility acceptance", () => {
  it("accepts separate audit/runtime commits only against the explicit contract", () => {
    expect(validateRuntimeCompatibility(fixture(), contract)).toMatchObject({
      boundedCompatibilityAcceptance: true,
      memoryGrowthAcceptance: false,
      fullM5Acceptance: false,
    });
  });
  it.each([
    "sourceCommit",
    "runtimeSourceCommit",
    "browserVersion",
    "platform",
    "node",
    "modelSha256",
  ] as const)("rejects mismatched %s", (key) => {
    const report = fixture();
    report[key] = "wrong";
    expect(() => validateRuntimeCompatibility(report, contract)).toThrow();
  });
  it("rejects a retained candidate under the default-runtime contract", () => {
    const report = fixture();
    report.retentionMs = 60000;
    expect(() => validateRuntimeCompatibility(report, contract)).toThrow();
  });
  it("rejects missing or unauthenticated retired-document notices", () => {
    const report = fixture();
    report.observedNotices[0]!.documentId = "other";
    expect(() => validateRuntimeCompatibility(report, contract)).toThrow();
  });
  it("rejects a cycle that does not identify the resumed generation", () => {
    const report = fixture();
    report.cycles[1]!.worker = "w1";
    expect(() => validateRuntimeCompatibility(report, contract)).toThrow();
  });
  it("rejects missing memory rather than interpreting it as zero", () => {
    const report = fixture();
    report.snapshots[2]!.memory.rows = [];
    expect(() => validateRuntimeCompatibility(report, contract)).toThrow();
  });
  it("rejects reused Worker generations", () => {
    const report = fixture();
    report.snapshots[5]!.workerTargetIds = ["w1"];
    expect(() => validateRuntimeCompatibility(report, contract)).toThrow();
  });
  it("rejects unknown worker evidence and incomplete cleanup", () => {
    const report = fixture();
    report.workerObservation[2]!.status = "unavailable";
    expect(() => validateRuntimeCompatibility(report, contract)).toThrow();
    const next = fixture();
    next.cleanupPhases[0]!.status = "failed";
    expect(() => validateRuntimeCompatibility(next, contract)).toThrow();
  });
  it("keeps null sender identity explicitly unauthenticated", () => {
    expect(validateRuntimeCompatibility(fixture(), contract)).toMatchObject({
      senderIdentityAuthenticated: false,
      staleNoticeSecurityAcceptance: false,
    });
  });
  it("rejects a release before sixty seconds since the last issued input", () => {
    const report = fixture();
    Object.assign(report.cycles[0]!, {
      releaseObservedAfterMs: 0,
      idleStartedAfterLastInputMs: 0,
      releaseObservedAfterLastInputMs: 0,
    });
    expect(() => validateRuntimeCompatibility(report, contract)).toThrow();
  });
  it("rejects internally inconsistent idle clocks", () => {
    const report = fixture();
    report.cycles[0]!.releaseObservedAfterLastInputMs = 62000;
    expect(() => validateRuntimeCompatibility(report, contract)).toThrow();
  });
  it("rejects disagreement with the expected model hash", () => {
    const report = fixture();
    report.expectedModelSha256 = "d".repeat(64);
    expect(() => validateRuntimeCompatibility(report, contract)).toThrow();
  });
  it.each(["snapshot", "cycle", "notice"])(
    "rejects undeclared private fields in %s",
    (location) => {
      const report = fixture();
      const target =
        location === "snapshot"
          ? report.snapshots[0]!
          : location === "cycle"
            ? report.cycles[0]!
            : report.observedNotices[0]!;
      Object.assign(target, { inputText: "fixture-only" });
      expect(() => validateRuntimeCompatibility(report, contract)).toThrow();
    },
  );
  it("rejects an array-like Worker-ID object", () => {
    const report = fixture();
    Object.assign(report.snapshots[1]!, {
      workerTargetIds: { 0: "w1", length: 1 },
    });
    expect(() => validateRuntimeCompatibility(report, contract)).toThrow();
  });
  it("rejects input persistence and unexpected communication", () => {
    const report = fixture();
    report.storageContainsInput = true;
    expect(() => validateRuntimeCompatibility(report, contract)).toThrow();
    const next = fixture();
    next.unexpectedRequests = 1;
    expect(() => validateRuntimeCompatibility(next, contract)).toThrow();
  });
});
