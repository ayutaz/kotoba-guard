import { describe, expect, it, vi } from "vitest";
import * as ort from "onnxruntime-web";
import { InferenceCancelledError, LocalTypoDetector } from "../src/index.js";
import type {
  InferenceSessionLike,
  TokenizerAdapter,
  TokenizerEncoding,
} from "../src/index.js";

function fakeTokenizer(): TokenizerAdapter {
  return {
    encode(text, options = {}) {
      const ids = Array.from(text, (_, index) => index + 1);
      const offsets = ids.map(
        (_, index) => [index, index + 1] as [number, number],
      );
      if (options.addSpecialTokens === false) return { inputIds: ids, offsets };
      return {
        inputIds: [101, ...ids, 102],
        attentionMask: [1, ...ids.map(() => 1), 1],
        specialTokensMask: [1, ...ids.map(() => 0), 1],
        offsets: [[0, 0], ...offsets, [0, 0]],
      };
    },
  };
}

function fakeSession(delay = 0): InferenceSessionLike {
  return {
    inputNames: ["input_ids", "attention_mask"],
    outputNames: ["logits"],
    async run(feeds) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const ids = (
        feeds.input_ids as { dims: number[]; data: ArrayLike<bigint> }
      ).dims[1];
      if (ids === undefined) throw new Error("missing sequence length");
      const logits = new Float32Array(ids * 3);
      // Token 1 gets label 1, every other ordinary token is OK (label 0).
      for (let index = 0; index < ids; index += 1) {
        logits[index * 3] = index === 2 ? 0 : 4;
        logits[index * 3 + 1] = index === 2 ? 6 : 0;
        logits[index * 3 + 2] = 0;
      }
      return { logits: { data: logits, dims: [1, ids, 3] } };
    },
  };
}

