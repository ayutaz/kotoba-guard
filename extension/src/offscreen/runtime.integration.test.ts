import { afterEach, describe, expect, it, vi } from "vitest";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: unknown[] = [];
  readonly terminate = vi.fn();

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

function installChrome() {
  const listeners: Array<(...args: unknown[]) => unknown> = [];
  const sent: unknown[] = [];
  const onMessage = {
    addListener: (listener: (...args: unknown[]) => unknown) =>
      listeners.push(listener),
  };
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("crypto", { randomUUID: () => INSTANCE_ID });
  vi.stubGlobal("chrome", {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
      onMessage,
      sendMessage: (message: unknown) => {
        sent.push(message);
        if (
          message &&
          typeof message === "object" &&
          (message as { type?: unknown }).type === "offscreen-identify"
        )
          return Promise.resolve({ ok: true, documentId: "document-1" });
        return Promise.resolve({ ok: true, closed: true });
      },
    },
  });
  return { listeners, sent };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});

describe("offscreen runtime with the real WorkerBroker", () => {
  it("keeps the session usable during release, then retires after retention expiry", async () => {
    vi.useFakeTimers();
    const { listeners, sent } = installChrome();
    const { installOffscreenRuntime } = await import("./runtime");
    installOffscreenRuntime({ retainWorkerMs: 60_000 });
    const listener = listeners[0]!;
    const sender = { id: EXTENSION_ID };
    const first = vi.fn();
    listener({ type: "offscreen-detect", text: "一" }, sender, first);
    const worker = FakeWorker.instances[0]!;
    expect(worker.messages).toEqual([{ id: 0, type: "detect", text: "一" }]);
    worker.emit({ id: 0, ok: true, result: {} });
    await Promise.resolve();
    expect(first).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(worker.messages).toContainEqual({
      type: "release-session",
      releaseId: 0,
    });
    const statusDuringRelease = vi.fn();
    listener({ type: "offscreen-status" }, sender, statusDuringRelease);
    expect(statusDuringRelease).toHaveBeenCalledWith(
      expect.objectContaining({ ready: false, retiring: false }),
    );

    const second = vi.fn();
    const third = vi.fn();
    listener({ type: "offscreen-detect", text: "二" }, sender, second);
    listener({ type: "offscreen-detect", text: "三" }, sender, third);
    const busy = vi.fn();
    expect(
      listener({ type: "offscreen-detect", text: "四" }, sender, busy),
    ).toBe(false);
    expect(busy).toHaveBeenCalledWith({ ok: false, code: "busy" });
    expect(second).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();

    worker.emit({ type: "session-released", releaseId: 0, ok: true });
    await Promise.resolve();
    expect(worker.messages).toContainEqual({
      id: 1,
      type: "detect",
      text: "二",
    });
    expect(worker.messages).toContainEqual({
      id: 2,
      type: "detect",
      text: "三",
    });
    worker.emit({ id: 1, ok: true, result: {} });
    worker.emit({ id: 2, ok: true, result: {} });
    await Promise.resolve();
    expect(second).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(worker.messages).toContainEqual({
      type: "release-session",
      releaseId: 1,
    });
    worker.emit({ type: "session-released", releaseId: 1, ok: true });
    await vi.advanceTimersByTimeAsync(60_000);
    const finalStatus = vi.fn();
    listener({ type: "offscreen-status" }, sender, finalStatus);
    expect(finalStatus).toHaveBeenCalledWith(
      expect.objectContaining({ ready: false, retiring: true }),
    );
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(sent).toContainEqual({
      type: "offscreen-identify",
      instanceId: INSTANCE_ID,
    });
    expect(sent).toContainEqual({
      type: "offscreen-idle",
      documentId: "document-1",
      instanceId: INSTANCE_ID,
      releases: { completed: 2, failed: 0, timedOut: 0, sendFailed: 0 },
    });
    expect(JSON.stringify(sent)).not.toContain("一");
    expect(JSON.stringify(sent)).not.toContain("二");
    expect(JSON.stringify(sent)).not.toContain("三");
  });
});
