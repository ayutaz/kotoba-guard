import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@kotoba-guard/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@kotoba-guard/core")>();
  return {
    ...core,
    createOrtSessionFactory: () => async () => ({
      inputNames: ["input_ids"],
      outputNames: ["logits"],
      run: state.run,
      release: async () => undefined,
    }),
    createTransformersTokenizer: async () => ({
      encode(text: string, options: { addSpecialTokens?: boolean } = {}) {
        const ids = Array.from(text, (_, i) => i + 1);
        const offsets = ids.map((_, i) => [i, i + 1] as [number, number]);
        if (options.addSpecialTokens === false)
          return { inputIds: ids, offsets };
        return {
          inputIds: [0, ...ids, 0],
          offsets: [[0, 0], ...offsets, [0, 0]],
          specialTokensMask: [1, ...ids.map(() => 0), 1],
        };
      },
    }),
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  state.run.mockReset();
});

async function setup() {
  vi.useFakeTimers();
  let finishFirst!: () => void;
  let count = 0;
  state.run.mockImplementation(
    async (feeds: { input_ids: { dims: number[] } }) => {
      count++;
      if (count === 1)
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      const length = feeds.input_ids.dims[1]!;
      return {
        logits: { dims: [1, length, 1], data: new Float32Array(length) },
      };
    },
  );
  const scope = {
    location: { href: "chrome-extension://fixture/worker.js" },
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn(),
  };
  vi.stubGlobal("self", scope);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      json: async () => ({ id2label: { "0": "OK" }, revision: "fixture" }),
    }),
  );
  await import("./worker");
  const send = (id: number) =>
    scope.onmessage!({
      data: { id, type: "detect", text: `文${id}` },
    } as MessageEvent);
  send(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(state.run).toHaveBeenCalledOnce();
  return { scope, send, finish: () => finishFirst() };
}

it("serializes different clients through the real SDK without cancelling either result", async () => {
  const { scope, send, finish } = await setup();
  try {
    send(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.run).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.run).toHaveBeenCalledTimes(2);
    for (const id of [1, 2])
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id, ok: true }),
      );
  } finally {
    finish();
  }
});

it("bounds the queue to one running and one waiting request", async () => {
  const { scope, send, finish } = await setup();
  try {
    send(2);
    send(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(scope.postMessage).toHaveBeenCalledWith({
      id: 3,
      ok: false,
      code: "worker-busy",
    });
    expect(state.run).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.run).toHaveBeenCalledTimes(2);
  } finally {
    finish();
  }
});

it("never starts a queued native run while a timed-out native run is still alive", async () => {
  const { scope, send, finish } = await setup();
  try {
    send(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(scope.postMessage).toHaveBeenCalledWith({
      id: 1,
      ok: false,
      code: "inference-failed",
    });
    expect(state.run).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.run).toHaveBeenCalledTimes(2);
    expect(scope.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, ok: true }),
    );
  } finally {
    finish();
  }
});

it("invalidates queued requests when their detector generation is released", async () => {
  const { scope, send, finish } = await setup();
  try {
    send(2);
    scope.onmessage!({
      data: { type: "release-session", releaseId: 0 },
    } as MessageEvent);
    await vi.advanceTimersByTimeAsync(0);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.run).toHaveBeenCalledOnce();
    expect(scope.postMessage).toHaveBeenCalledWith({
      id: 2,
      ok: false,
      code: "worker-busy",
    });
    expect(scope.postMessage).toHaveBeenCalledWith({
      type: "session-released",
      releaseId: 0,
      ok: true,
    });
  } finally {
    finish();
  }
});
