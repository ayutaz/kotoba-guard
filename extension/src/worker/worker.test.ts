import { afterEach, describe, expect, it, vi } from "vitest";

const detectorState = vi.hoisted(() => ({
  fail: false,
  instances: 0,
  detectGate: undefined as (() => Promise<void>) | undefined,
  detectStarted: vi.fn(),
  initialize: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("@kotoba-guard/core", () => ({
  LocalTypoDetector: class {
    constructor() {
      detectorState.instances += 1;
    }
    async initialize(): Promise<void> {
      await detectorState.initialize();
    }
    async detect(text: string) {
      detectorState.detectStarted();
      if (detectorState.detectGate) await detectorState.detectGate();
      if (detectorState.fail) throw new Error("inference-failed");
      return {
        detections: [],
        inferenceMs: 1,
        backend: "wasm" as const,
        modelVersion: "test",
        input: text,
      };
    }
    async dispose(): Promise<void> {
      await detectorState.dispose();
    }
  },
  createTransformersTokenizer: vi.fn().mockResolvedValue({ encode: vi.fn() }),
  createOrtSessionFactory: vi.fn().mockReturnValue(vi.fn()),
}));

describe("bundled inference worker entry", () => {
  afterEach(() => {
    detectorState.fail = false;
    detectorState.instances = 0;
    detectorState.detectGate = undefined;
    detectorState.detectStarted.mockReset();
    detectorState.initialize.mockReset();
    detectorState.dispose.mockReset();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("disposes an unused worker without loading a model and ignores repeated control", async () => {
    const worker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
    };
    const fetch = vi.fn();
    vi.stubGlobal("self", worker);
    vi.stubGlobal("fetch", fetch);
    await import("./worker");
    worker.onmessage!({ data: { type: "dispose" } } as MessageEvent);
    worker.onmessage!({ data: { type: "dispose" } } as MessageEvent);
    await vi.waitFor(() =>
      expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({
        type: "disposed",
        ok: true,
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(detectorState.dispose).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "acknowledges disposal only after initialization and release, failure=%s",
    async (fail) => {
      let initialized!: () => void;
      let released!: () => void;
      detectorState.initialize.mockReturnValue(
        new Promise<void>((resolve) => {
          initialized = resolve;
        }),
      );
      detectorState.dispose.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          released = resolve;
        });
        if (fail) throw new Error("private-release-error");
      });
      const worker = {
        location: { href: "chrome-extension://test/worker.js" },
        onmessage: null as ((event: MessageEvent) => void) | null,
        postMessage: vi.fn(),
      };
      vi.stubGlobal("self", worker);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          json: async () => ({ id2label: { "0": "OK" } }),
        }),
      );
      await import("./worker");
      worker.onmessage!({
        data: { id: 1, type: "detect", text: "本文" },
      } as MessageEvent);
      await vi.waitFor(() =>
        expect(detectorState.initialize).toHaveBeenCalledOnce(),
      );
      worker.onmessage!({ data: { type: "dispose" } } as MessageEvent);
      worker.onmessage!({
        data: { id: 2, type: "detect", text: "後続" },
      } as MessageEvent);
      expect(worker.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "disposed" }),
      );
      initialized();
      await vi.waitFor(() =>
        expect(detectorState.dispose).toHaveBeenCalledOnce(),
      );
      expect(worker.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "disposed" }),
      );
      released();
      await vi.waitFor(() =>
        expect(worker.postMessage).toHaveBeenCalledWith({
          type: "disposed",
          ok: !fail,
        }),
      );
      expect(worker.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 2 }),
      );
      expect(JSON.stringify(worker.postMessage.mock.calls)).not.toContain(
        "private-release-error",
      );
    },
  );

  it("initializes the bundled detector and returns a result", async () => {
    const postMessage = vi.fn();
    const worker = {
      location: { href: "chrome-extension://test/worker.js" },
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage,
    };
    vi.stubGlobal("self", worker);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          json: () =>
            Promise.resolve(
              url.includes("manifest")
                ? { revision: "test-revision" }
                : { id2label: { "0": "OK" } },
            ),
        }),
      ),
    );
    await import("./worker");
    await worker.onmessage?.({
      data: { id: 1, type: "detect", text: "本文" },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, ok: true }),
      ),
    );
  });

  it("returns a bounded inference error and ignores oversized input", async () => {
    const postMessage = vi.fn();
    const worker = {
      location: { href: "chrome-extension://test/worker.js" },
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage,
    };
    vi.stubGlobal("self", worker);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ id2label: { "0": "OK" } }),
      }),
    );
    await import("./worker");
    await worker.onmessage?.({
      data: { id: 1, type: "detect", text: "本文" },
    } as MessageEvent);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
    detectorState.fail = true;
    await worker.onmessage?.({
      data: { id: 2, type: "detect", text: "失敗" },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        id: 2,
        ok: false,
        code: "inference-failed",
      }),
    );
    await worker.onmessage?.({
      data: { id: 3, type: "detect", text: "x".repeat(20_001) },
    } as MessageEvent);
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 3 }),
    );
  });

  it("releases only the detector session and rebuilds a new detector in the same worker", async () => {
    const postMessage = vi.fn();
    const worker = {
      location: { href: "chrome-extension://test/worker.js" },
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage,
    };
    vi.stubGlobal("self", worker);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          json: () =>
            Promise.resolve(
              url.includes("manifest")
                ? { revision: "test-revision" }
                : { id2label: { "0": "OK" } },
            ),
        }),
      ),
    );
    await import("./worker");
    await worker.onmessage?.({
      data: { id: 1, type: "detect", text: "初回" },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, ok: true }),
      ),
    );
    expect(detectorState.instances).toBe(1);

    worker.onmessage!({
      data: { type: "release-session", releaseId: 7 },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: "session-released",
        releaseId: 7,
        ok: true,
      }),
    );
    expect(detectorState.dispose).toHaveBeenCalledOnce();

    await worker.onmessage?.({
      data: { id: 2, type: "detect", text: "再開" },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 2, ok: true }),
      ),
    );
    expect(detectorState.instances).toBe(2);
  });

  it("ignores malformed release controls and releases after permanent retirement", async () => {
    const postMessage = vi.fn();
    const worker = {
      location: { href: "chrome-extension://test/worker.js" },
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage,
    };
    vi.stubGlobal("self", worker);
    vi.stubGlobal("fetch", vi.fn());
    await import("./worker");
    for (const data of [
      { type: "release-session", releaseId: -1 },
      { type: "release-session", releaseId: 1.5 },
      { type: "release-session", releaseId: Number.MAX_SAFE_INTEGER + 1 },
      { type: "release-session", releaseId: 1, extra: true },
    ]) {
      worker.onmessage!({ data } as MessageEvent);
    }
    expect(postMessage).not.toHaveBeenCalled();

    worker.onmessage!({ data: { type: "dispose" } } as MessageEvent);
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: "disposed",
        ok: true,
      }),
    );
    worker.onmessage!({
      data: { type: "release-session", releaseId: 1 },
    } as MessageEvent);
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session-released" }),
    );
  });

  it("waits for initialization before session release and rebuilds only after its acknowledgement", async () => {
    let initialized!: () => void;
    detectorState.initialize.mockReturnValue(
      new Promise<void>((resolve) => {
        initialized = resolve;
      }),
    );
    const postMessage = vi.fn();
    const worker = {
      location: { href: "chrome-extension://test/worker.js" },
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage,
    };
    vi.stubGlobal("self", worker);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ id2label: { "0": "OK" } }),
      }),
    );
    await import("./worker");
    worker.onmessage!({
      data: { id: 1, type: "detect", text: "初期化待ち" },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(detectorState.initialize).toHaveBeenCalledOnce(),
    );
    worker.onmessage!({
      data: { type: "release-session", releaseId: 12 },
    } as MessageEvent);
    worker.onmessage!({
      data: { id: 2, type: "detect", text: "release中" },
    } as MessageEvent);
    expect(detectorState.dispose).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      id: 2,
      ok: false,
      code: "worker-busy",
    });
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session-released" }),
    );

    initialized();
    await vi.waitFor(() =>
      expect(detectorState.dispose).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: "session-released",
        releaseId: 12,
        ok: true,
      }),
    );
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        id: 1,
        ok: false,
        code: "worker-busy",
      }),
    );

    worker.onmessage!({
      data: { id: 3, type: "detect", text: "新セッション" },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 3, ok: true }),
      ),
    );
    expect(detectorState.instances).toBe(2);
  });

  it("waits for an active detect run through SDK disposal before acknowledging release", async () => {
    let detectResolve!: () => void;
    const activeDetect = new Promise<void>((resolve) => {
      detectResolve = resolve;
    });
    detectorState.detectGate = () => activeDetect;
    detectorState.dispose.mockImplementation(async () => activeDetect);
    const postMessage = vi.fn();
    const worker = {
      location: { href: "chrome-extension://test/worker.js" },
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage,
    };
    vi.stubGlobal("self", worker);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ id2label: { "0": "OK" } }),
      }),
    );
    await import("./worker");
    worker.onmessage!({
      data: { id: 1, type: "detect", text: "実行中" },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(detectorState.detectStarted).toHaveBeenCalledOnce(),
    );
    worker.onmessage!({
      data: { type: "release-session", releaseId: 13 },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(detectorState.dispose).toHaveBeenCalledOnce(),
    );
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session-released" }),
    );

    detectResolve();
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: "session-released",
        releaseId: 13,
        ok: true,
      }),
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, ok: true }),
    );
  });

  it("rejects duplicate and stale release IDs without disposing twice", async () => {
    const postMessage = vi.fn();
    const worker = {
      location: { href: "chrome-extension://test/worker.js" },
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage,
    };
    vi.stubGlobal("self", worker);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ id2label: { "0": "OK" } }),
      }),
    );
    await import("./worker");
    await worker.onmessage?.({
      data: { id: 1, type: "detect", text: "本文" },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, ok: true }),
      ),
    );
    worker.onmessage!({
      data: { type: "release-session", releaseId: 5 },
    } as MessageEvent);
    worker.onmessage!({
      data: { type: "release-session", releaseId: 5 },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: "session-released",
        releaseId: 5,
        ok: true,
      }),
    );
    const sessionAcks = () =>
      postMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message?.type === "session-released");
    expect(sessionAcks()).toEqual([
      { type: "session-released", releaseId: 5, ok: true },
    ]);
    expect(detectorState.dispose).toHaveBeenCalledOnce();
    worker.onmessage!({
      data: { type: "release-session", releaseId: 4 },
    } as MessageEvent);
    worker.onmessage!({
      data: { type: "release-session", releaseId: 5 },
    } as MessageEvent);
    expect(sessionAcks()).toEqual([
      { type: "session-released", releaseId: 5, ok: true },
    ]);
    expect(detectorState.dispose).toHaveBeenCalledOnce();
  });

  it("fails closed when session disposal fails and does not rebuild the detector", async () => {
    detectorState.dispose.mockRejectedValueOnce(
      new Error("private-session-error"),
    );
    const postMessage = vi.fn();
    const worker = {
      location: { href: "chrome-extension://test/worker.js" },
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage,
    };
    vi.stubGlobal("self", worker);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ id2label: { "0": "OK" } }),
      }),
    );
    await import("./worker");
    await worker.onmessage?.({
      data: { id: 1, type: "detect", text: "本文" },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, ok: true }),
      ),
    );
    worker.onmessage!({
      data: { type: "release-session", releaseId: 11 },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: "session-released",
        releaseId: 11,
        ok: false,
      }),
    );
    const callsBeforeBlockedDetect = postMessage.mock.calls.length;
    worker.onmessage!({
      data: { id: 2, type: "detect", text: "再生成禁止" },
    } as MessageEvent);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(postMessage.mock.calls.length).toBe(callsBeforeBlockedDetect);
    expect(detectorState.instances).toBe(1);
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain(
      "private-session-error",
    );
  });

  it("reports bounded busy responses while release is waiting for active inference", async () => {
    let release!: () => void;
    detectorState.dispose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const postMessage = vi.fn();
    const worker = {
      location: { href: "chrome-extension://test/worker.js" },
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage,
    };
    vi.stubGlobal("self", worker);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ id2label: { "0": "OK" } }),
      }),
    );
    await import("./worker");
    await worker.onmessage?.({
      data: { id: 1, type: "detect", text: "本文" },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, ok: true }),
      ),
    );
    worker.onmessage!({
      data: { type: "release-session", releaseId: 1 },
    } as MessageEvent);
    worker.onmessage!({
      data: { id: 2, type: "detect", text: "release中" },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        id: 2,
        ok: false,
        code: "worker-busy",
      }),
    );
    expect(detectorState.dispose).toHaveBeenCalledOnce();
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session-released", releaseId: 1 }),
    );
    release();
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: "session-released",
        releaseId: 1,
        ok: true,
      }),
    );
  });

  it("waits for a pending session release before acknowledging permanent disposal", async () => {
    let release!: () => void;
    detectorState.dispose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const postMessage = vi.fn();
    const worker = {
      location: { href: "chrome-extension://test/worker.js" },
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage,
    };
    vi.stubGlobal("self", worker);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ id2label: { "0": "OK" } }),
      }),
    );
    await import("./worker");
    await worker.onmessage?.({
      data: { id: 1, type: "detect", text: "本文" },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, ok: true }),
      ),
    );
    worker.onmessage!({
      data: { type: "release-session", releaseId: 8 },
    } as MessageEvent);
    worker.onmessage!({ data: { type: "dispose" } } as MessageEvent);
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "disposed" }),
    );
    release();
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: "session-released",
        releaseId: 8,
        ok: true,
      }),
    );
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: "disposed",
        ok: true,
      }),
    );
    expect(detectorState.dispose).toHaveBeenCalledOnce();
    worker.onmessage!({
      data: { id: 2, type: "detect", text: "恒久終了後" },
    } as MessageEvent);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
    );
    expect(detectorState.instances).toBe(1);
  });
});
