import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerBroker, type WorkerLike } from "./broker";

function fakeWorker() {
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };
  return Object.assign(worker, {
    emit: (data: unknown) => worker.onmessage?.({ data } as MessageEvent),
    fail: () => worker.onerror?.({} as ErrorEvent),
  });
}

describe("opt-in retained Worker session lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("releases a session and uses the same Worker for the next detector", async () => {
    const worker = fakeWorker();
    const create = vi.fn(() => worker);
    const onIdle = vi.fn();
    const broker = new WorkerBroker(create, 5000, 10, onIdle, 50);
    const initial = broker.request("first");
    worker.emit({ id: 0, ok: true, result: {} });
    await initial;
    await vi.advanceTimersByTimeAsync(10);
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: "release-session",
      releaseId: 0,
    });
    expect(broker.ready).toBe(false);
    worker.emit({ type: "session-released", releaseId: 0, ok: true });
    const next = broker.request("next");
    expect(create).toHaveBeenCalledOnce();
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: "detect",
      id: 1,
      text: "next",
    });
    worker.emit({ id: 1, ok: true, result: { fresh: true } });
    await expect(next).resolves.toMatchObject({ result: { fresh: true } });
    expect(broker.ready).toBe(true);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("queues requests behind an exact acknowledgement and rejects stale control", async () => {
    const worker = fakeWorker();
    const create = vi.fn(() => worker);
    const broker = new WorkerBroker(create, 5000, 10, vi.fn(), 50);
    const initial = broker.request("first");
    const oldHandler = worker.onmessage!;
    worker.emit({ id: 0, ok: true, result: {} });
    await initial;
    await vi.advanceTimersByTimeAsync(10);
    const next = broker.request("next");
    expect(broker.size).toBe(1);
    const before = vi.mocked(worker.postMessage).mock.calls.length;
    oldHandler({ data: { id: 1, ok: true, result: "old" } } as MessageEvent);
    for (const data of [
      { type: "session-released", releaseId: 1, ok: true },
      { type: "session-released", releaseId: 0, ok: "true" },
      { type: "session-released", releaseId: 0, ok: true, extra: true },
      { type: "disposed", ok: true },
    ])
      worker.emit(data);
    await vi.advanceTimersByTimeAsync(0);
    expect(broker.size).toBe(1);
    expect(vi.mocked(worker.postMessage).mock.calls).toHaveLength(before);
    worker.emit({ type: "session-released", releaseId: 0, ok: true });
    await vi.advanceTimersByTimeAsync(0);
    worker.emit({ id: 1, ok: true, result: "new" });
    await expect(next).resolves.toMatchObject({ result: "new" });
    await vi.advanceTimersByTimeAsync(10);
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: "release-session",
      releaseId: 1,
    });
    worker.emit({ type: "session-released", releaseId: 0, ok: true });
    expect(broker.releaseCounts.completed).toBe(1);
    worker.emit({ type: "session-released", releaseId: 1, ok: true });
    expect(broker.releaseCounts.completed).toBe(2);
  });

  it("retires once at the fixed retention deadline despite status reads", async () => {
    const worker = fakeWorker();
    const create = vi.fn(() => worker);
    const onIdle = vi.fn();
    const broker = new WorkerBroker(create, 5000, 10, onIdle, 50);
    const initial = broker.request("first");
    worker.emit({ id: 0, ok: true, result: {} });
    await initial;
    await vi.advanceTimersByTimeAsync(10);
    const releaseHandler = worker.onmessage!;
    worker.emit({ type: "session-released", releaseId: 0, ok: true });
    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(10);
      expect(broker.ready).toBe(false);
      expect(broker.size).toBe(0);
      expect(broker.releaseCounts.completed).toBe(1);
    }
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(onIdle).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    releaseHandler({
      data: { type: "session-released", releaseId: 0, ok: true },
    } as MessageEvent);
    await vi.advanceTimersByTimeAsync(100);
    expect(onIdle).toHaveBeenCalledOnce();
    expect(broker.releaseCounts.completed).toBe(1);
  });

  it("cancels retention expiry before accepting a new pending request", async () => {
    const worker = fakeWorker();
    const broker = new WorkerBroker(() => worker, 5000, 10, vi.fn(), 50);
    const initial = broker.request("first");
    worker.emit({ id: 0, ok: true, result: {} });
    await initial;
    await vi.advanceTimersByTimeAsync(10);
    worker.emit({ type: "session-released", releaseId: 0, ok: true });
    await vi.advanceTimersByTimeAsync(49);
    const next = broker.request("next");
    await vi.advanceTimersByTimeAsync(20);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(broker.size).toBe(1);
    worker.emit({ id: 1, ok: true, result: {} });
    await next;
    await vi.advanceTimersByTimeAsync(9);
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: "detect",
      id: 1,
      text: "next",
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: "release-session",
      releaseId: 1,
    });
  });

  it.each(["error", "failed-ack", "send-failure", "timeout"] as const)(
    "terminates before replacement after release %s",
    async (mode) => {
      const first = fakeWorker();
      const second = fakeWorker();
      let calls = 0;
      const create = vi.fn(() => {
        if (calls++ === 0) return first;
        expect(first.terminate).toHaveBeenCalledOnce();
        return second;
      });
      const broker = new WorkerBroker(create, 5000, 10, vi.fn(), 50);
      const initial = broker.request("first");
      first.emit({ id: 0, ok: true, result: {} });
      await initial;
      if (mode === "send-failure")
        vi.mocked(first.postMessage).mockImplementationOnce(() => {
          throw new Error("private-error");
        });
      await vi.advanceTimersByTimeAsync(10);
      const releaseHandler = first.onmessage;
      const next = broker.request("next");
      if (mode === "error") first.fail();
      if (mode === "failed-ack")
        first.emit({ type: "session-released", releaseId: 0, ok: false });
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(create).toHaveBeenCalledTimes(2);
      expect(first.terminate).toHaveBeenCalledOnce();
      releaseHandler?.({
        data: { type: "session-released", releaseId: 0, ok: true },
      } as MessageEvent);
      expect(broker.ready).toBe(false);
      expect(broker.releaseCounts).toEqual({
        completed: 0,
        failed: mode === "error" || mode === "failed-ack" ? 1 : 0,
        timedOut: mode === "timeout" ? 1 : 0,
        sendFailed: mode === "send-failure" ? 1 : 0,
      });
      second.emit({ id: 1, ok: true, result: {} });
      await expect(next).resolves.toMatchObject({ ok: true });
    },
  );

  it("cancels release before a queued timeout can restart a Worker", async () => {
    const first = fakeWorker();
    const second = fakeWorker();
    const create = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const onIdle = vi.fn();
    const broker = new WorkerBroker(create, 100, 10, onIdle, 50);
    const initial = broker.request("first");
    first.emit({ id: 0, ok: true, result: {} });
    await initial;
    await vi.advanceTimersByTimeAsync(10);
    const next = broker.request("next").catch(() => "timeout");
    await vi.advanceTimersByTimeAsync(100);
    expect(await next).toBe("timeout");
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
    expect(onIdle).not.toHaveBeenCalled();
    expect(broker.size).toBe(0);
    expect(broker.ready).toBe(false);
  });

  it("does not release a session while work is still pending", async () => {
    const worker = fakeWorker();
    const broker = new WorkerBroker(() => worker, 5000, 10, vi.fn(), 50);
    const first = broker.request("one");
    const second = broker.request("two");
    worker.emit({ id: 0, ok: true, result: {} });
    await first;
    await vi.advanceTimersByTimeAsync(40);
    expect(worker.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "release-session" }),
    );
    worker.emit({ id: 1, ok: true, result: {} });
    await second;
    await vi.advanceTimersByTimeAsync(10);
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: "release-session",
      releaseId: 0,
    });
  });

  it.each([-1, 60_001, 0.5, NaN, Infinity])(
    "rejects invalid retention duration %s before creating any Worker",
    (duration) => {
      const create = vi.fn(() => fakeWorker());
      expect(
        () => new WorkerBroker(create, 5000, 10, vi.fn(), duration),
      ).toThrow("invalid-worker-retention");
      expect(create).not.toHaveBeenCalled();
    },
  );
});
