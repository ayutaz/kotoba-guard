import { afterEach, expect, it, vi } from "vitest";
import type { CDPSession } from "@playwright/test";
import { ParentWorkerSession } from "../diagnostics/parent-worker-session";
import { WorkerHeapSession } from "../diagnostics/worker-heap-session";

type Event = { sessionId: string; message: string };
function fakeRoot(
  options: {
    badUrl?: boolean;
    paused?: boolean;
    duplicate?: boolean;
    foreign?: boolean;
    missingParent?: boolean;
    silent?: boolean;
    detachTiming?: "late" | "missing" | "foreign";
  } = {},
) {
  const handlers = new Set<(event: Event) => void>();
  const emit = (value: unknown, sessionId = "parent-session") => {
    for (const handler of handlers)
      handler({ sessionId, message: JSON.stringify(value) });
  };
  const child = (sessionId = "child-session", targetId = "worker-target") => ({
    method: "Target.attachedToTarget",
    params: {
      sessionId,
      waitingForDebugger: options.paused ?? false,
      targetInfo: {
        targetId,
        type: "worker",
        url: options.badUrl ? "" : "chrome-extension://owned/worker.js",
        parentId: "parent-target",
      },
    },
  });
  const send = vi.fn(
    async (method: string, parameters?: Record<string, unknown>) => {
      if (method === "Target.getTargets")
        return {
          targetInfos: options.missingParent
            ? []
            : [
                {
                  targetId: "parent-target",
                  type: "other",
                  url: "chrome-extension://owned/offscreen.html",
                },
              ],
        };
      if (method === "Target.attachToTarget")
        return { sessionId: "parent-session" };
      if (method === "Target.sendMessageToTarget") {
        const m = JSON.parse(parameters!.message as string);
        if (options.silent) return {};
        if (m.method === "Target.setAutoAttach") {
          emit(child(), options.foreign ? "foreign-session" : "parent-session");
          if (options.duplicate) emit(child("second-session", "second-worker"));
        }
        if (m.method === "Target.sendMessageToTarget") {
          const inner = JSON.parse(m.params.message);
          const result =
            inner.method === "Runtime.getIsolateId"
              ? { id: "isolate" }
              : inner.method === "Runtime.getHeapUsage"
                ? {
                    usedSize: 100,
                    totalSize: 200,
                    embedderHeapUsedSize: 0,
                    backingStorageSize: 65536,
                  }
                : {
                    result: {
                      value: {
                        status: "complete",
                        observedCount: 1,
                        liveCount: 1,
                        totalBytes: 65536,
                        byteLengths: [65536],
                      },
                    },
                  };
          emit({
            method: "Target.receivedMessageFromTarget",
            params: {
              sessionId: m.params.sessionId,
              message: JSON.stringify({ id: inner.id, result }),
            },
          });
        }
        if (
          m.method === "Target.detachFromTarget" &&
          options.detachTiming !== "missing"
        ) {
          const notification = {
            method: "Target.detachedFromTarget",
            params: {
              sessionId:
                options.detachTiming === "foreign"
                  ? "foreign-child"
                  : m.params.sessionId,
              targetId: "worker-target",
            },
          };
          if (options.detachTiming === "late")
            setTimeout(() => emit(notification), 1);
          else emit(notification);
        }
        emit({ id: m.id, result: {} });
      }
      return {};
    },
  );
  const root = {
    send,
    on: vi.fn((_event: string, handler: (event: Event) => void) =>
      handlers.add(handler),
    ),
    off: vi.fn((_event: string, handler: (event: Event) => void) =>
      handlers.delete(handler),
    ),
  };
  return {
    root: root as unknown as Pick<CDPSession, "send" | "on" | "off">,
    send,
    emit,
    handlers,
  };
}
afterEach(() => vi.useRealTimers());

it("adopts the parent's immediate non-flat worker session and tunnels reads without a second attach", async () => {
  const fake = fakeRoot();
  const parent = await ParentWorkerSession.attach(fake.root, "owned");
  const selected = await parent.observeWorker();
  const child = WorkerHeapSession.adopt(parent.transport, selected.sessionId);
  expect(await child.read()).toMatchObject({
    isolateId: "isolate",
    wasm: { totalBytes: 65536 },
  });
  expect(
    fake.send.mock.calls.filter(
      ([method]) => method === "Target.attachToTarget",
    ),
  ).toEqual([
    ["Target.attachToTarget", { targetId: "parent-target", flatten: false }],
  ]);
  expect(parent.metadata()).toMatchObject({
    parentTargetId: "parent-target",
    parentSessionId: "parent-session",
    workerTargetId: "worker-target",
    workerSessionId: "child-session",
    activeChildren: 1,
    childDetachObserved: false,
  });
  const messages = fake.send.mock.calls
    .filter(([method]) => method === "Target.sendMessageToTarget")
    .map(([, p]) => JSON.parse(p!.message as string));
  expect(messages[0]).toMatchObject({
    method: "Target.setAutoAttach",
    params: { autoAttach: true, flatten: false, waitForDebuggerOnStart: false },
  });
  expect(
    messages.filter((m) => m.method === "Target.sendMessageToTarget"),
  ).toHaveLength(3);
  await child.close();
  expect(parent.metadata()).toMatchObject({
    activeChildren: 0,
    childDetachObserved: true,
  });
  await parent.close();
  expect(fake.handlers.size).toBe(0);
});

