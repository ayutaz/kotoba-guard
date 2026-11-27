import { describe, expect, it } from "vitest";
import {
  ScopedWorkerLedger,
  type ScopedWorkerLedgerSnapshot,
} from "../e2e/scoped-worker-ledger";

const PARENT_TARGET = "parent-target";
const PARENT_SESSION = "parent-session";
const WORKER_URL = "chrome-extension://test/worker.js";

function attached(
  targetId: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): unknown {
  const { waitingForDebugger, ...targetOverrides } = overrides;
  return {
    method: "Target.attachedToTarget",
    params: {
      sessionId,
      targetInfo: {
        targetId,
        type: "worker",
        url: WORKER_URL,
        ...targetOverrides,
      },
      waitingForDebugger: waitingForDebugger ?? false,
    },
  };
}

function ingest(
  ledger: ScopedWorkerLedger,
  message: unknown,
  sessionId = PARENT_SESSION,
): void {
  ledger.ingest(sessionId, message);
}

function snapshot(ledger: ScopedWorkerLedger): ScopedWorkerLedgerSnapshot {
  return ledger.snapshot();
}

describe("ScopedWorkerLedger", () => {
  it("does not treat an opened parent with no observations as complete", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    expect(snapshot(ledger).status).toBe("unavailable");

    ingest(ledger, attached("worker", "worker-session"));
    expect(snapshot(ledger).status).toBe("complete");
  });

  it("records only valid workers owned by the current parent session", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, attached("worker-b", "worker-session-b"));
    ingest(ledger, attached("worker-a", "worker-session-a"));

    expect(snapshot(ledger)).toEqual({
      status: "complete",
      parentTargetId: PARENT_TARGET,
      workerTargetIds: ["worker-a", "worker-b"],
      workerSessionIds: ["worker-session-a", "worker-session-b"],
    });
  });

  it("deduplicates identical attachment events and rejects the 257th worker", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, attached("worker-1", "session-1"));
    ingest(ledger, attached("worker-1", "session-1"));
    for (let index = 2; index <= 256; index += 1)
      ingest(ledger, attached(`worker-${index}`, `session-${index}`));
    ingest(ledger, attached("worker-257", "session-257"));

    expect(snapshot(ledger).workerTargetIds).toHaveLength(256);
    expect(snapshot(ledger).status).toBe("unavailable");
  });

  it("retires workers when the parent session is replaced", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, attached("old-worker", "old-session"));
    ledger.open("new-parent", "new-parent-session");
    ingest(ledger, attached("new-worker", "new-session"), "new-parent-session");
    ingest(ledger, attached("old-worker", "old-session"), "new-parent-session");

    expect(snapshot(ledger)).toEqual({
      status: "complete",
      parentTargetId: "new-parent",
      workerTargetIds: ["new-worker"],
      workerSessionIds: ["new-session"],
    });
  });

  it("rejects foreign sessions, URLs, explicit parents, and paused workers", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, attached("foreign-session", "foreign"), "foreign-parent");
    ingest(
      ledger,
      attached("foreign-url", "foreign-url-session", {
        url: "chrome-extension://other/worker.js",
      }),
    );
    ingest(
      ledger,
      attached("foreign-parent", "foreign-parent-session", {
        parentId: "other-parent",
      }),
    );
    ingest(
      ledger,
      attached("paused", "paused-session", {
        waitingForDebugger: true,
      }),
    );

    expect(snapshot(ledger)).toEqual({
      status: "unavailable",
      parentTargetId: PARENT_TARGET,
      workerTargetIds: [],
      workerSessionIds: [],
    });
  });

  it("rejects contradictory parent bindings from both CDP fields", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, {
      method: "Target.attachedToTarget",
      params: {
        sessionId: "contradictory-session",
        parentId: PARENT_TARGET,
        waitingForDebugger: false,
        targetInfo: {
          targetId: "contradictory-worker",
          type: "worker",
          url: WORKER_URL,
          parentId: "other-parent",
        },
      },
    });

    expect(snapshot(ledger)).toMatchObject({
      status: "unavailable",
      workerTargetIds: [],
      workerSessionIds: [],
    });
  });

  it("fails closed when an owned worker has contradictory parent bindings", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, {
      method: "Target.attachedToTarget",
      params: {
        sessionId: "contradictory-session",
        parentId: PARENT_TARGET,
        waitingForDebugger: false,
        targetInfo: {
          targetId: "contradictory-worker",
          type: "worker",
          url: WORKER_URL,
          parentId: "other-parent",
        },
      },
    });

    expect(snapshot(ledger).status).toBe("unavailable");
  });

  it("fails closed when a known worker is reattached with an invalid identity", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, attached("worker", "worker-session"));
    ingest(
      ledger,
      attached("worker", "replacement-session", {
        type: "shared_worker",
      }),
    );

    expect(snapshot(ledger)).toMatchObject({
      status: "unavailable",
      workerTargetIds: ["worker"],
      workerSessionIds: ["worker-session"],
    });
  });

  it("fails closed on a malformed target change from the parent session", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, {
      method: "Target.targetInfoChanged",
      params: {},
    });

    expect(snapshot(ledger).status).toBe("unavailable");
  });

  it("does not add unknown targetCreated or targetInfoChanged targets", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, {
      method: "Target.targetCreated",
      params: {
        targetInfo: {
          targetId: "unknown-created",
          type: "worker",
          url: WORKER_URL,
        },
      },
    });
    ingest(ledger, {
      method: "Target.targetInfoChanged",
      params: {
        targetInfo: {
          targetId: "unknown-changed",
          type: "worker",
          url: WORKER_URL,
        },
      },
    });
    expect(snapshot(ledger).workerTargetIds).toEqual([]);
  });

  it("marks a known worker unavailable when its changed URL is invalid", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, attached("worker", "worker-session"));
    ingest(ledger, {
      method: "Target.targetInfoChanged",
      params: {
        targetInfo: {
          targetId: "worker",
          type: "worker",
          url: "chrome-extension://other/worker.js",
        },
      },
    });
    expect(snapshot(ledger)).toEqual({
      status: "unavailable",
      parentTargetId: PARENT_TARGET,
      workerTargetIds: ["worker"],
      workerSessionIds: ["worker-session"],
    });
  });

  it("distinguishes worker detach from confirmed worker destruction", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, attached("worker", "worker-session"));
    ingest(ledger, {
      method: "Target.detachedFromTarget",
      params: { sessionId: "worker-session" },
    });
    expect(snapshot(ledger)).toMatchObject({
      status: "unavailable",
      workerTargetIds: ["worker"],
      workerSessionIds: [],
    });

    ledger.targetDestroyed("worker");
    expect(snapshot(ledger)).toMatchObject({
      status: "complete",
      workerTargetIds: [],
      workerSessionIds: [],
    });
  });

  it("handles direct worker and parent destruction without stale ownership", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, attached("worker", "worker-session"));
    ledger.targetDestroyed("worker");
    expect(snapshot(ledger).status).toBe("complete");
    ingest(ledger, attached("worker", "worker-session"));
    expect(snapshot(ledger).workerTargetIds).toEqual([]);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, attached("worker", "worker-session"));
    ledger.targetDestroyed(PARENT_TARGET);
    expect(snapshot(ledger)).toEqual({
      status: "complete",
      parentTargetId: null,
      workerTargetIds: [],
      workerSessionIds: [],
    });
  });

  it("retains hard failure after the last worker is destroyed", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, attached("worker", "worker-session"));
    ingest(
      ledger,
      attached("paused", "paused-session", { waitingForDebugger: true }),
    );
    ledger.targetDestroyed("worker");

    expect(snapshot(ledger)).toMatchObject({
      status: "unavailable",
      parentTargetId: PARENT_TARGET,
      workerTargetIds: [],
      workerSessionIds: [],
    });
  });

  it("marks the active parent unavailable when it detaches", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, attached("worker", "worker-session"));
    ledger.parentDetached(PARENT_SESSION);
    expect(snapshot(ledger)).toEqual({
      status: "unavailable",
      parentTargetId: null,
      workerTargetIds: [],
      workerSessionIds: [],
    });
  });

  it("fails closed on malformed events without throwing raw errors", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    expect(() => ingest(ledger, null)).not.toThrow();
    expect(() =>
      ingest(ledger, { method: "Target.attachedToTarget" }),
    ).not.toThrow();
    expect(snapshot(ledger).status).toBe("unavailable");
  });

  it("fails closed when the runtime worker URL input is invalid", () => {
    const ledger = new ScopedWorkerLedger(null as unknown as string);
    expect(() => ledger.open(PARENT_TARGET, PARENT_SESSION)).not.toThrow();
    expect(snapshot(ledger)).toMatchObject({
      status: "unavailable",
      parentTargetId: PARENT_TARGET,
      workerTargetIds: [],
      workerSessionIds: [],
    });
  });

  it("rejects conflicting target and session bindings", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, attached("worker", "session-a"));
    ingest(ledger, attached("worker", "session-b"));
    expect(snapshot(ledger).status).toBe("unavailable");
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, attached("worker-a", "session-c"));
    ingest(ledger, attached("worker-b", "session-c"));
    expect(snapshot(ledger).status).toBe("unavailable");
  });

  it("ignores late old target destruction after parent replacement", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, attached("old-worker", "old-session"));
    ledger.open("new-parent", "new-session");
    ledger.targetDestroyed("old-worker");
    expect(snapshot(ledger)).toEqual({
      status: "unavailable",
      parentTargetId: "new-parent",
      workerTargetIds: [],
      workerSessionIds: [],
    });
  });

  it("invalidates and disposes without allowing resurrection", () => {
    const ledger = new ScopedWorkerLedger(WORKER_URL);
    ledger.open(PARENT_TARGET, PARENT_SESSION);
    ingest(ledger, attached("worker", "worker-session"));
    ledger.invalidate();
    expect(snapshot(ledger).status).toBe("unavailable");
    ledger.dispose();
    ledger.open("new-parent", "new-session");
    ingest(ledger, attached("new-worker", "new-worker-session"), "new-session");
    expect(snapshot(ledger)).toEqual({
      status: "unavailable",
      parentTargetId: null,
      workerTargetIds: [],
      workerSessionIds: [],
    });
  });
});
