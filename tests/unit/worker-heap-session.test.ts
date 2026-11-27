import { afterEach, expect, it, vi } from "vitest";
import type { CDPSession } from "@playwright/test";
import { WorkerHeapSession } from "../diagnostics/worker-heap-session";

const heap = {
  usedSize: 100,
  totalSize: 200,
  embedderHeapUsedSize: 0,
  backingStorageSize: 65536,
};
const memory = {
  status: "complete",
  observedCount: 1,
  liveCount: 1,
  totalBytes: 65536,
  byteLengths: [65536],
};
function transport(reply = true) {
  let listener: (event: { sessionId: string; message: string }) => void = () =>
    undefined;
  const root = {
    on: vi.fn((_name, handler) => {
      listener = handler;
    }),
    off: vi.fn(),
    send: vi.fn(
      async (method: string, parameters?: Record<string, unknown>) => {
        if (method === "Target.attachToTarget")
          return { sessionId: "owned-session" };
        if (method === "Target.sendMessageToTarget" && reply) {
          const message = JSON.parse(parameters!.message as string);
          const result =
            message.method === "Runtime.getIsolateId"
              ? { id: "isolate" }
              : message.method === "Runtime.getHeapUsage"
                ? heap
                : { result: { value: memory } };
          listener({
            sessionId: "owned-session",
            message: JSON.stringify({ id: message.id, result }),
          });
        }
        return {};
      },
    ),
  };
  return {
    root,
    emit: (sessionId: string, value: unknown) =>
      listener({ sessionId, message: JSON.stringify(value) }),
    typed: root as unknown as Pick<CDPSession, "send" | "on" | "off">,
  };
}
afterEach(() => vi.useRealTimers());

it("adopts an already owned child session without attaching it again", async () => {
  const fake = transport();
  const session = WorkerHeapSession.adopt(fake.typed, "owned-session");
  expect(await session.read()).toMatchObject({ isolateId: "isolate" });
  expect(
    fake.root.send.mock.calls.some(
      ([method]) => method === "Target.attachToTarget",
    ),
  ).toBe(false);
  await session.close();
});

it("rejects invalid backing storage rather than treating it as zero", async () => {
  const fake = transport(false);
  const session = await WorkerHeapSession.attach(fake.typed, "owned-worker");
  const result = session.read().catch((error: Error) => error.message);
  fake.emit("owned-session", { id: 0, result: { id: "isolate" } });
  await vi.waitFor(() => expect(fake.root.send).toHaveBeenCalledTimes(3));
  fake.emit("owned-session", {
    id: 1,
    result: { ...heap, backingStorageSize: -1 },
  });
  expect(await result).toBe("invalid-heap-metadata");
  await session.close();
});

it("reads numeric isolate/heap/linear memory metadata and detaches its own session", async () => {
  const fake = transport();
  const session = await WorkerHeapSession.attach(fake.typed, "owned-worker");
  expect(await session.read()).toEqual({
    isolateId: "isolate",
    heap,
    wasm: memory,
  });
  await session.close();
  expect(fake.root.send).toHaveBeenCalledWith("Target.attachToTarget", {
    targetId: "owned-worker",
    flatten: false,
  });
  expect(fake.root.send).toHaveBeenCalledWith("Target.detachFromTarget", {
    sessionId: "owned-session",
  });
  expect(fake.root.off).toHaveBeenCalledOnce();
});

it("ignores foreign sessions and times out without leaking a listener", async () => {
  vi.useFakeTimers();
  const fake = transport(false);
  const session = await WorkerHeapSession.attach(fake.typed, "owned-worker");
  const result = session.read().catch(() => "timed-out");
  fake.emit("foreign", { id: 0, result: { id: "wrong-isolate" } });
  await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toBe("timed-out");
  await session.close();
  expect(fake.root.off).toHaveBeenCalledOnce();
});

it("rejects protocol errors without retaining their contents and cancels pending reads on close", async () => {
  const fake = transport(false);
  const session = await WorkerHeapSession.attach(fake.typed, "owned-worker");
  const result = session.read().catch((error: Error) => error.message);
  fake.emit("owned-session", {
    id: 0,
    error: { message: "private fixture text" },
  });
  expect(await result).toBe("heap-command-failed");
  const pending = session.read().catch((error: Error) => error.message);
  await session.close();
  expect(await pending).toBe("heap-session-closed");
  await expect(session.read()).rejects.toThrow("heap-session-closed");
});
