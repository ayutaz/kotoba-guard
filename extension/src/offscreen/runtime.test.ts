import { afterEach, describe, expect, it, vi } from "vitest";

const { WorkerBroker } = vi.hoisted(() => ({
  WorkerBroker: vi.fn(),
}));

vi.mock("./broker", () => ({ WorkerBroker }));

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

function setup() {
  const listeners: Array<(...args: unknown[]) => unknown> = [];
  const addListener = vi.fn((listener: (...args: unknown[]) => unknown) => {
    listeners.push(listener);
  });
  const sendMessage = vi.fn((message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "offscreen-identify"
    )
      return Promise.resolve({ ok: true, documentId: "current" });
    return Promise.resolve({ ok: true, closed: false });
  });
  vi.stubGlobal("Worker", class {});
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => INSTANCE_ID) });
  vi.stubGlobal("chrome", {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
      onMessage: { addListener },
      sendMessage,
    },
  });
  const broker = {
    ready: false,
    size: 0,
    releaseCounts: { completed: 0, failed: 0, timedOut: 0, sendFailed: 0 },
    request: vi.fn(),
  };
  WorkerBroker.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, broker);
  });
  return { addListener, listeners, sendMessage, broker };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("installOffscreenRuntime", () => {
  it("passes the default and explicit retention values to WorkerBroker", async () => {
    const first = setup();
    const { installOffscreenRuntime } = await import("./runtime");
    installOffscreenRuntime();
    expect(WorkerBroker).toHaveBeenCalledWith(
      expect.any(Function),
      60_000,
      60_000,
      expect.any(Function),
      0,
    );
    expect(first.addListener).toHaveBeenCalledOnce();

    const second = setup();
    installOffscreenRuntime({ retainWorkerMs: 60_000 });
    expect(WorkerBroker).toHaveBeenLastCalledWith(
      expect.any(Function),
      60_000,
      60_000,
      expect.any(Function),
      60_000,
    );
    expect(second.addListener).toHaveBeenCalledOnce();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 60_001, 1.5])(
    "rejects invalid retention %s before creating broker/listeners",
    async (retainWorkerMs) => {
      const { addListener } = setup();
      const { installOffscreenRuntime } = await import("./runtime");

      expect(() => installOffscreenRuntime({ retainWorkerMs })).toThrow(
        "offscreen-retain-worker-invalid",
      );
      expect(WorkerBroker).not.toHaveBeenCalled();
      expect(addListener).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate installation without adding listeners or workers", async () => {
    const { addListener } = setup();
    const { installOffscreenRuntime } = await import("./runtime");
    installOffscreenRuntime();

    expect(() => installOffscreenRuntime()).toThrow(
      "offscreen-runtime-already-installed",
    );
    expect(addListener).toHaveBeenCalledOnce();
    expect(WorkerBroker).toHaveBeenCalledOnce();
  });

  it("retains retirement and rejects an unauthorized sender", async () => {
    vi.useFakeTimers();
    const { listeners, sendMessage } = setup();
    const { installOffscreenRuntime } = await import("./runtime");
    installOffscreenRuntime();
    const onIdle = WorkerBroker.mock.calls[0]?.[3] as () => void;
    onIdle();
    const status = vi.fn();
    listeners[0]?.({ type: "offscreen-status" }, { id: EXTENSION_ID }, status);
    expect(status).toHaveBeenCalledWith(
      expect.objectContaining({ retiring: true }),
    );
    const denied = vi.fn();
    expect(
      listeners[0]?.(
        { type: "offscreen-status" },
        { id: EXTENSION_ID, url: "https://example.test/" },
        denied,
      ),
    ).toBe(false);
    expect(denied).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "offscreen-identify",
      instanceId: INSTANCE_ID,
    });
    vi.useRealTimers();
  });
});
