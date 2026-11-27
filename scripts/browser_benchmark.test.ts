import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessThreadConfiguration,
  assertCandidateOutputAvailable,
  buildExtensionProvenance,
  parseArgs,
  resolveBenchmarkConfig,
  resolveOrtWebVersion,
  resolveSourceCommit,
  summarizeProcessMemory,
  verifyAssetManifest,
  verifyManifestIdentity,
  verifyModelManifest,
} from "./browser_benchmark.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("browser benchmark CLI", () => {
  it("records an explicit bounded token-length scope without changing the default", () => {
    expect(resolveBenchmarkConfig({}).tokenLengths).toEqual([
      32, 64, 128, 256, 512, 1024,
    ]);
    const parsed = parseArgs([
      "--token-lengths",
      "128",
      "--output",
      "artifacts/fresh.json",
    ]);
    expect(resolveBenchmarkConfig(parsed).tokenLengths).toEqual([128]);
    expect(() =>
      resolveSourceCommit(resolveBenchmarkConfig(parsed), {}),
    ).toThrow(/40-hex/);
  });
  it.each(["", "0", "127", "128,128", "128,", "1e2", "128.0", "128,999999"])(
    "rejects malformed/unsupported token lengths %s",
    (value) => {
      expect(() =>
        resolveBenchmarkConfig({
          "token-lengths": value,
          output: "artifacts/fresh.json",
        }),
      ).toThrow();
    },
  );
  it("requires an explicit output for a changed length scope", () => {
    expect(() => resolveBenchmarkConfig({ "token-lengths": "128" })).toThrow(
      /explicit --output/,
    );
  });
  it("accepts only the matching supported FP16-storage candidate identity", () => {
    const config = resolveBenchmarkConfig({
      extension: ".cache/fresh",
      "model-kind": "embedding-u8-matmul-fp16-storage",
      output: "artifacts/fresh.json",
    });
    const manifest = {
      model_id: "sbintuitions/ja-typo-detector-modernbert-ja-base-30m",
      revision: "8d640720bddeb64c89dc1fa7780c3ea29fa523e8",
      model_kind: "embedding-u8-matmul-fp16-storage",
      conversion: {
        schema_version: "weight-only-matmul-fp16-storage-v1",
        options: {
          embedding_dequantize_after_gather: true,
          matmul_fp16_storage: true,
          matmul_storage_dtype: "FLOAT16",
          matmul_compute_dtype: "FLOAT",
          activation_dtype: "FLOAT",
        },
      },
    };
    expect(() => verifyManifestIdentity(manifest, config)).not.toThrow();
    expect(() =>
      verifyManifestIdentity({ ...manifest, conversion: undefined }, config),
    ).toThrow();
    expect(() =>
      verifyManifestIdentity(
        {
          ...manifest,
          conversion: {
            ...manifest.conversion,
            options: {
              ...manifest.conversion.options,
              matmul_compute_dtype: "FLOAT16",
            },
          },
        },
        config,
      ),
    ).toThrow();
    expect(() =>
      verifyManifestIdentity(
        { ...manifest, model_kind: "weight-only-qdq" },
        config,
      ),
    ).toThrow();
    expect(() =>
      verifyManifestIdentity(
        { ...manifest, model_kind: "arbitrary" },
        { ...config, modelKind: "arbitrary" },
      ),
    ).toThrow();
  });
  it("keeps unavailable process-memory metrics null rather than measured zero", () => {
    expect(
      summarizeProcessMemory(
        { status: "unavailable", rows: [] },
        { status: "unavailable", rows: [] },
      ),
    ).toMatchObject({
      measured: false,
      baselineBytes: null,
      currentBytes: null,
      hwmSumBytes: null,
    });
    expect(
      summarizeProcessMemory(
        { status: "measured", rows: [] },
        { status: "measured", rows: [{ currentBytes: 20, peakBytes: 30 }] },
      ).measured,
    ).toBe(false);
  });

  it("parses candidate model and output options", () => {
    const parsed = parseArgs([
      "--extension",
      ".cache/candidate",
      "--model-relative",
      "models/onnx/model_weight_only.onnx",
      "--model-manifest",
      "models/candidate-manifest.json",
      "--model-kind",
      "weight-only-qdq",
      "--output",
      "artifacts/candidate-benchmark.json",
      "--wasm-threads",
      "2",
    ]);
    const config = resolveBenchmarkConfig(parsed);
    expect(config.candidate).toBe(true);
    expect(config.modelRelative).toBe("models/onnx/model_weight_only.onnx");
    expect(config.manifestRelative).toBe("models/candidate-manifest.json");
    expect(config.modelKind).toBe("weight-only-qdq");
    expect(config.wasmThreads).toBe(2);
  });

  it("accepts only the supported WASM thread counts", () => {
    expect(resolveBenchmarkConfig({}).wasmThreads).toBe(1);
    expect(() => resolveBenchmarkConfig({ "wasm-threads": "3" })).toThrow(
      /one of 1, 2, or 4/,
    );
  });

  it("requires an explicit output and fixed candidate kind", () => {
    expect(() =>
      resolveBenchmarkConfig({
        extension: ".cache/candidate",
        "model-kind": "weight-only-qdq",
      }),
    ).toThrow(/explicit --output/);
    expect(() =>
      resolveBenchmarkConfig({
        extension: ".cache/candidate",
        output: "artifacts/candidate.json",
      }),
    ).toThrow(/explicit --model-kind/);
  });

  it("requires a 40-hex source commit for candidate runs", () => {
    const config = resolveBenchmarkConfig({
      extension: ".cache/candidate",
      "model-kind": "weight-only-qdq",
      output: "artifacts/candidate.json",
    });
    expect(() =>
      resolveSourceCommit(config, { SOURCE_COMMIT: "short" }),
    ).toThrow(/40-hex/);
    expect(resolveSourceCommit(config, { GITHUB_SHA: "a".repeat(40) })).toBe(
      "a".repeat(40),
    );
  });

  it("requires pinned identity and manifest-bound asset hashes", () => {
    const config = resolveBenchmarkConfig({
      extension: ".cache/candidate",
      "model-kind": "weight-only-qdq",
      output: "artifacts/candidate.json",
    });
    const manifest = {
      model_id: "sbintuitions/ja-typo-detector-modernbert-ja-base-30m",
      revision: "8d640720bddeb64c89dc1fa7780c3ea29fa523e8",
      model_kind: "weight-only-qdq",
      files: {
        "config.json": { bytes: 1, sha256: "a".repeat(64) },
      },
    };
    expect(() => verifyManifestIdentity(manifest, config)).not.toThrow();
    expect(() =>
      verifyAssetManifest(manifest, {
        "models/config.json": { bytes: 1, sha256: "a".repeat(64) },
      }),
    ).not.toThrow();
    expect(() =>
      verifyAssetManifest(manifest, {
        "models/config.json": { bytes: 2, sha256: "a".repeat(64) },
      }),
    ).toThrow(/asset size or SHA-256/);
  });

  it("records the locked ORT Web version and process-memory scope", () => {
    expect(
      resolveOrtWebVersion({
        packages: {
          "node_modules/onnxruntime-web": { version: "1.31.1" },
        },
      }),
    ).toBe("1.31.1");
    const memory = summarizeProcessMemory(
      {
        status: "measured",
        rows: [{ currentBytes: 10, peakBytes: 12 }],
      },
      {
        status: "measured",
        rows: [{ currentBytes: 20, peakBytes: 30 }],
      },
    );
    expect(memory).toMatchObject({
      measured: true,
      baselineBytes: 10,
      currentBytes: 20,
      hwmSumBytes: 30,
    });
  });

  it("fails an isolated-thread experiment when isolation or ORT fallback is absent", () => {
    expect(
      assessThreadConfiguration({
        requested: 2,
        effective: 1,
        crossOriginIsolated: false,
        sharedArrayBufferAvailable: false,
      }),
    ).toMatchObject({
      status: "failed",
      failures: [
        "ort-num-threads-fallback",
        "cross-origin-isolation-unavailable",
        "shared-array-buffer-unavailable",
      ],
      workerEventsAreDiagnosticOnly: true,
    });
    expect(
      assessThreadConfiguration({
        requested: 4,
        effective: 4,
        crossOriginIsolated: true,
        sharedArrayBufferAvailable: true,
      }).status,
    ).toBe("passed");
  });

  it("binds model size and SHA to the selected manifest entry", () => {
    const manifest = {
      files: {
        "onnx/model_weight_only.onnx": {
          bytes: 12,
          sha256: "a".repeat(64),
        },
      },
    };
    expect(
      verifyModelManifest(manifest, "models/onnx/model_weight_only.onnx", {
        bytes: 12,
        sha256: "a".repeat(64),
      }),
    ).toEqual(manifest.files["onnx/model_weight_only.onnx"]);
    expect(() =>
      verifyModelManifest(manifest, "models/onnx/model_weight_only.onnx", {
        bytes: 13,
        sha256: "a".repeat(64),
      }),
    ).toThrow(/size or SHA-256/);
  });

  it("records source commit, runtime model identity, and asset hashes", () => {
    const provenance = buildExtensionProvenance({
      rootDir: "C:/repo",
      extensionDir: "C:/repo/dist/extension",
      manifestPath: "C:/repo/.cache/candidate/models/candidate-manifest.json",
      modelManifest: {
        model_id: "example/model",
        revision: "a".repeat(40),
        model_kind: "weight-only-qdq",
      },
      modelRelative: "models/onnx/model_weight_only.onnx",
      modelKind: "weight-only-qdq",
      modelStats: { bytes: 12, sha256: "b".repeat(64) },
      assets: {
        "models/config.json": { bytes: 1, sha256: "c".repeat(64) },
        "wasm/ort-wasm-simd-threaded.wasm": {
          bytes: 2,
          sha256: "d".repeat(64),
        },
      },
      sourceCommit: "f".repeat(40),
    });
    expect(provenance).toMatchObject({
      sourceCommit: "f".repeat(40),
      modelRevision: "a".repeat(40),
      modelKind: "weight-only-qdq",
      model: { bytes: 12, sha256: "b".repeat(64) },
    });
    expect(provenance.assets["wasm/ort-wasm-simd-threaded.wasm"]).toEqual({
      bytes: 2,
      sha256: "d".repeat(64),
    });
  });

  it("refuses to overwrite an existing candidate output", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "kotoba-guard-browser-benchmark-test-"),
    );
    temporaryDirectories.push(directory);
    const output = path.join(directory, "candidate.json");
    await writeFile(output, "existing\n", "utf8");
    await expect(
      assertCandidateOutputAvailable({
        candidate: true,
        artifactPath: output,
      }),
    ).rejects.toThrow(/refusing to overwrite candidate output/);
    await expect(
      assertCandidateOutputAvailable(
        resolveBenchmarkConfig({
          "token-lengths": "128",
          output,
        }),
      ),
    ).rejects.toThrow(/refusing to overwrite/);
  });
});