describe("LocalTypoDetector", () => {
  function options(
    overrides: Partial<ConstructorParameters<typeof LocalTypoDetector>[0]> = {},
  ) {
    return {
      tokenizer: fakeTokenizer(),
      sessionFactory: async () => fakeSession(),
      labels: {
        id2label: { "0": "OK", "1": "substitution", "2": "others" },
        label2id: { OK: 0, substitution: 1, others: 2 },
      },
      modelVersion: "test",
      maxTokens: 16,
      ...overrides,
    };
  }

  it("loads once and returns UTF-16 spans with model labels", async () => {
    let loads = 0;
    const detector = new LocalTypoDetector({
      tokenizer: fakeTokenizer(),
      sessionFactory: async () => {
        loads += 1;
        return fakeSession();
      },
      labels: { id2label: { "0": "OK", "1": "substitution", "2": "others" } },
      modelVersion: "test",
      maxTokens: 16,
      confidenceThreshold: 0.5,
    });
    await detector.initialize();
    const result = await detector.detect("abcd");
    expect(loads).toBe(1);
    expect(result.detections).toEqual([
      {
        start: 1,
        end: 2,
        text: "b",
        type: "substitution",
        labelId: 1,
        confidence: expect.any(Number),
      },
    ]);
    await detector.dispose();
  });

  it("rejects stale requests instead of returning an old result", async () => {
    const detector = new LocalTypoDetector({
      tokenizer: fakeTokenizer(),
      sessionFactory: async () => fakeSession(20),
      labels: { id2label: { "0": "OK", "1": "substitution", "2": "others" } },
      modelVersion: "test",
      maxTokens: 16,
    });
    const old = detector.detect("abcd");
    const current = detector.detect("xy");
    await expect(old).rejects.toBeInstanceOf(InferenceCancelledError);
    await expect(current).resolves.toMatchObject({ modelVersion: "test" });
    await detector.dispose();
  });

  it("retries initialization after a transient failure", async () => {
    let attempts = 0;
    const detector = new LocalTypoDetector(
      options({
        sessionFactory: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("transient");
          return fakeSession();
        },
      }),
    );
    await expect(detector.initialize()).rejects.toThrow("transient");
    await expect(detector.initialize()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    await detector.dispose();
  });

  it("falls back from WebGPU and reports the active WASM backend", async () => {
    const backends: string[] = [];
    const detector = new LocalTypoDetector(
      options({
        backend: "webgpu",
        sessionFactory: async (backend) => {
          backends.push(backend);
          if (backend === "webgpu") throw new Error("WebGPU unavailable");
          return fakeSession();
        },
      }),
    );
    await expect(detector.initialize()).resolves.toBeUndefined();
    await expect(detector.detect("abcd")).resolves.toMatchObject({
      backend: "wasm",
    });
    expect(backends).toEqual(["webgpu", "wasm"]);
    await detector.dispose();
  });

  it("releases the inference session exactly once", async () => {
    let releases = 0;
    const detector = new LocalTypoDetector(
      options({
        sessionFactory: async () => ({
          ...fakeSession(),
          release: () => {
            releases += 1;
          },
        }),
      }),
    );
    await detector.initialize();
    await detector.dispose();
    await detector.dispose();
    expect(releases).toBe(1);
    await expect(detector.detect("abcd")).rejects.toThrow(/disposed/);
  });

  it("rejects an explicitly aborted request before queued inference", async () => {
    const controller = new AbortController();
    const detector = new LocalTypoDetector(options());
    const pending = detector.detect("abcd", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(InferenceCancelledError);
    await detector.dispose();
  });

  it("cancels an active request when an empty input is checked", async () => {
    const detector = new LocalTypoDetector(
      options({ sessionFactory: async () => fakeSession(20) }),
    );
    const active = detector.detect("abcd");
    await expect(detector.detect(" ".slice(0, 0))).resolves.toMatchObject({
      detections: [],
    });
    await expect(active).rejects.toBeInstanceOf(InferenceCancelledError);
    await detector.dispose();
  });

  it("rejects non-finite confidence thresholds", () => {
    expect(
      () => new LocalTypoDetector(options({ confidenceThreshold: Number.NaN })),
    ).toThrow(RangeError);
  });

  it("rejects invalid max token and overlap limits", () => {
    for (const maxTokens of [
      Number.NaN,
      Infinity,
      2.5,
      2,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => new LocalTypoDetector(options({ maxTokens }))).toThrow(
        RangeError,
      );
    }
    for (const overlapTokens of [-1, Number.NaN, Infinity, 1.5]) {
      expect(() => new LocalTypoDetector(options({ overlapTokens }))).toThrow(
        RangeError,
      );
    }
  });

  it("rejects an explicit token limit above the safe tokenizer or SDK limit", () => {
    expect(
      () =>
        new LocalTypoDetector(
          options({
            tokenizer: { ...fakeTokenizer(), modelMaxLength: 4096 },
            maxTokens: 4097,
          }),
        ),
    ).toThrow(/maxTokens/);
    expect(() => new LocalTypoDetector(options({ maxTokens: 8193 }))).toThrow(
      /maxTokens/,
    );
  });

  it("uses valid tokenizer limits but caps unsafe defaults", () => {
    for (const modelMaxLength of [1e30, -1, 2, Number.NaN, Infinity, 16384]) {
      const { maxTokens: _maxTokens, ...withoutExplicitMax } = options({
        tokenizer: { ...fakeTokenizer(), modelMaxLength },
      });
      void _maxTokens;
      const detector = new LocalTypoDetector(withoutExplicitMax);
      expect((detector as unknown as { maxTokens: number }).maxTokens).toBe(
        8192,
      );
    }
    const { maxTokens: _maxTokens, ...withoutExplicitMax } = options({
      tokenizer: { ...fakeTokenizer(), modelMaxLength: 4096 },
    });
    void _maxTokens;
    const detector = new LocalTypoDetector(withoutExplicitMax);
    expect((detector as unknown as { maxTokens: number }).maxTokens).toBe(4096);
  });

  it("rejects inconsistent id2label and label2id mappings", () => {
    expect(
      () =>
        new LocalTypoDetector(
          options({
            labels: {
              id2label: { "0": "OK", "1": "substitution" },
              label2id: { OK: 0, substitution: 2 },
            },
          }),
        ),
    ).toThrow(/label mapping/);
  });

  it("honors an already-aborted signal even for empty input", async () => {
    const controller = new AbortController();
    controller.abort();
    const detector = new LocalTypoDetector(options());
    await expect(
      detector.detect("", { signal: controller.signal }),
    ).rejects.toBeInstanceOf(InferenceCancelledError);
    await detector.dispose();
  });

  it("honors cancellation while session initialization is pending", async () => {
    let resolveSession: ((session: InferenceSessionLike) => void) | undefined;
    let encodeCalls = 0;
    const base = fakeTokenizer();
    const detector = new LocalTypoDetector(
      options({
        tokenizer: {
          encode(text, encodeOptions = {}) {
            encodeCalls += 1;
            return base.encode(text, encodeOptions);
          },
        },
        sessionFactory: () =>
          new Promise((resolve) => {
            resolveSession = resolve;
          }),
      }),
    );
    const controller = new AbortController();
    const pending = detector.detect("a", { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    resolveSession?.(fakeSession());
    await expect(pending).rejects.toBeInstanceOf(InferenceCancelledError);
    expect(encodeCalls).toBe(0);
    await detector.dispose();
  });

  it("rejects an unexpected logits shape", async () => {
    const detector = new LocalTypoDetector(
      options({
        sessionFactory: async () => ({
          inputNames: ["input_ids"],
          outputNames: ["logits"],
          run: async () => ({ logits: { data: [1, 2], dims: [1, 1, 2] } }),
        }),
      }),
    );
    await expect(detector.detect("a")).rejects.toThrow(/logits shape/);
    await detector.dispose();
  });

  it("rejects offsets whose token count does not match IDs", async () => {
    const base = fakeTokenizer();
    const detector = new LocalTypoDetector(
      options({
        tokenizer: {
          encode(text, encodeOptions = {}) {
            const result = base.encode(
              text,
              encodeOptions,
            ) as TokenizerEncoding;
            if (encodeOptions.addSpecialTokens !== false)
              return { ...result, offsets: result.offsets.slice(1) };
            return result;
          },
        },
      }),
    );
    await expect(detector.detect("a")).rejects.toThrow(/offsets/);
    await detector.dispose();
  });

  it("supports models without attention masks and with token type IDs", async () => {
    const base = fakeTokenizer();
    const detector = new LocalTypoDetector(
      options({
        tokenizer: {
          encode(text, encodeOptions = {}) {
            const result = base.encode(
              text,
              encodeOptions,
            ) as TokenizerEncoding;
            if (encodeOptions.addSpecialTokens === false) return result;
            const { attentionMask: _attentionMask, ...withoutAttention } =
              result;
            void _attentionMask;
            return {
              ...withoutAttention,
              tokenTypeIds: Array.from(
                result.inputIds as ArrayLike<number>,
                () => 0,
              ),
            };
          },
        },
        sessionFactory: async () => ({
          inputNames: ["input_ids", "token_type_ids"],
          outputNames: ["logits"],
          run: async (feeds) => {
            expect(feeds.token_type_ids).toBeDefined();
            const length = (feeds.input_ids as { dims: number[] }).dims[1]!;
            return {
              logits: {
                data: new Float32Array(length * 3),
                dims: [1, length, 3],
              },
            };
          },
        }),
      }),
    );
    await expect(detector.detect("a")).resolves.toMatchObject({
      detections: [],
    });
    await detector.dispose();
  });

  it("fails on a sparse missing token offset", async () => {
    const base = fakeTokenizer();
    const detector = new LocalTypoDetector(
      options({
        tokenizer: {
          encode(text, encodeOptions = {}) {
            const result = base.encode(
              text,
              encodeOptions,
            ) as TokenizerEncoding;
            if (encodeOptions.addSpecialTokens === false) return result;
            const offsets = new Array(
              result.offsets.length,
            ) as typeof result.offsets;
            return { ...result, offsets };
          },
        },
      }),
    );
    await expect(detector.detect("a")).rejects.toThrow(/missing token offset/);
    await detector.dispose();
  });

  it("deduplicates overlapping chunk detections", async () => {
    const detector = new LocalTypoDetector(
      options({
        maxTokens: 5,
        overlapTokens: 1,
        sessionFactory: async () => ({
          inputNames: ["input_ids"],
          outputNames: ["logits"],
          run: async (feeds) => {
            const length = (feeds.input_ids as { dims: number[] }).dims[1]!;
            const logits = new Float32Array(length * 3);
            for (let index = 0; index < length; index += 1) {
              const typo = index === 1 || index === 3;
              logits[index * 3] = typo ? 0 : 5;
              logits[index * 3 + 1] = typo ? 5 : 0;
            }
            return { logits: { data: logits, dims: [1, length, 3] } };
          },
        }),
      }),
    );
    const result = await detector.detect("abcde");
    expect(result.detections.map(({ text }) => text)).toEqual(["a", "c", "e"]);
    await detector.dispose();
  });

  it("disposes feed and output tensors on success and shape failure", async () => {
    const dispose = vi.spyOn(ort.Tensor.prototype, "dispose");
    const validOutput = () =>
      new ort.Tensor("float32", new Float32Array(9), [1, 3, 3]);
    const validDetector = new LocalTypoDetector(
      options({
        sessionFactory: async () => ({
          inputNames: ["input_ids", "attention_mask"],
          outputNames: ["logits"],
          run: async () => ({ logits: validOutput() }),
        }),
      }),
    );
    await validDetector.detect("a");
    await validDetector.dispose();
    const afterSuccess = dispose.mock.calls.length;
    expect(afterSuccess).toBeGreaterThanOrEqual(3);

    const invalidDetector = new LocalTypoDetector(
      options({
        sessionFactory: async () => ({
          inputNames: ["input_ids", "attention_mask"],
          outputNames: ["logits"],
          run: async () => ({
            logits: new ort.Tensor("float32", new Float32Array(6), [1, 1, 6]),
          }),
        }),
      }),
    );
    await expect(invalidDetector.detect("a")).rejects.toThrow(/logits shape/);
    await invalidDetector.dispose();
    expect(dispose.mock.calls.length).toBeGreaterThan(afterSuccess);
    dispose.mockRestore();
  });

  it("disposes already-created feeds when a later feed fails to construct", async () => {
    const dispose = vi.spyOn(ort.Tensor.prototype, "dispose");
    const base = fakeTokenizer();
    const detector = new LocalTypoDetector(
      options({
        tokenizer: {
          encode(text, encodeOptions = {}) {
            const result = base.encode(
              text,
              encodeOptions,
            ) as TokenizerEncoding;
            if (encodeOptions.addSpecialTokens === false) return result;
            return {
              ...result,
              attentionMask: ["not-a-number"] as unknown as number[],
            };
          },
        },
      }),
    );
    await expect(detector.detect("a")).rejects.toThrow();
    expect(dispose).toHaveBeenCalled();
    await detector.dispose();
    dispose.mockRestore();
  });

  it("releases a session created after dispose races initialization", async () => {
    let releaseCount = 0;
    let resolveFactory: ((session: InferenceSessionLike) => void) | undefined;
    const detector = new LocalTypoDetector(
      options({
        sessionFactory: () =>
          new Promise((resolve) => {
            resolveFactory = resolve;
          }),
      }),
    );
    const initializing = detector.initialize();
    await Promise.resolve();
    const disposing = detector.dispose();
    resolveFactory?.({
      inputNames: [],
      outputNames: [],
      run: async () => ({}),
      release: () => {
        releaseCount += 1;
      },
    });
    await disposing;
    await expect(initializing).rejects.toThrow(/disposed/);
    expect(releaseCount).toBe(1);
  });

  it("waits for pending initialization before dispose resolves", async () => {
    let resolveFactory: ((session: InferenceSessionLike) => void) | undefined;
    let releaseCount = 0;
    const detector = new LocalTypoDetector(
      options({
        sessionFactory: () =>
          new Promise((resolve) => {
            resolveFactory = resolve;
          }),
      }),
    );
    const initializing = detector.initialize();
    await Promise.resolve();
    let disposed = false;
    const disposing = detector.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    resolveFactory?.({
      inputNames: [],
      outputNames: [],
      run: async () => ({}),
      release: () => {
        releaseCount += 1;
      },
    });
    await expect(initializing).rejects.toThrow(/disposed/);
    await disposing;
    expect(releaseCount).toBe(1);
  });

  it("propagates release failure for a session created during disposal", async () => {
    let resolveFactory: ((session: InferenceSessionLike) => void) | undefined;
    const detector = new LocalTypoDetector(
      options({
        sessionFactory: () =>
          new Promise((resolve) => {
            resolveFactory = resolve;
          }),
      }),
    );
    const initializing = detector.initialize();
    await Promise.resolve();
    const disposing = detector.dispose();
    resolveFactory?.({
      inputNames: [],
      outputNames: [],
      run: async () => ({}),
      release: () => {
        throw new Error("release-failed");
      },
    });
    await expect(initializing).rejects.toThrow(/disposed/);
    await expect(disposing).rejects.toThrow("release-failed");
  });

  it("also transfers a disposed WebGPU fallback session to disposal", async () => {
    let resolveWasm: ((session: InferenceSessionLike) => void) | undefined;
    const detector = new LocalTypoDetector(
      options({
        backend: "webgpu",
        sessionFactory: async (backend) => {
          if (backend === "webgpu") throw new Error("webgpu-unavailable");
          return new Promise<InferenceSessionLike>((resolve) => {
            resolveWasm = resolve;
          });
        },
      }),
    );
    const initializing = detector.initialize();
    await vi.waitFor(() => expect(resolveWasm).toBeDefined());
    const disposing = detector.dispose();
    resolveWasm?.({
      inputNames: [],
      outputNames: [],
      run: async () => ({}),
      release: () => {
        throw new Error("fallback-release-failed");
      },
    });
    await expect(initializing).rejects.toThrow(/disposed/);
    await expect(disposing).rejects.toThrow("fallback-release-failed");
  });

  it("waits for an active run before releasing the session", async () => {
    let resolveRun: (() => void) | undefined;
    let runEntered: (() => void) | undefined;
    let runDone = false;
    let releaseCalled = false;
    const detector = new LocalTypoDetector(
      options({
        sessionFactory: async () => ({
          inputNames: ["input_ids"],
          outputNames: ["logits"],
          run: async () => {
            runEntered?.();
            await new Promise<void>((resolve) => {
              resolveRun = resolve;
            });
            runDone = true;
            return {
              logits: {
                data: new Float32Array(9),
                dims: [1, 3, 3],
              },
            };
          },
          release: () => {
            releaseCalled = true;
            expect(runDone).toBe(true);
          },
        }),
      }),
    );
    const entered = new Promise<void>((resolve) => {
      runEntered = resolve;
    });
    const request = detector.detect("a");
    await entered;
    const disposing = detector.dispose();
    await Promise.resolve();
    expect(releaseCalled).toBe(false);
    resolveRun?.();
    await expect(request).rejects.toBeInstanceOf(InferenceCancelledError);
    await disposing;
    expect(releaseCalled).toBe(true);
  });

  it("shares one completion promise across concurrent dispose calls", async () => {
    let releaseEntered: (() => void) | undefined;
    let resolveRelease: (() => void) | undefined;
    const releaseStarted = new Promise<void>((resolve) => {
      releaseEntered = resolve;
    });
    const releaseFinished = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    const detector = new LocalTypoDetector(
      options({
        sessionFactory: async () => ({
          inputNames: [],
          outputNames: [],
          run: async () => ({}),
          release: async () => {
            releaseEntered?.();
            await releaseFinished;
          },
        }),
      }),
    );
    await detector.initialize();
    const first = detector.dispose();
    await releaseStarted;
    let secondSettled = false;
    const second = detector.dispose().then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    resolveRelease?.();
    await Promise.all([first, second]);
    expect(secondSettled).toBe(true);
  });

  it("removes external abort listeners after a request completes", async () => {
    const external = new AbortController();
    const add = vi.spyOn(external.signal, "addEventListener");
    const remove = vi.spyOn(external.signal, "removeEventListener");
    const detector = new LocalTypoDetector(options());
    await detector.detect("a", { signal: external.signal });
    expect(add).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
    await detector.dispose();
  });
});
