import * as ort from "onnxruntime-web";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOrtSessionFactory,
  createTensor,
  readLogits,
} from "../src/inference.js";

afterEach(() => vi.restoreAllMocks());

describe("browser inference helpers", () => {
  it("creates typed int64 and int32 tensors with stable dimensions", () => {
    const int64 = createTensor("int64", [1, 2], [1, 2]) as ort.Tensor;
    const int32 = createTensor("int32", [3, 4], [2]) as ort.Tensor;
    expect(int64.type).toBe("int64");
    expect(Array.from(int64.data as BigInt64Array)).toEqual([1n, 2n]);
    expect(int64.dims).toEqual([1, 2]);
    expect(int32.type).toBe("int32");
    expect(Array.from(int32.data as Int32Array)).toEqual([3, 4]);
    expect(int32.dims).toEqual([2]);
  });

  it("selects named rank-3 logits and rejects missing rank-3 output", () => {
    const logits = { data: [1], dims: [1, 1, 1] };
    expect(readLogits({ other: logits }, ["other"])).toBe(logits);
    expect(() =>
      readLogits({ other: { data: [1], dims: [1, 1] } }, []),
    ).toThrow(/rank-3 logits/);
  });

  it("configures the requested execution provider and local WASM path", async () => {
    const session = {
      inputNames: [],
      outputNames: [],
      run: async () => ({}),
    };
    const create = vi
      .spyOn(ort.InferenceSession, "create")
      .mockResolvedValue(session as never);
    const factory = createOrtSessionFactory("model.onnx", {
      wasmThreads: 2,
      wasmPath: "/extension/wasm/",
    });
    await expect(factory("wasm")).resolves.toBe(session);
    expect(create).toHaveBeenLastCalledWith("model.onnx", {
      executionProviders: ["wasm"],
    });
    await expect(factory("webgpu")).resolves.toBe(session);
    expect(create).toHaveBeenLastCalledWith("model.onnx", {
      executionProviders: ["webgpu"],
    });
    expect(ort.env.wasm.numThreads).toBe(2);
    expect(ort.env.wasm.wasmPaths).toBe("/extension/wasm/");
  });
});
