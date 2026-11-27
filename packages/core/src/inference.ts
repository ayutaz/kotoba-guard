import * as ort from "onnxruntime-web";
import type {
  InferenceBackend,
  InferenceSessionLike,
  LogitsTensorLike,
  SessionFactory,
} from "./types.js";

export function createOrtSessionFactory(
  model: string | URL | ArrayBuffer,
  options: { wasmThreads?: number; wasmPath?: string } = {},
): SessionFactory {
  return async (backend: InferenceBackend): Promise<InferenceSessionLike> => {
    const executionProviders =
      backend === "webgpu" ? (["webgpu"] as const) : (["wasm"] as const);
    if (options.wasmThreads !== undefined)
      ort.env.wasm.numThreads = options.wasmThreads;
    if (options.wasmPath !== undefined)
      ort.env.wasm.wasmPaths = options.wasmPath;
    const modelSource = model instanceof URL ? model.toString() : model;
    // The current ORT declaration only exposes the Uint8Array overload even
    // though the browser runtime also accepts a URL/string model source.
    const session = await ort.InferenceSession.create(
      modelSource as unknown as Uint8Array<ArrayBufferLike>,
      { executionProviders: [...executionProviders] },
    );
    return session as unknown as InferenceSessionLike;
  };
}

export function createTensor(
  type: "int64" | "int32",
  data: readonly number[] | ArrayLike<number | bigint>,
  dims: readonly number[],
): unknown {
  const values = Array.from(data, (value) => Number(value));
  if (type === "int64")
    return new ort.Tensor(
      "int64",
      BigInt64Array.from(values, (value) => BigInt(value)),
      [...dims],
    );
  return new ort.Tensor("int32", Int32Array.from(values), dims);
}

export function readLogits(
  outputs: Record<string, LogitsTensorLike>,
  names: readonly string[],
): LogitsTensorLike {
  for (const name of ["logits", ...names]) {
    const candidate = outputs[name];
    if (candidate && candidate.dims.length === 3) return candidate;
  }
  const candidate = Object.values(outputs).find(
    (value) => value.dims.length === 3,
  );
  if (!candidate)
    throw new Error("ONNX model did not return a rank-3 logits tensor");
  return candidate;
}