it("fails closed for unknown URL, pause, multiple workers and missing parent", async () => {
  for (const options of [
    { badUrl: true },
    { paused: true },
    { duplicate: true },
  ]) {
    const fake = fakeRoot(options);
    const parent = await ParentWorkerSession.attach(fake.root, "owned");
    await expect(parent.observeWorker()).rejects.toThrow(
      "invalid-parent-worker-binding",
    );
    await parent.close();
    expect(fake.handlers.size).toBe(0);
  }
  const fake = fakeRoot({ missingParent: true });
  await expect(ParentWorkerSession.attach(fake.root, "owned")).rejects.toThrow(
    "invalid-calibration-parent",
  );
  expect(fake.send).toHaveBeenCalledOnce();
});

it("ignores another parent's wrapper and bounds the child notification wait", async () => {
  vi.useFakeTimers();
  const fake = fakeRoot({ foreign: true });
  const parent = await ParentWorkerSession.attach(fake.root, "owned");
  const result = parent.observeWorker().catch((error: Error) => error.message);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toBe("parent-worker-notification-timeout");
  await parent.close();
  expect(fake.handlers.size).toBe(0);
});

it("bounds a silent parent command and closes pending requests/listeners", async () => {
  vi.useFakeTimers();
  const fake = fakeRoot({ silent: true });
  const parent = await ParentWorkerSession.attach(fake.root, "owned");
  const result = parent.observeWorker().catch((error: Error) => error.message);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toBe("parent-command-timeout");
  await parent.close();
  expect(fake.handlers.size).toBe(0);
});

it("rejects transport commands addressed to another child session", async () => {
  const fake = fakeRoot();
  const parent = await ParentWorkerSession.attach(fake.root, "owned");
  await parent.observeWorker();
  await expect(
    parent.transport.send("Target.detachFromTarget", { sessionId: "foreign" }),
  ).rejects.toThrow("parent-child-session-mismatch");
  await parent.close();
});

it("retains the observed pause state rather than recording a false success", async () => {
  const fake = fakeRoot({ paused: true });
  const parent = await ParentWorkerSession.attach(fake.root, "owned");
  await expect(parent.observeWorker()).rejects.toThrow();
  expect(parent.metadata().waitingForDebugger).toBe(true);
  await parent.close();
});

it("waits for a child detach notification after the command response", async () => {
  vi.useFakeTimers();
  const fake = fakeRoot({ detachTiming: "late" });
  const parent = await ParentWorkerSession.attach(fake.root, "owned");
  const selected = await parent.observeWorker();
  const child = WorkerHeapSession.adopt(parent.transport, selected.sessionId);
  const notified = parent.waitForChildrenDetached();
  await child.close();
  expect(parent.metadata().activeChildren).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await notified;
  expect(parent.metadata()).toMatchObject({
    activeChildren: 0,
    childDetachObserved: true,
  });
  await parent.close();
});

it("times out for missing and foreign child detach notifications", async () => {
  vi.useFakeTimers();
  for (const detachTiming of ["missing", "foreign"] as const) {
    const fake = fakeRoot({ detachTiming });
    const parent = await ParentWorkerSession.attach(fake.root, "owned");
    const selected = await parent.observeWorker();
    const child = WorkerHeapSession.adopt(parent.transport, selected.sessionId);
    const notified = parent
      .waitForChildrenDetached()
      .catch((error: Error) => error.message);
    await child.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await notified).toBe("parent-child-detach-timeout");
    expect(parent.metadata()).toMatchObject({
      activeChildren: 1,
      childDetachObserved: false,
    });
    await parent.close();
  }
});

it("explicitly detaches auto-attached children even when binding validation failed", async () => {
  const fake = fakeRoot({ duplicate: true });
  const parent = await ParentWorkerSession.attach(fake.root, "owned");
  await expect(parent.observeWorker()).rejects.toThrow();
  await parent.detachChildren();
  expect(parent.metadata()).toMatchObject({
    activeChildren: 0,
    detachedChildren: 2,
    bindingValid: false,
  });
  await parent.close();
});

it("permits one explicit residual-child cleanup after preserving a failed detach wait", async () => {
  vi.useFakeTimers();
  const options: { detachTiming?: "missing" } = { detachTiming: "missing" };
  const fake = fakeRoot(options);
  const parent = await ParentWorkerSession.attach(fake.root, "owned");
  const selected = await parent.observeWorker();
  const child = WorkerHeapSession.adopt(parent.transport, selected.sessionId);
  const first = parent
    .waitForChildrenDetached()
    .catch((error: Error) => error.message);
  await child.close();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await first).toBe("parent-child-detach-timeout");
  delete options.detachTiming;
  await parent.detachChildren();
  expect(parent.metadata()).toMatchObject({
    activeChildren: 0,
    childDetachObserved: true,
  });
  await parent.close();
});
