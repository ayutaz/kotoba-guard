import { describe, expect, it } from "vitest";

import {
  argsFrom,
  graphOptimizationReport,
  installLogitsValidator,
  parseWasmGraphOptimization,
  wasmSessionOptions,
} from "./browser_corpus_parity.mjs";

describe("browser logits dtype validation", () => {
  function helper() {
    const target: Record<string, unknown> = {};
    const installed = installLogitsValidator(target) as (tensor: unknown) => {
      reported_dtype: string | null;
      actual_dtype: string | null;
      dtype_match: boolean;
      values: number[];
    };
    expect(target.__kotobaGuardSummarizeFloat32Logits).toBe(installed);
    return installed;
  }

  it("accepts an ORT float32 tensor backed by Float32Array", () => {
    expect(
      helper()({
        type: "float32",
        data: new Float32Array([1, 2]),
      }),
    ).toEqual({
      reported_dtype: "float32",
      actual_dtype: "float32",
      dtype_match: true,
      values: [1, 2],
    });
  });

  it.each([
    { type: "float32", data: new Float64Array([1]), actual: "Float64Array" },
    { type: "float64", data: new Float32Array([1]), actual: "float32" },
    { type: "float32", data: [1], actual: "Array" },
  ])("rejects a logits dtype mismatch: %o", ({ type, data, actual }) => {
    expect(helper()({ type, data })).toMatchObject({
      reported_dtype: type,
      actual_dtype: actual,
      dtype_match: false,
    });
  });
});

describe("WASM graph optimization parity options", () => {
  it("keeps the default unset and accepts the two explicit levels", () => {
    expect(parseWasmGraphOptimization(undefined)).toBeUndefined();
    expect(parseWasmGraphOptimization("all")).toBe("all");
    expect(parseWasmGraphOptimization("disabled")).toBe("disabled");
  });

  it.each(["basic", "true", "", true, null])(
    "rejects an invalid or missing flag value: %p",
    (value) => {
      expect(() => parseWasmGraphOptimization(value)).toThrow(
        "requires exactly 'all' or 'disabled'",
      );
    },
  );

  it("treats a flag without a following value as invalid", () => {
    const values = argsFrom(["--wasm-graph-optimization"]) as Record<
      string,
      unknown
    >;
    expect(values["wasm-graph-optimization"]).toBe(true);
    expect(() =>
      parseWasmGraphOptimization(values["wasm-graph-optimization"]),
    ).toThrow("requires exactly 'all' or 'disabled'");
  });

  it("does not add a session option when the flag is omitted", () => {
    expect(wasmSessionOptions(undefined)).toEqual({
      executionProviders: ["wasm"],
    });
  });

  it.each(["all", "disabled"])(
    "passes the requested level to direct ORT Web creation: %s",
    (level) => {
      expect(wasmSessionOptions(level)).toEqual({
        executionProviders: ["wasm"],
        graphOptimizationLevel: level,
      });
    },
  );

  it("records the SDK default without claiming an observed effective level", () => {
    expect(graphOptimizationReport(undefined, false)).toEqual({
      requested: null,
      session_option: null,
      effective: null,
      evidence:
        "SDK session factory default; internal optimized graph not observed",
    });
  });

  it("records the direct ORT option separately from the unobserved effective level", () => {
    expect(graphOptimizationReport("disabled", true)).toEqual({
      requested: "disabled",
      session_option: "disabled",
      effective: null,
      evidence:
        "ORT session accepted supplied options; internal optimized graph not observed",
    });
  });

  it("distinguishes direct ORT without an explicit override", () => {
    expect(graphOptimizationReport(undefined, true)).toEqual({
      requested: null,
      session_option: null,
      effective: null,
      evidence:
        "Direct ORT session used without graph optimization override; internal optimized graph not observed",
    });
  });
});
