import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  argsFrom,
  assertOutputAbsent,
  compareOutput,
  firstDivergence,
  parseGraphOptimization,
  parseNpy,
  parseNpz,
  validateCpuReportCapture,
  validateCaptureOutputs,
  validateModelRelative,
} from "./browser_intermediate_parity.mjs";

function npyFloat32(values: number[], shape: number[]) {
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(", ")},), }`;
  const prefix = Buffer.from("\x93NUMPY\x01\x00", "latin1");
  const headerLength = header.length + 1;
  const padding = (16 - ((prefix.length + 2 + headerLength) % 16)) % 16;
  const fullHeader = `${header}${" ".repeat(padding)}\n`;
  const headerBytes = Buffer.from(fullHeader, "latin1");
  const output = Buffer.alloc(
    prefix.length + 2 + headerBytes.length + values.length * 4,
  );
  prefix.copy(output);
  output.writeUInt16LE(headerBytes.length, prefix.length);
  headerBytes.copy(output, prefix.length + 2);
  values.forEach((value, index) =>
    output.writeFloatLE(
      value,
      prefix.length + 2 + headerBytes.length + index * 4,
    ),
  );
  return output;
}

function npzStored(name: string, data: Buffer) {
  const filename = Buffer.from(`${name}.npy`, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(10, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30);
  return Buffer.concat([local, filename, data]);
}

function npzStoredZip64(name: string, data: Buffer) {
  const filename = Buffer.from(`${name}.npy`, "utf8");
  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(BigInt(data.length), 4);
  extra.writeBigUInt64LE(BigInt(data.length), 12);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(45, 4);
  local.writeUInt32LE(0xffffffff, 18);
  local.writeUInt32LE(0xffffffff, 22);
  local.writeUInt16LE(filename.length, 26);
  local.writeUInt16LE(extra.length, 28);
  return Buffer.concat([local, filename, extra, data]);
}

describe("quantized intermediate parity helpers", () => {
  const numpyTwoArrayNpz =
    "UEsDBC0AAAAAAAAAIQCayqvn//////////8MABQAb3V0cHV0XzAubnB5AQAQAIgAAAAAAAAAiAAAAAAAAACTTlVNUFkBAHYAeydkZXNjcic6ICc8ZjQnLCAnZm9ydHJhbl9vcmRlcic6IEZhbHNlLCAnc2hhcGUnOiAoMiwpLCB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCgAAgD8AAABAUEsDBC0AAAAAAAAAIQDVxTCE//////////8MABQAb3V0cHV0XzEubnB5AQAQAIIAAAAAAAAAggAAAAAAAACTTlVNUFkBAHYAeydkZXNjcic6ICd8dTEnLCAnZm9ydHJhbl9vcmRlcic6IEZhbHNlLCAnc2hhcGUnOiAoMiwpLCB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCgMEUEsBAi0ALQAAAAAAAAAhAJrKq+eIAAAAiAAAAAwAAAAAAAAAAAAAAIABAAAAAG91dHB1dF8wLm5weVBLAQItAC0AAAAAAAAAIQDVxTCEggAAAIIAAAAMAAAAAAAAAAAAAACAAcYAAABvdXRwdXRfMS5ucHlQSwUGAAAAAAIAAgB0AAAAhgEAAAAA";

  it("fails before a browser report can overwrite an existing file", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "kotoba-guard-test-"),
    );
    const output = path.join(directory, "report.json");
    try {
      await writeFile(output, "existing", "utf8");
      await expect(assertOutputAbsent(output)).rejects.toThrow(
        /already exists/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires an explicit supported graph optimization level", () => {
    expect(parseGraphOptimization(undefined)).toBe("all");
    expect(parseGraphOptimization("disabled")).toBe("disabled");
    expect(() => parseGraphOptimization("basic")).toThrow(/exactly/);
    expect(argsFrom(["--graph-optimization", "disabled"])).toEqual({
      "graph-optimization": "disabled",
    });
  });

  it("rejects unsafe baseline and instrumented model paths", () => {
    expect(validateModelRelative("models/onnx/model.onnx", "--model")).toBe(
      "models/onnx/model.onnx",
    );
    for (const value of [
      "../model.onnx",
      "..\\model.onnx",
      "C:\\model.onnx",
      "/model.onnx",
    ]) {
      expect(() => validateModelRelative(value, "--model")).toThrow(
        /cannot traverse/,
      );
    }
  });

  it("allowlists capture profile output names and rejects arbitrary reports", () => {
    expect(
      validateCaptureOutputs("block-boundaries", [
        "add_7",
        "add_11",
        "add_15",
        "add_19",
        "add_23",
        "add_27",
        "add_31",
        "add_35",
        "add_39",
        "add_43",
      ]),
    ).toHaveLength(10);
    const blockZero = [
      "layer_norm",
      "layer_norm_quantized",
      "layer_norm_scale",
      "layer_norm_zero_point",
      "node_linear_quant_scales_mul:0",
      "linear_output_quantized",
      "linear_output_quantized_cast_output",
      "linear",
      "view_2",
      "view_2_quantized",
      "view_2_scale",
      "view_2_zero_point",
      "node_linear_1_quant_scales_mul:0",
      "linear_1_output_quantized",
      "linear_1_output_quantized_cast_output",
      "linear_1",
      "layer_norm_1",
      "layer_norm_1_quantized",
      "layer_norm_1_scale",
      "layer_norm_1_zero_point",
      "node_linear_2_quant_scales_mul:0",
      "linear_2_output_quantized",
      "linear_2_output_quantized_cast_output",
      "linear_2",
      "mul_29",
      "mul_29_quantized",
      "mul_29_scale",
      "mul_29_zero_point",
      "node_linear_3_quant_scales_mul:0",
      "linear_3_output_quantized",
      "linear_3_output_quantized_cast_output",
      "linear_3",
    ];
    expect(
      validateCpuReportCapture({
        capture_profile: "block-0",
        intermediate_output_order: blockZero,
      }),
    ).toMatchObject({ profile: "block-0", outputs: blockZero });
    const classifier = [
      "layer_norm_20",
      "layer_norm_20_quantized",
      "layer_norm_20_scale",
      "layer_norm_20_zero_point",
      "node_linear_40_quant_scales_mul:0",
      "linear_40_output_quantized",
      "linear_40_output_quantized_cast_output",
      "linear_40",
      "layer_norm_21",
      "layer_norm_21_quantized",
      "layer_norm_21_scale",
      "layer_norm_21_zero_point",
      "node_MatMul_1201_quant_scales_mul:0",
      "val_1245_output_quantized",
      "val_1245_output_quantized_cast_output",
      "val_1245",
    ];
    expect(
      validateCpuReportCapture({
        capture_profile: "classifier",
        intermediate_output_order: classifier,
      }),
    ).toMatchObject({ profile: "classifier", outputs: classifier });
    expect(() => validateCaptureOutputs("block-0", ["arbitrary"])).toThrow(
      /allowlisted/,
    );
    expect(() => validateCaptureOutputs("first-pair", ["linear"])).toThrow(
      /allowlisted/,
    );
  });

  it("parses the numeric NPY payload without any text field", () => {
    const parsed = parseNpy(npyFloat32([1.5, -2], [2]));
    expect(parsed.dtype).toBe("<f4");
    expect(parsed.shape).toEqual([2]);
    expect(parsed.values).toEqual([1.5, -2]);
    expect(parsed).not.toHaveProperty("text");
  });

  it("rejects unsafe NPY layout, dtype, and shape claims", () => {
    const fortran = npyFloat32([1, 2], [2])
      .toString("latin1")
      .replace("fortran_order': False", "fortran_order': True ");
    const fortranBytes = Buffer.from(fortran, "latin1");
    expect(() => parseNpy(fortranBytes)).toThrow(/Fortran/);

    const unknown = npyFloat32([1, 2], [2])
      .toString("latin1")
      .replace("'descr': '<f4'", "'descr': '<f3'");
    expect(() => parseNpy(Buffer.from(unknown, "latin1"))).toThrow(/dtype/);

    const wrongShape = npyFloat32([1, 2], [2])
      .toString("latin1")
      .replace("'shape': (2,)", "'shape': (3,)");
    expect(() => parseNpy(Buffer.from(wrongShape, "latin1"))).toThrow(/length/);
  });

  it("parses a stored NPZ entry and compares integer and float outputs", () => {
    const npz = parseNpz(
      Buffer.concat([
        npzStored("output_0", npyFloat32([1, 2], [1, 2])),
        npzStored("output_1", npyFloat32([3, 4], [1, 2])),
      ]),
    );
    expect(npz.get("output_0")?.values).toEqual([1, 2]);
    expect(npz.get("output_1")?.values).toEqual([3, 4]);
    const zip64 = parseNpz(
      npzStoredZip64("output_zip64", npyFloat32([5, 6], [1, 2])),
    );
    expect(zip64.get("output_zip64")?.values).toEqual([5, 6]);
    const actualNumpy = parseNpz(Buffer.from(numpyTwoArrayNpz, "base64"));
    expect(actualNumpy.get("output_0")?.values).toEqual([1, 2]);
    expect(actualNumpy.get("output_1")?.values).toEqual([3, 4]);

    const integer = compareOutput(
      { dtype: "|u1", shape: [2], values: [1, 2] },
      { dtype: "uint8", shape: [2], values: [1, 3] },
    );
    expect(integer).toMatchObject({
      dtype_match: true,
      exact_mismatch_count: 1,
      first_mismatch_index: 1,
    });

    const floating = compareOutput(
      { dtype: "<f4", shape: [2], values: [1, 3] },
      { dtype: "float32", shape: [2], values: [1.25, 2] },
    );
    expect(floating).toMatchObject({
      dtype_match: true,
      max_abs_delta: 1,
      mean_abs_delta: 0.625,
    });

    expect(
      compareOutput(
        { dtype: "uint8", shape: [1], values: [1] },
        { dtype: "int32", shape: [1], values: [1] },
      ),
    ).toMatchObject({ dtype_match: false, exact_mismatch_count: null });
  });

  it("selects the first divergent output in the fixed order", () => {
    expect(
      firstDivergence(["logits", "layer_norm", "linear"], {
        logits: {
          max_abs_delta: 0.0001,
          exact_mismatch_count: 0,
          shape_match: true,
          dtype_match: true,
          finite: true,
        },
        layer_norm: {
          max_abs_delta: 0.2,
          exact_mismatch_count: 0,
          shape_match: true,
          dtype_match: true,
          finite: true,
        },
        linear: {
          max_abs_delta: 4,
          exact_mismatch_count: 0,
          shape_match: true,
          dtype_match: true,
          finite: true,
        },
      }),
    ).toBe("layer_norm");
    expect(
      firstDivergence(["logits"], {
        logits: {
          max_abs_delta: 0,
          shape_match: true,
          dtype_match: true,
          finite: true,
        },
      }),
    ).toBeNull();
  });

  it("compares serialized browser output dimensions", () => {
    expect(
      compareOutput(
        { dtype: "<f4", shape: [1, 2], values: [1, 2] },
        { dtype: "float32", shape: [1, 2], values: [1, 2] },
      ),
    ).toMatchObject({ shape_match: true, dtype_match: true, finite: true });
  });
});
