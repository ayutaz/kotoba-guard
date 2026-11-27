import { afterEach, describe, expect, it, vi } from "vitest";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_INSTANCE_ID = "22222222-2222-4222-8222-222222222222";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  constructor() {
    FakeWorker.instances.push(this);
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }
}

function hook() {
  const listeners: Array<(...args: unknown[]) => unknown> = [];
  return {
    listeners,
    addListener: (listener: (...args: unknown[]) => unknown) =>
      listeners.push(listener),
  };
}

async function loadOffscreen(
  instanceId = INSTANCE_ID,
  provideRandomUuid = true,
) {
  FakeWorker.instances = [];
  const onMessage = hook();
  const randomUUID = vi.fn().mockReturnValue(instanceId);
  const sendMessage = vi.fn().mockResolvedValue({ ok: true });
  const identify = vi.fn().mockResolvedValue({
    ok: true,
    documentId: "current",
  });
  const runtimeSendMessage = vi.fn((message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "offscreen-identify"
    )
      return identify(message);
    return sendMessage(message);
  });
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("crypto", provideRandomUuid ? { randomUUID } : {});
  vi.stubGlobal("chrome", {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
      onMessage,
      sendMessage: runtimeSendMessage,
    },
  });
  vi.resetModules();
  await import("./offscreen");
  return {
    listener: onMessage.listeners[0]!,
    sendMessage,
    identify,
    runtimeSendMessage,
    randomUUID,
    instanceId,
  };
}

const sender = { id: EXTENSION_ID };

