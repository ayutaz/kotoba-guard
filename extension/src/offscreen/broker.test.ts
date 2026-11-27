import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerBroker, type WorkerLike } from "./broker";

function fakeWorker(): WorkerLike & {
  emit: (response: unknown) => void;
  fail: () => void;
} {
  const worker = {
    onmessage: null,
    onerror: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
    emit: (response) => worker.onmessage?.({ data: response } as MessageEvent),
    fail: () => worker.onerror?.({} as ErrorEvent),
  } as WorkerLike & { emit: (response: unknown) => void; fail: () => void };
  return worker;
}

describe("WorkerBroker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("terminates retirement before restart when a queued request times out", async () => {
    const first = fakeWorker();
    const replacement = fakeWorker();
    let creations = 0;
    const create = vi.fn(() => {
      creations += 1;
      if (creations === 1) return first;
      expect(first.terminate).toHaveBeenCalledOnce();
      return replacement;
    });
    const broker = new WorkerBroker(create, 100, 50);
    const initial = broker.request("一");
    first.emit({ id: 0, ok: true, result: {} });
    await initial;
    await vi.advanceTimersByTimeAsync(50);
    const waiting = broker.request("二");
    const outcome = waiting.catch(() => "timed-out");
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toBe("timed-out");
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
    const next = broker.request("三");
    replacement.emit({ id: 2, ok: true, result: {} });
    await expect(next).resolves.toMatchObject({ ok: true });
  });

  it("waits for a dispose ack, counts waiting requests and retires before recreating", async () => {
    const first = fakeWorker();
    const second = fakeWorker();
    const create = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const broker = new WorkerBroker(create, 10_000, 50);
    const initial = broker.request("一");
    const staleHandler = first.onmessage!;
    first.emit({ id: 0, ok: true, result: {} });
    await initial;
    await vi.advanceTimersByTimeAsync(50);
    expect(first.postMessage).toHaveBeenLastCalledWith({ type: "dispose" });
    expect(broker.ready).toBe(false);
    expect(first.terminate).not.toHaveBeenCalled();
    const next = broker.request("二");
    expect(broker.size).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    staleHandler({
      data: { id: 1, ok: true, result: "stale" },
    } as MessageEvent);
    first.emit({ type: "disposed", ok: "true" });
    first.emit({ id: 1, ok: true, result: "stale" });
    expect(first.terminate).not.toHaveBeenCalled();
    first.emit({ type: "disposed", ok: true });
    await Promise.resolve();
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
    expect(broker.releaseCounts).toEqual({
      completed: 1,
      failed: 0,
      timedOut: 0,
      sendFailed: 0,
    });
    second.emit({ id: 1, ok: true, result: "current" });
    await expect(next).resolves.toMatchObject({ result: "current" });
  });

  it.each(["error", "failed-ack", "send-failure", "timeout"] as const)(
    "bounds dispose %s and recovers without overlapping workers",
    async (mode) => {
      const first = fakeWorker();
      const second = fakeWorker();
      const create = vi
        .fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second);
      const broker = new WorkerBroker(create, 10_000, 50);
      const initial = broker.request("一");
      first.emit({ id: 0, ok: true, result: {} });
      await initial;
      if (mode === "send-failure")
        vi.mocked(first.postMessage).mockImplementationOnce(() => {
          throw new Error("private-error");
        });
      await vi.advanceTimersByTimeAsync(50);
      if (mode === "error") first.fail();
      if (mode === "failed-ack") first.emit({ type: "disposed", ok: false });
      if (mode === "timeout") {
        await vi.advanceTimersByTimeAsync(999);
        expect(first.terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      await Promise.resolve();
      expect(first.terminate).toHaveBeenCalledOnce();
      expect(broker.releaseCounts).toEqual({
        completed: 0,
        failed: mode === "error" || mode === "failed-ack" ? 1 : 0,
        timedOut: mode === "timeout" ? 1 : 0,
        sendFailed: mode === "send-failure" ? 1 : 0,
      });
      const next = broker.request("二");
      second.emit({ id: 1, ok: true, result: {} });
      await expect(next).resolves.toMatchObject({ ok: true });
    },
  );

  it("invalidates readiness immediately after a send failure on a previously ready worker", async () => {
    const first = fakeWorker();
    const second = fakeWorker();
    const broker = new WorkerBroker(
      vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
      1000,
      50,
    );
    const initial = broker.request("一");
    first.emit({ id: 0, ok: true, result: {} });
    await initial;
    expect(broker.ready).toBe(true);
    vi.mocked(first.postMessage).mockImplementationOnce(() => {
      throw new Error("send-failed");
    });
    await expect(broker.request("二")).rejects.toThrow("send-failed");
    expect(broker.ready).toBe(false);
    expect(first.terminate).toHaveBeenCalledOnce();
    const recovered = broker.request("三");
    second.emit({ id: 2, ok: true, result: {} });
    await recovered;
    expect(broker.ready).toBe(true);
  });

  it("releases an idle worker and lazily recreates it without accepting retired events", async () => {
    const first = fakeWorker();
    const second = fakeWorker();
    const create = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const broker = new WorkerBroker(create, 1000, 50);
    expect(broker.ready).toBe(false);
    const initial = broker.request("一");
    const oldHandler = first.onmessage!;
    first.emit({ id: 0, ok: true, result: {} });
    await initial;
    expect(broker.ready).toBe(true);
    await vi.advanceTimersByTimeAsync(49);
    expect(first.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    first.emit({ type: "disposed", ok: true });
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(broker.ready).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    const next = broker.request("二");
    oldHandler({
      data: { id: 1, ok: true, result: "retired" },
    } as MessageEvent);
    expect(broker.size).toBe(1);
    second.emit({ id: 1, ok: true, result: "current" });
    await expect(next).resolves.toMatchObject({ result: "current" });
  });

  it("never idles pending work and restarts the deadline after the final response", async () => {
    const worker = fakeWorker();
    const broker = new WorkerBroker(() => worker, 1000, 50);
    const first = broker.request("一");
    const second = broker.request("二");
    worker.emit({ id: 0, ok: true, result: {} });
    await first;
    await vi.advanceTimersByTimeAsync(100);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit({ id: 1, ok: true, result: {} });
    await second;
    await vi.advanceTimersByTimeAsync(30);
    const third = broker.request("三");
    await vi.advanceTimersByTimeAsync(30);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit({ id: 2, ok: true, result: {} });
    await third;
    await vi.advanceTimersByTimeAsync(49);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    worker.emit({ type: "disposed", ok: true });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("releases failed and restarted idle workers without marking them ready", async () => {
    const first = fakeWorker();
    const second = fakeWorker();
    const third = fakeWorker();
    const create = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(third);
    const broker = new WorkerBroker(create, 1000, 50);
    const request = broker.request("一");
    first.emit({ id: 0, ok: false, code: "inference-failed" });
    await request;
    expect(broker.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    first.emit({ type: "disposed", ok: true });
    expect(first.terminate).toHaveBeenCalledOnce();
    const next = broker.request("二");
    const rejected = expect(next).rejects.toThrow("worker-failed");
    second.fail();
    await rejected;
    expect(broker.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    third.emit({ type: "disposed", ok: true });
    expect(create).toHaveBeenCalledTimes(3);
    expect(third.terminate).toHaveBeenCalledOnce();
  });

  it("releases a worker after postMessage fails", async () => {
    const worker = fakeWorker();
    const replacement = fakeWorker();
    vi.mocked(worker.postMessage).mockImplementationOnce(() => {
      throw new Error("send-failed");
    });
    const broker = new WorkerBroker(
      vi.fn().mockReturnValueOnce(worker).mockReturnValueOnce(replacement),
      1000,
      50,
    );
    await expect(broker.request("一")).rejects.toThrow("send-failed");
    expect(worker.terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(50);
    replacement.emit({ type: "disposed", ok: true });
    expect(replacement.terminate).toHaveBeenCalledOnce();
  });

  it("resolves a worker response and tracks no pending work", async () => {
    const worker = fakeWorker();
    const broker = new WorkerBroker(() => worker, 100);
    const result = broker.request("本文");
    worker.emit({ id: 0, ok: true, result: { detections: [] } });
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(broker.size).toBe(0);
  });

  it("ignores null and malformed worker events without losing valid responses", async () => {
    const worker = fakeWorker();
    const broker = new WorkerBroker(() => worker, 100);
    const result = broker.request("本文");
    expect(() => worker.emit(null)).not.toThrow();
    expect(() => worker.emit({ id: "invalid" })).not.toThrow();
    worker.emit({ id: 0, ok: true, result: { detections: [] } });
    await expect(result).resolves.toMatchObject({ ok: true });
  });

  it("ignores events from an old worker after restart", async () => {
    const first = fakeWorker();
    const second = fakeWorker();
    const third = fakeWorker();
    const create = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(third);
    const broker = new WorkerBroker(create, 100);
    const failed = broker.request("本文");
    first.fail();
    await expect(failed).rejects.toThrow("worker-failed");
    first.fail();
    const next = broker.request("次");
    second.emit({ id: 1, ok: true, result: { detections: [] } });
    await expect(next).resolves.toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("requires a result field for successful worker responses", async () => {
    const worker = fakeWorker();
    const broker = new WorkerBroker(() => worker, 100);
    const result = broker.request("本文");
    worker.emit({ id: 0, ok: true });
    expect(broker.size).toBe(1);
    worker.emit({ id: 0, ok: true, result: { detections: [] } });
    await expect(result).resolves.toEqual({
      id: 0,
      ok: true,
      result: { detections: [] },
    });
  });

  it("rejects and recreates the worker on timeout", async () => {
    vi.useFakeTimers();
    const first = fakeWorker();
    const second = fakeWorker();
    const create = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const broker = new WorkerBroker(create, 10);
    const result = broker.request("本文");
    const assertion = expect(result).rejects.toThrow("worker-timeout");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(first.terminate).toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("rejects in-flight requests and accepts work after worker failure", async () => {
    const first = fakeWorker();
    const second = fakeWorker();
    const create = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const broker = new WorkerBroker(create, 100);
    const failed = broker.request("本文");
    first.fail();
    await expect(failed).rejects.toThrow("worker-failed");
    const next = broker.request("次");
    second.emit({ id: 1, ok: true, result: { detections: [] } });
    await expect(next).resolves.toMatchObject({ ok: true });
  });

  it("rejects controlledly when restart creation fails and recovers on the next request", async () => {
    const first = fakeWorker();
    const second = fakeWorker();
    const create = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockImplementationOnce(() => {
        throw new Error("worker-create-failed");
      })
      .mockReturnValueOnce(second);
    const broker = new WorkerBroker(create, 100);
    const failed = broker.request("本文");
    expect(() => first.fail()).not.toThrow();
    await expect(failed).rejects.toThrow("worker-failed");
    const recovered = broker.request("次");
    second.emit({ id: 1, ok: true, result: { detections: [] } });
    await expect(recovered).resolves.toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("recovers when initial worker creation fails", async () => {
    const worker = fakeWorker();
    const create = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("initial-create-failed");
      })
      .mockReturnValueOnce(worker);
    const broker = new WorkerBroker(create, 100);
    await expect(broker.request("本文")).rejects.toThrow("worker-unavailable");
    const recovered = broker.request("次");
    worker.emit({ id: 0, ok: true, result: { detections: [] } });
    await expect(recovered).resolves.toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
