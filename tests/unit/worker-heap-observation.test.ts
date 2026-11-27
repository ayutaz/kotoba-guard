import { expect, it, vi } from "vitest";
import type { CDPSession } from "@playwright/test";
import { observeWorkerMemory } from "../diagnostics/worker-heap-observation";

function ports(
  options: {
    readFails?: boolean;
    zeroMemory?: boolean;
    childCloseFails?: boolean;
    parentCloseFails?: boolean;
    missingParentBinding?: boolean;
    lateInvalidBinding?: boolean;
  } = {},
) {
  let active = 1,
    detached = false,
    bindingValid = true;
  const parent = {
    transport: {} as CDPSession,
    observeWorker: vi.fn(async () => ({
      sessionId: "child",
      targetId: "worker",
      explicitParentId: options.missingParentBinding ? null : "parent",
    })),
    metadata: () => ({
      parentTargetId: "parent",
      parentSessionId: "parent-session",
      workerTargetId: "worker",
      workerSessionId: "child",
      explicitParentId: options.missingParentBinding ? null : "parent",
      relationship: "parent-session-attachedToTarget",
      urlMatchesExpected: true,
      waitingForDebugger: false,
      notificationCount: 1,
      bindingValid,
      activeChildren: active,
      detachedChildren: detached ? 1 : 0,
      childDetachObserved: detached,
    }),
    waitForChildrenDetached: vi.fn(async () => undefined),
    detachChildren: vi.fn(async () => {
      active = 0;
      detached = true;
      if (options.lateInvalidBinding) bindingValid = false;
    }),
    close: vi.fn(async () => {
      if (options.parentCloseFails) throw new Error("private input");
    }),
  };
  const child = {
    read: vi.fn(async () => {
      if (options.readFails) throw new Error("private input");
      return {
        isolateId: "isolate",
        heap: {
          usedSize: 100,
          totalSize: 200,
          embedderHeapUsedSize: 0,
          backingStorageSize: 0,
        },
        wasm: {
          status: "complete",
          observedCount: options.zeroMemory ? 0 : 1,
          liveCount: options.zeroMemory ? 0 : 1,
          totalBytes: options.zeroMemory ? 0 : 65536,
          byteLengths: options.zeroMemory ? [] : [65536],
        },
      };
    }),
    close: vi.fn(async () => {
      if (options.childCloseFails) throw new Error("private input");
      active = 0;
      detached = true;
      if (options.lateInvalidBinding) bindingValid = false;
    }),
  };
  return {
    parent,
    child,
    dependencies: {
      attachParent: vi.fn(async () => parent),
      adoptWorker: vi.fn(() => child),
    },
  };
}
it("reads one owned worker and releases child and parent before returning", async () => {
  const fake = ports();
  const result = await observeWorkerMemory(
    {} as CDPSession,
    "owned",
    fake.dependencies,
  );
  expect(result.status).toBe("completed");
  expect(result.heap?.wasm.totalBytes).toBe(65536);
  expect(result.bindingBefore?.activeChildren).toBe(1);
  expect(result.bindingAfter?.activeChildren).toBe(0);
  expect(result.cleanupPhases.map((value) => value.resource)).toEqual([
    "worker-session",
    "parent-session",
  ]);
  expect(fake.parent.close).toHaveBeenCalledOnce();
});
it("preserves a failed read and cleans up without retaining the error contents", async () => {
  const fake = ports({ readFails: true });
  const result = await observeWorkerMemory(
    {} as CDPSession,
    "owned",
    fake.dependencies,
  );
  expect(result.status).toBe("failed");
  expect(result.heap).toBeNull();
  expect(fake.parent.close).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain("private input");
});
it("does not accept an unobserved model memory as zero", async () => {
  const fake = ports({ zeroMemory: true });
  const result = await observeWorkerMemory(
    {} as CDPSession,
    "owned",
    fake.dependencies,
  );
  expect(result.status).toBe("failed");
  expect(result.stage).toBe("validate-memory");
});
it("keeps child cleanup failure while attempting residual children and parent", async () => {
  const fake = ports({ childCloseFails: true });
  const result = await observeWorkerMemory(
    {} as CDPSession,
    "owned",
    fake.dependencies,
  );
  expect(result.status).toBe("failed");
  expect(fake.parent.detachChildren).toHaveBeenCalledOnce();
  expect(fake.parent.close).toHaveBeenCalledOnce();
  expect(result.cleanupPhases[0]?.status).toBe("failed");
});
it("does not convert parent cleanup failure into a completed observation", async () => {
  const fake = ports({ parentCloseFails: true });
  const result = await observeWorkerMemory(
    {} as CDPSession,
    "owned",
    fake.dependencies,
  );
  expect(result.status).toBe("failed");
  expect(result.cleanupPhases.at(-1)?.status).toBe("failed");
});

it("stops before another model-stage operation when the observation deadline is reached", async () => {
  const fake = ports();
  let checks = 0;
  const result = await observeWorkerMemory({} as CDPSession, "owned", {
    ...fake.dependencies,
    checkBudget: () => {
      if (++checks === 2) throw new Error("deadline");
    },
  });
  expect(result.status).toBe("failed");
  expect(fake.dependencies.adoptWorker).not.toHaveBeenCalled();
  expect(fake.child.read).not.toHaveBeenCalled();
  expect(fake.parent.close).toHaveBeenCalledOnce();
});

it("requires an explicit matching parent ID for model-worker evidence", async () => {
  const fake = ports({ missingParentBinding: true });
  const result = await observeWorkerMemory(
    {} as CDPSession,
    "owned",
    fake.dependencies,
  );
  expect(result.bindingBefore?.explicitParentId).toBeNull();
  expect(result.status).toBe("failed");
});
it("rejects a binding invalidated after the heap read", async () => {
  const fake = ports({ lateInvalidBinding: true });
  const result = await observeWorkerMemory(
    {} as CDPSession,
    "owned",
    fake.dependencies,
  );
  expect(result.bindingAfter?.bindingValid).toBe(false);
  expect(result.status).toBe("failed");
});