describe("offscreen entry message boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("rejects direct detect and status calls from popup and options without creating a Worker", async () => {
    const { listener } = await loadOffscreen();
    for (const name of ["popup.html", "options.html", "other.html"])
      for (const type of ["offscreen-detect", "offscreen-status"]) {
        const response = vi.fn();
        expect(
          listener(
            { type, text: "本文" },
            {
              id: EXTENSION_ID,
              url: `chrome-extension://${EXTENSION_ID}/${name}`,
            },
            response,
          ),
        ).toBe(false);
        expect(response).not.toHaveBeenCalled();
      }
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("assigns an immutable UUID marker to each module generation", async () => {
    const first = await loadOffscreen(INSTANCE_ID);
    const firstStatus = vi.fn();
    first.listener({ type: "offscreen-status" }, sender, firstStatus);
    expect(first.randomUUID).toHaveBeenCalledOnce();
    expect(firstStatus).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: INSTANCE_ID }),
    );

    const second = await loadOffscreen(OTHER_INSTANCE_ID);
    const secondStatus = vi.fn();
    second.listener({ type: "offscreen-status" }, sender, secondStatus);
    expect(second.randomUUID).toHaveBeenCalledOnce();
    expect(secondStatus).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: OTHER_INSTANCE_ID }),
    );
    expect(firstStatus.mock.calls[0]?.[0]).not.toEqual(
      secondStatus.mock.calls[0]?.[0],
    );
  });

  it("answers the exact background instance probe without creating a Worker", async () => {
    const { listener } = await loadOffscreen();
    const response = vi.fn();
    const backgroundSender = {
      id: EXTENSION_ID,
      url: `chrome-extension://${EXTENSION_ID}/background.js`,
    };
    expect(
      listener({ type: "offscreen-instance" }, backgroundSender, response),
    ).toBe(false);
    expect(response).toHaveBeenCalledExactlyOnceWith({
      instanceId: INSTANCE_ID,
    });
    expect(FakeWorker.instances).toHaveLength(0);
    const malformed = vi.fn();
    expect(
      listener(
        { type: "offscreen-instance", instanceId: OTHER_INSTANCE_ID },
        backgroundSender,
        malformed,
      ),
    ).toBe(false);
    expect(malformed).not.toHaveBeenCalled();
  });

  it("answers the instance probe while retiring without reopening the Worker", async () => {
    vi.useFakeTimers();
    const { listener } = await loadOffscreen();
    listener({ type: "offscreen-detect", text: "本文" }, sender, vi.fn());
    const worker = FakeWorker.instances[0]!;
    worker.emit({ id: 0, ok: true, result: {} });
    await vi.advanceTimersByTimeAsync(60_000);
    worker.emit({ type: "disposed", ok: true });
    const response = vi.fn();
    listener(
      { type: "offscreen-instance" },
      {
        id: EXTENSION_ID,
        url: `chrome-extension://${EXTENSION_ID}/background.js`,
      },
      response,
    );
    expect(response).toHaveBeenCalledExactlyOnceWith({
      instanceId: INSTANCE_ID,
    });
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("fails module initialization when crypto.randomUUID is unavailable", async () => {
    await expect(loadOffscreen(INSTANCE_ID, false)).rejects.toThrow();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("rejects an invalid platform UUID before creating a Worker", async () => {
    await expect(loadOffscreen("invalid")).rejects.toThrow(
      "offscreen-instance-unavailable",
    );
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("keeps its marker when identity response contains a caller-supplied marker", async () => {
    vi.useFakeTimers();
    const { listener, identify, sendMessage } = await loadOffscreen();
    identify.mockResolvedValue({
      ok: true,
      documentId: "current",
      instanceId: OTHER_INSTANCE_ID,
    });
    listener({ type: "offscreen-detect", text: "本文" }, sender, vi.fn());
    const worker = FakeWorker.instances[0]!;
    worker.emit({ id: 0, ok: true, result: {} });
    await vi.advanceTimersByTimeAsync(60_000);
    worker.emit({ type: "disposed", ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "offscreen-idle",
        instanceId: INSTANCE_ID,
      }),
    );
  });

  it("counts requests waiting for disposal against the two-request bound", async () => {
    vi.useFakeTimers();
    const { listener, sendMessage } = await loadOffscreen();
    listener({ type: "offscreen-detect", text: "一" }, sender, vi.fn());
    FakeWorker.instances[0]!.emit({ id: 0, ok: true, result: {} });
    await vi.advanceTimersByTimeAsync(60_000);
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();
    listener({ type: "offscreen-detect", text: "二" }, sender, first);
    listener({ type: "offscreen-detect", text: "三" }, sender, second);
    expect(
      listener({ type: "offscreen-detect", text: "四" }, sender, third),
    ).toBe(false);
    expect(third).toHaveBeenCalledWith({ ok: false, code: "busy" });
    expect(FakeWorker.instances).toHaveLength(1);
    FakeWorker.instances[0]!.emit({ type: "disposed", ok: true });
    expect(sendMessage).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1]!.postMessage).toHaveBeenCalledTimes(2);
    FakeWorker.instances[1]!.emit({ id: 1, ok: true, result: {} });
    FakeWorker.instances[1]!.emit({ id: 2, ok: true, result: {} });
    await Promise.resolve();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("notifies the background only after retirement with no waiting inference and no text", async () => {
    vi.useFakeTimers();
    const { listener, sendMessage } = await loadOffscreen();
    listener({ type: "offscreen-detect", text: "本文" }, sender, vi.fn());
    const worker = FakeWorker.instances[0]!;
    worker.emit({ id: 0, ok: true, result: {} });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendMessage).not.toHaveBeenCalled();
    worker.emit({ type: "disposed", ok: true });
    expect(worker.terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: "offscreen-idle",
      instanceId: INSTANCE_ID,
      documentId: "current",
      releases: { completed: 1, failed: 0, timedOut: 0, sendFailed: 0 },
    });
  });

  it("requests the declared identity through the background boundary", async () => {
    vi.useFakeTimers();
    const { listener, identify, runtimeSendMessage } = await loadOffscreen();
    listener({ type: "offscreen-detect", text: "本文" }, sender, vi.fn());
    const worker = FakeWorker.instances[0]!;
    worker.emit({ id: 0, ok: true, result: {} });
    await vi.advanceTimersByTimeAsync(60_000);
    worker.emit({ type: "disposed", ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect("getContexts" in chrome.runtime).toBe(false);
    expect(identify).toHaveBeenCalledWith({
      type: "offscreen-identify",
      instanceId: INSTANCE_ID,
    });
    expect(runtimeSendMessage).toHaveBeenCalledWith({
      type: "offscreen-identify",
      instanceId: INSTANCE_ID,
    });
  });

  it("holds retirement before identity lookup and sends only its own discovered ID", async () => {
    vi.useFakeTimers();
    const { listener, sendMessage, identify } = await loadOffscreen();
    let resolve!: (value: unknown) => void;
    identify.mockImplementation(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    listener({ type: "offscreen-detect", text: "本文" }, sender, vi.fn());
    FakeWorker.instances[0]!.emit({ id: 0, ok: true, result: {} });
    await vi.advanceTimersByTimeAsync(60_000);
    FakeWorker.instances[0]!.emit({ type: "disposed", ok: true });
    const blocked = vi.fn();
    listener({ type: "offscreen-detect", text: "次" }, sender, blocked);
    expect(blocked).toHaveBeenCalledWith({ ok: false, code: "busy" });
    expect(sendMessage).not.toHaveBeenCalled();
    resolve({ ok: true, documentId: "actual-document" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: "offscreen-idle",
      instanceId: INSTANCE_ID,
      documentId: "actual-document",
      releases: { completed: 1, failed: 0, timedOut: 0, sendFailed: 0 },
    });
  });

  it("does not undo retirement from a declined response after its document identity changes", async () => {
    vi.useFakeTimers();
    const { listener, sendMessage, identify } = await loadOffscreen();
    identify
      .mockResolvedValueOnce({ ok: true, documentId: "old" })
      .mockResolvedValue({ ok: true, documentId: "replacement" });
    sendMessage.mockResolvedValue({ ok: true, closed: false });
    listener({ type: "offscreen-detect", text: "本文" }, sender, vi.fn());
    FakeWorker.instances[0]!.emit({ id: 0, ok: true, result: {} });
    await vi.advanceTimersByTimeAsync(60_000);
    FakeWorker.instances[0]!.emit({ type: "disposed", ok: true });
    await vi.advanceTimersByTimeAsync(0);
    const blocked = vi.fn();
    listener({ type: "offscreen-detect", text: "次" }, sender, blocked);
    expect(blocked).toHaveBeenCalledWith({ ok: false, code: "busy" });
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it.each(["missing", "ambiguous", "rejected", "hung"] as const)(
    "fails closed without notifying for %s document identity",
    async (mode) => {
      vi.useFakeTimers();
      const { listener, identify, sendMessage } = await loadOffscreen();
      if (mode === "missing") identify.mockResolvedValue({ ok: true });
      if (mode === "ambiguous")
        identify.mockResolvedValue({ ok: false, code: "ambiguous" });
      if (mode === "rejected")
        identify.mockRejectedValue(new Error("unavailable"));
      if (mode === "hung")
        identify.mockImplementation(() => new Promise(() => {}));
      listener({ type: "offscreen-detect", text: "本文" }, sender, vi.fn());
      FakeWorker.instances[0]!.emit({ id: 0, ok: true, result: {} });
      await vi.advanceTimersByTimeAsync(60_000);
      FakeWorker.instances[0]!.emit({ type: "disposed", ok: true });
      await vi.advanceTimersByTimeAsync(5000);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(identify).toHaveBeenCalledOnce();
      const blocked = vi.fn();
      listener({ type: "offscreen-detect", text: "次" }, sender, blocked);
      expect(blocked).toHaveBeenCalledWith({ ok: false, code: "busy" });
      expect(FakeWorker.instances).toHaveLength(1);
    },
  );

  it("survives synchronous runtime invalidation without reopening the retiring worker", async () => {
    vi.useFakeTimers();
    const { listener } = await loadOffscreen();
    vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(() => {
      throw new Error("runtime-invalidated");
    });
    listener({ type: "offscreen-detect", text: "本文" }, sender, vi.fn());
    const worker = FakeWorker.instances[0]!;
    worker.emit({ id: 0, ok: true, result: {} });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(() => worker.emit({ type: "disposed", ok: true })).not.toThrow();
    const response = vi.fn();
    listener({ type: "offscreen-detect", text: "次" }, sender, response);
    expect(response).toHaveBeenCalledWith({ ok: false, code: "busy" });
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it.each(["declined", "rejected", "lost", "unknown"] as const)(
    "keeps retirement across %s close responses unless close explicitly declined",
    async (outcome) => {
      vi.useFakeTimers();
      const { listener, sendMessage: send } = await loadOffscreen();
      if (outcome === "declined")
        send.mockResolvedValueOnce({ ok: true, closed: false });
      if (outcome === "rejected")
        send.mockResolvedValueOnce({
          ok: false,
          code: "offscreen-close-failed",
        });
      if (outcome === "lost")
        send.mockRejectedValueOnce(new Error("unavailable"));
      if (outcome === "unknown")
        send.mockImplementationOnce(() => new Promise(() => {}));
      listener({ type: "offscreen-detect", text: "本文" }, sender, vi.fn());
      const old = FakeWorker.instances[0]!;
      old.emit({ id: 0, ok: true, result: {} });
      await vi.advanceTimersByTimeAsync(60_000);
      old.emit({ type: "disposed", ok: true });
      const during = vi.fn();
      listener({ type: "offscreen-detect", text: "次" }, sender, during);
      expect(during).toHaveBeenCalledWith({ ok: false, code: "busy" });
      expect(FakeWorker.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(0);
      const status = vi.fn();
      listener({ type: "offscreen-status" }, sender, status);
      expect(status).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: INSTANCE_ID,
          retiring: outcome !== "declined",
        }),
      );
      const next = vi.fn();
      listener({ type: "offscreen-detect", text: "次" }, sender, next);
      expect(FakeWorker.instances).toHaveLength(outcome === "declined" ? 2 : 1);
      if (outcome !== "declined")
        expect(next).toHaveBeenCalledWith({ ok: false, code: "busy" });
    },
  );

  it("reports actual readiness without creating a worker or extending idle lifetime", async () => {
    vi.useFakeTimers();
    const { listener } = await loadOffscreen();
    const status = vi.fn();
    expect(listener({ type: "offscreen-status" }, sender, status)).toBe(false);
    expect(status).toHaveBeenLastCalledWith({
      instanceId: INSTANCE_ID,
      ready: false,
      retiring: false,
      releases: { completed: 0, failed: 0, timedOut: 0, sendFailed: 0 },
    });
    expect(FakeWorker.instances).toHaveLength(0);
    const detected = vi.fn();
    listener({ type: "offscreen-detect", text: "本文" }, sender, detected);
    FakeWorker.instances[0]!.emit({ id: 0, ok: true, result: {} });
    await Promise.resolve();
    listener({ type: "offscreen-status" }, sender, status);
    expect(status).toHaveBeenLastCalledWith({
      instanceId: INSTANCE_ID,
      ready: true,
      retiring: false,
      releases: { completed: 0, failed: 0, timedOut: 0, sendFailed: 0 },
    });
    await vi.advanceTimersByTimeAsync(59_999);
    listener({ type: "offscreen-status" }, sender, status);
    expect(status).toHaveBeenLastCalledWith({
      instanceId: INSTANCE_ID,
      ready: true,
      retiring: false,
      releases: { completed: 0, failed: 0, timedOut: 0, sendFailed: 0 },
    });
    await vi.advanceTimersByTimeAsync(1);
    listener({ type: "offscreen-status" }, sender, status);
    expect(status).toHaveBeenLastCalledWith({
      instanceId: INSTANCE_ID,
      ready: false,
      retiring: false,
      releases: { completed: 0, failed: 0, timedOut: 0, sendFailed: 0 },
    });
    expect(FakeWorker.instances[0]!.terminate).not.toHaveBeenCalled();
    FakeWorker.instances[0]!.emit({ type: "disposed", ok: true });
    listener({ type: "offscreen-status" }, sender, status);
    expect(status).toHaveBeenLastCalledWith({
      instanceId: INSTANCE_ID,
      ready: false,
      retiring: true,
      releases: { completed: 1, failed: 0, timedOut: 0, sendFailed: 0 },
    });
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect(FakeWorker.instances).toHaveLength(1);
    const untrusted = vi.fn();
    listener(
      { type: "offscreen-status" },
      { id: EXTENSION_ID, url: "https://example.test/" },
      untrusted,
    );
    expect(untrusted).not.toHaveBeenCalled();
  });

  it("rejects untrusted and malformed requests", async () => {
    const { listener } = await loadOffscreen();
    const response = vi.fn();
    expect(
      listener(
        { type: "offscreen-detect", text: "本文" },
        { id: "web" },
        response,
      ),
    ).toBe(false);
    expect(
      listener({ type: "offscreen-detect", text: 1 }, sender, response),
    ).toBe(false);
    expect(response).not.toHaveBeenCalled();
  });

  it("forwards a valid worker response", async () => {
    const { listener } = await loadOffscreen();
    const response = vi.fn();
    expect(
      listener({ type: "offscreen-detect", text: "本文" }, sender, response),
    ).toBe(true);
    expect(FakeWorker.instances).toHaveLength(1);
    const worker = FakeWorker.instances[0]!;
    worker.emit({ id: 0, ok: true, result: { detections: [] } });
    await vi.waitFor(() =>
      expect(response).toHaveBeenCalledWith({
        id: 0,
        ok: true,
        result: { detections: [] },
      }),
    );
  });

  it("bounds concurrent requests and reports worker timeout", async () => {
    vi.useFakeTimers();
    const { listener } = await loadOffscreen();
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();
    listener({ type: "offscreen-detect", text: "一" }, sender, first);
    listener({ type: "offscreen-detect", text: "二" }, sender, second);
    expect(
      listener({ type: "offscreen-detect", text: "三" }, sender, third),
    ).toBe(false);
    expect(third).toHaveBeenCalledWith({ ok: false, code: "busy" });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() =>
      expect(first).toHaveBeenCalledWith({ ok: false, code: "worker-failed" }),
    );
    await vi.waitFor(() =>
      expect(second).toHaveBeenCalledWith({ ok: false, code: "worker-failed" }),
    );
  });
});
