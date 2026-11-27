import { afterEach, expect, it, vi } from "vitest";
import { WorkerBroker, type WorkerLike } from "../offscreen/broker";

const state = vi.hoisted(() => ({
  instances: 0,
  dispose: vi.fn<() => Promise<void>>(),
}));

vi.mock("@kotoba-guard/core", () => ({
  LocalTypoDetector: class {
    constructor() {
      state.instances += 1;
    }
    async detect() {
      return {
        detections: [],
        inferenceMs: 1,
        backend: "wasm",
        modelVersion: "fixture",
      };
    }
    async dispose() {
      await state.dispose();
    }
  },
  createTransformersTokenizer: vi.fn().mockResolvedValue({}),
  createOrtSessionFactory: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  state.instances = 0;
  state.dispose.mockReset();
});

it("connects real Worker protocol and Broker without an early duplicate failure ACK", async () => {
  vi.useFakeTimers();
  let finishRelease!: () => void;
  state.dispose.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishRelease = resolve;
      }),
  );
  const responses: unknown[] = [];
  const workerScope = {
    location: { href: "chrome-extension://fixture/worker.js" },
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (data: unknown) => {
      responses.push(data);
      wire.onmessage?.({ data } as MessageEvent);
    },
  };
  const wire: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (data) => workerScope.onmessage!({ data } as MessageEvent),
    terminate: vi.fn(),
  };
  const createWorker = vi.fn(() => wire);
  const onIdle = vi.fn();
  vi.stubGlobal("self", workerScope);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      json: async () => ({ id2label: { "0": "OK" }, revision: "fixture" }),
    }),
  );
  await import("./worker");
  const broker = new WorkerBroker(createWorker, 1_000, 10, onIdle, 50);
  const first = broker.request("初回");
  await vi.advanceTimersByTimeAsync(0);
  expect(await first).toMatchObject({ ok: true });
  await vi.advanceTimersByTimeAsync(10);
  expect(state.dispose).toHaveBeenCalledOnce();
  wire.postMessage({ type: "release-session", releaseId: 0 });
  expect(responses).not.toContainEqual({
    type: "session-released",
    releaseId: 0,
    ok: false,
  });
  expect(wire.terminate).not.toHaveBeenCalled();
  const second = broker.request("再開");
  finishRelease();
  await vi.advanceTimersByTimeAsync(0);
  expect(await second).toMatchObject({ ok: true });
  expect(
    responses.filter(
      (value) => (value as { type?: string }).type === "session-released",
    ),
  ).toEqual([{ type: "session-released", releaseId: 0, ok: true }]);
  expect(state.instances).toBe(2);
  expect(createWorker).toHaveBeenCalledOnce();
  expect(onIdle).not.toHaveBeenCalled();
  expect(broker.releaseCounts).toEqual({
    completed: 1,
    failed: 0,
    timedOut: 0,
    sendFailed: 0,
  });
  await vi.advanceTimersByTimeAsync(60);
  expect(wire.terminate).toHaveBeenCalledOnce();
  expect(onIdle).toHaveBeenCalledOnce();
});
