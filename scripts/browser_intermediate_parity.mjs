/* global chrome */
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_SHA256 =
  "dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab";
const FIXTURE_SHA256 =
  "4bc05c93b39be219eeff70f57a8da18fd85271b74fec4be4a156800f49e72f47";
const INTERMEDIATE_OUTPUTS = [
  "layer_norm",
  "layer_norm_quantized",
  "layer_norm_scale",
  "layer_norm_zero_point",
  "linear_output_quantized",
  "linear_output_quantized_cast_output",
  "node_linear_quant_scales_mul:0",
  "linear",
];
const BLOCK_BOUNDARY_OUTPUTS = Array.from(
  { length: 10 },
  (_, index) => `add_${7 + index * 4}`,
);
const CAPTURE_PROFILES = new Set([
  "first-pair",
  "block-boundaries",
  "classifier",
  ...Array.from({ length: 10 }, (_, index) => `block-${index}`),
]);

function argsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const next = argv[index + 1];
    values[argv[index].slice(2)] =
      next === undefined || next.startsWith("--") ? true : argv[++index];
  }
  return values;
}

function parseGraphOptimization(value) {
  if (value === undefined) return "all";
  if (value !== "all" && value !== "disabled") {
    throw new Error(
      "--graph-optimization requires exactly 'all' or 'disabled'",
    );
  }
  return value;
}

function validateModelRelative(value, optionName) {
  if (
    typeof value !== "string" ||
    path.isAbsolute(value) ||
    value.includes("..") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(
      `${optionName} is required and cannot traverse directories`,
    );
  }
  return value;
}

function validateCaptureOutputs(profile, names) {
  if (
    !CAPTURE_PROFILES.has(profile) ||
    !Array.isArray(names) ||
    names.length === 0
  )
    throw new Error("CPU report capture profile is invalid");
  const expected =
    profile === "first-pair"
      ? INTERMEDIATE_OUTPUTS
      : profile === "block-boundaries"
        ? BLOCK_BOUNDARY_OUTPUTS
        : null;
  if (expected && JSON.stringify(names) !== JSON.stringify(expected))
    throw new Error("CPU report output order is not allowlisted");
  if (profile !== "first-pair" && profile !== "block-boundaries") {
    const indices =
      profile === "classifier"
        ? [40, 41]
        : Array.from(
            { length: 4 },
            (_, index) => Number(profile.slice("block-".length)) * 4 + index,
          );
    const expectedNames = [];
    for (const pathIndex of indices) {
      let source;
      if (pathIndex === 0) source = "layer_norm";
      else if (pathIndex === 1) source = "view_2";
      else if (pathIndex === 2) source = "layer_norm_1";
      else if (pathIndex === 3) source = "mul_29";
      else if (pathIndex === 40) source = "layer_norm_20";
      else if (pathIndex === 41) source = "layer_norm_21";
      else {
        const block = Math.floor(pathIndex / 4);
        const offset = pathIndex % 4;
        source =
          offset === 0
            ? `layer_norm_${block * 2}`
            : offset === 1
              ? `view_${block * 3 + 2}`
              : offset === 2
                ? `layer_norm_${block * 2 + 1}`
                : `mul_${block * 24 + 29}`;
      }
      if (pathIndex === 41) {
        expectedNames.push(
          source,
          `${source}_quantized`,
          `${source}_scale`,
          `${source}_zero_point`,
          "node_MatMul_1201_quant_scales_mul:0",
          "val_1245_output_quantized",
          "val_1245_output_quantized_cast_output",
          "val_1245",
        );
      } else {
        const suffix = pathIndex === 0 ? "" : `_${pathIndex}`;
        expectedNames.push(
          source,
          `${source}_quantized`,
          `${source}_scale`,
          `${source}_zero_point`,
          `node_linear${suffix}_quant_scales_mul:0`,
          `linear${suffix}_output_quantized`,
          `linear${suffix}_output_quantized_cast_output`,
          `linear${suffix}`,
        );
      }
    }
    if (JSON.stringify(names) !== JSON.stringify(expectedNames))
      throw new Error("CPU report output names are not allowlisted");
  }
  if (new Set(names).size !== names.length)
    throw new Error("CPU report output order contains duplicates");
  return names;
}

function validateCpuReportCapture(report) {
  const profile = report?.capture_profile ?? "first-pair";
  return {
    profile,
    outputs: validateCaptureOutputs(profile, report?.intermediate_output_order),
  };
}

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function readU16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readU32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function readZip64CompressedSize(
  extra,
  compressedSentinel,
  uncompressedSentinel,
) {
  if (!compressedSentinel) return null;
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const fieldId = extra.readUInt16LE(offset);
    const fieldLength = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + fieldLength > extra.length)
      throw new Error("truncated ZIP extra field");
    if (fieldId === 0x0001) {
      let fieldOffset = offset;
      if (uncompressedSentinel) fieldOffset += 8;
      if (fieldOffset + 8 > offset + fieldLength)
        throw new Error("ZIP64 compressed size is missing");
      const size = Number(extra.readBigUInt64LE(fieldOffset));
      if (!Number.isSafeInteger(size))
        throw new Error("ZIP64 size is too large");
      return size;
    }
    offset += fieldLength;
  }
  throw new Error("ZIP64 compressed size is missing");
}

function parseNpy(buffer) {
  if (buffer.length < 10) throw new Error("truncated NPY header");
  if (buffer.subarray(0, 6).toString("latin1") !== "\x93NUMPY") {
    throw new Error("invalid NPY magic");
  }
  const major = buffer[6];
  if (major !== 1 && major !== 2) throw new Error("unsupported NPY version");
  const headerLength = major === 1 ? readU16(buffer, 8) : readU32(buffer, 8);
  const headerStart = major === 1 ? 10 : 12;
  if (headerStart + headerLength > buffer.length)
    throw new Error("truncated NPY header");
  const header = buffer
    .subarray(headerStart, headerStart + headerLength)
    .toString("latin1");
  const dtype = header.match(/'descr':\s*'([^']+)'/)?.[1];
  const fortran = header.match(/'fortran_order':\s*(True|False)/)?.[1];
  const shapeText = header.match(/'shape':\s*\(([^)]*)\)/)?.[1];
  if (!dtype || fortran === undefined || shapeText === undefined)
    throw new Error("invalid NPY header");
  if (fortran === "True") throw new Error("Fortran-order NPY is unsupported");
  if (!/^(?:<(?:f4|f8|i1|u1|i2|u2|i4|u4|i8|u8)|\|[iu]1)$/.test(dtype))
    throw new Error(`unsupported NPY dtype: ${dtype}`);
  const shape = shapeText
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number);
  const data = buffer.subarray(headerStart + headerLength);
  const values = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const itemSize = Number(dtype.slice(-1));
  const expectedCount = shape.reduce((total, size) => total * size, 1);
  if (!shape.every((size) => Number.isSafeInteger(size) && size >= 0))
    throw new Error("invalid NPY shape");
  if (data.byteLength !== expectedCount * itemSize)
    throw new Error("NPY data length does not match shape");
  const count = expectedCount;
  for (let index = 0; index < count; index += 1) {
    const offset = index * itemSize;
    if (dtype.endsWith("f8")) values.push(view.getFloat64(offset, true));
    else if (dtype.endsWith("f4")) values.push(view.getFloat32(offset, true));
    else if (dtype.endsWith("i8"))
      values.push(Number(view.getBigInt64(offset, true)));
    else if (dtype.endsWith("u8") && dtype !== "|u1")
      values.push(Number(view.getBigUint64(offset, true)));
    else if (dtype.endsWith("i4")) values.push(view.getInt32(offset, true));
    else if (dtype.endsWith("u4")) values.push(view.getUint32(offset, true));
    else if (dtype.endsWith("i2")) values.push(view.getInt16(offset, true));
    else if (dtype.endsWith("u2")) values.push(view.getUint16(offset, true));
    else if (dtype.endsWith("i1")) values.push(view.getInt8(offset));
    else if (dtype.endsWith("u1")) values.push(view.getUint8(offset));
    else throw new Error(`unsupported NPY dtype: ${dtype}`);
  }
  return { dtype, shape, values };
}

function normalizedDtype(dtype) {
  const aliases = {
    "<f4": "float32",
    "|f4": "float32",
    float32: "float32",
    "<f8": "float64",
    "|f8": "float64",
    float64: "float64",
    "<u1": "uint8",
    "|u1": "uint8",
    uint8: "uint8",
    "<u2": "uint16",
    "|u2": "uint16",
    uint16: "uint16",
    "<u4": "uint32",
    "|u4": "uint32",
    uint32: "uint32",
    "<u8": "uint64",
    "|u8": "uint64",
    uint64: "uint64",
    "<i1": "int8",
    "|i1": "int8",
    int8: "int8",
    "<i2": "int16",
    "|i2": "int16",
    int16: "int16",
    "<i4": "int32",
    "|i4": "int32",
    int32: "int32",
    "<i8": "int64",
    "|i8": "int64",
    int64: "int64",
  };
  return aliases[dtype] ?? null;
}

function parseNpz(buffer) {
  const result = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (readU32(buffer, offset) !== 0x04034b50) break;
    const flags = readU16(buffer, offset + 6);
    const method = readU16(buffer, offset + 8);
    let compressedSize = readU32(buffer, offset + 18);
    const uncompressedSize = readU32(buffer, offset + 22);
    const nameLength = readU16(buffer, offset + 26);
    const extraLength = readU16(buffer, offset + 28);
    const nameStart = offset + 30;
    if (nameStart + nameLength + extraLength > buffer.length)
      throw new Error("truncated NPZ local header");
    const name = buffer
      .subarray(nameStart, nameStart + nameLength)
      .toString("utf8");
    const extraStart = nameStart + nameLength;
    const extra = buffer.subarray(extraStart, extraStart + extraLength);
    compressedSize =
      readZip64CompressedSize(
        extra,
        compressedSize === 0xffffffff,
        uncompressedSize === 0xffffffff,
      ) ?? compressedSize;
    if (flags & 0x08 && compressedSize === 0)
      throw new Error("NPZ data descriptor has no compressed size");
    const dataStart = extraStart + extraLength;
    if (dataStart + compressedSize > buffer.length)
      throw new Error("truncated NPZ entry");
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data =
      method === 0
        ? compressed
        : method === 8
          ? inflateRawSync(compressed)
          : null;
    if (!data) throw new Error("unsupported NPZ compression method");
    result.set(name.replace(/\.npy$/, ""), parseNpy(data));
    offset = dataStart + compressedSize;
  }
  if (!result.size) throw new Error("NPZ has no arrays");
  return result;
}

async function assertOutputAbsent(filePath) {
  try {
    await access(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`output already exists: ${filePath}`);
}

function compareOutput(reference, actual) {
  const shapeMatch =
    JSON.stringify(reference.shape) === JSON.stringify(actual.shape);
  const finite =
    reference.values.every(Number.isFinite) &&
    actual.values.every(Number.isFinite);
  const result = {
    reference_dtype: reference.dtype,
    actual_dtype: actual.dtype,
    dtype_match:
      normalizedDtype(reference.dtype) !== null &&
      normalizedDtype(reference.dtype) === normalizedDtype(actual.dtype),
    reference_shape: reference.shape,
    actual_shape: actual.shape,
    shape_match: shapeMatch,
    finite,
  };
  if (
    !result.dtype_match ||
    !shapeMatch ||
    reference.values.length !== actual.values.length
  ) {
    return {
      ...result,
      exact_mismatch_count: null,
      first_mismatch_index: null,
    };
  }
  const normalized = normalizedDtype(reference.dtype);
  const integer =
    normalized?.startsWith("int") || normalized?.startsWith("uint");
  if (integer) {
    let mismatch = 0;
    let first = null;
    reference.values.forEach((value, index) => {
      if (value !== actual.values[index]) {
        mismatch += 1;
        if (first === null) first = index;
      }
    });
    return {
      ...result,
      exact_mismatch_count: mismatch,
      first_mismatch_index: first,
    };
  }
  let max = 0;
  let sum = 0;
  reference.values.forEach((value, index) => {
    const delta = Math.abs(value - actual.values[index]);
    max = Math.max(max, delta);
    sum += delta;
  });
  return {
    ...result,
    max_abs_delta: max,
    mean_abs_delta: reference.values.length ? sum / reference.values.length : 0,
  };
}

function firstDivergence(names, summaries, tolerance = 0.001) {
  for (const name of names) {
    const summary = summaries[name];
    if (
      !summary ||
      !summary.shape_match ||
      !summary.dtype_match ||
      !summary.finite ||
      summary.exact_mismatch_count > 0 ||
      summary.max_abs_delta > tolerance
    )
      return name;
  }
  return null;
}

async function main() {
  const values = argsFrom(process.argv.slice(2));
  const graphOptimization = parseGraphOptimization(
    values["graph-optimization"],
  );
  const extensionDir = path.resolve(root, values.extension ?? "dist/extension");
  const modelRelative = validateModelRelative(
    values["model-relative"],
    "--model-relative",
  );
  const baselineModelRelative = validateModelRelative(
    values["baseline-model-relative"] ?? "models/onnx/model_quantized.onnx",
    "--baseline-model-relative",
  );
  const fixturePath = path.resolve(
    root,
    values.fixture ?? "artifacts/corpus-browser/jwtd-browser-v1-tokenids.json",
  );
  const cpuReportPath = path.resolve(root, values["cpu-report"]);
  const cpuNpzPath = path.resolve(root, values["cpu-npz"]);
  if (!values.output || !values["cpu-report"] || !values["cpu-npz"]) {
    throw new Error("--output, --cpu-report, and --cpu-npz are required");
  }
  const reportPath = path.resolve(root, values.output);
  await assertOutputAbsent(reportPath);
  const fixtureSha = await sha256(fixturePath);
  if (fixtureSha !== FIXTURE_SHA256)
    throw new Error("fixture SHA-256 does not match the pinned input");
  const cpuReport = JSON.parse(await readFile(cpuReportPath, "utf8"));
  if (cpuReport.status !== "passed")
    throw new Error("CPU diagnostic gate did not pass");
  if (cpuReport.graph_optimization?.requested !== graphOptimization)
    throw new Error("CPU and browser graph optimization settings differ");
  const capture = validateCpuReportCapture(cpuReport);
  const captureProfile = capture.profile;
  const captureOutputs = capture.outputs;
  const npzSha = await sha256(cpuNpzPath);
  if (npzSha !== cpuReport.npz_sha256)
    throw new Error("CPU NPZ SHA-256 does not match its report");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const item = fixture.items.find(
    (candidate) => candidate.id === cpuReport.row?.id,
  );
  if (!item) throw new Error("CPU diagnostic row is absent from the fixture");
  if (cpuReport.fixture_sha256 !== fixtureSha)
    throw new Error("CPU report fixture SHA-256 does not match the fixture");
  if (cpuReport.model_sha256 !== MODEL_SHA256)
    throw new Error(
      "CPU report source model SHA-256 does not match the pinned model",
    );
  if (cpuReport.row?.token_count !== item.expected_input_ids.length)
    throw new Error("CPU report token count does not match the fixture");
  const modelPath = path.join(extensionDir, modelRelative);
  const baselineModelPath = path.join(extensionDir, baselineModelRelative);
  if ((await sha256(modelPath)) !== cpuReport.instrumented_model_sha256)
    throw new Error("instrumented model SHA mismatch");
  if ((await sha256(baselineModelPath)) !== MODEL_SHA256)
    throw new Error("baseline distributed model SHA mismatch");
  const npz = parseNpz(await readFile(cpuNpzPath));
  const requests = [];
  const pageErrors = [];
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), "kotoba-guard-intermediate-"),
  );
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: "chromium",
    args: [
      "--enable-unsafe-extension-debugging",
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });
  try {
    context.on("request", (request) => {
      const protocol = new URL(request.url()).protocol;
      if (["http:", "https:", "ws:", "wss:"].includes(protocol))
        requests.push({ protocol, host: new URL(request.url()).host });
    });
    context.on("weberror", () => pageErrors.push("error"));
    await context.setOffline(true);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const result = await page.evaluate(
      async ({
        inputIds,
        attentionMask,
        modelRelative,
        baselineModelRelative,
        graphOptimization,
      }) => {
        const ort = await import(
          chrome.runtime.getURL("wasm/ort.webgpu.min.mjs")
        );
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.wasmPaths = chrome.runtime.getURL("wasm/");
        const options = {
          executionProviders: ["wasm"],
          graphOptimizationLevel: graphOptimization,
        };
        const makeSession = (relative) =>
          ort.InferenceSession.create(chrome.runtime.getURL(relative), options);
        const feed = {
          input_ids: new ort.Tensor(
            "int64",
            BigInt64Array.from(inputIds, BigInt),
            [1, inputIds.length],
          ),
          attention_mask: new ort.Tensor(
            "int64",
            BigInt64Array.from(attentionMask, BigInt),
            [1, attentionMask.length],
          ),
        };
        let instrumentedSession;
        let baselineSession;
        try {
          [instrumentedSession, baselineSession] = await Promise.all([
            makeSession(modelRelative),
            makeSession(baselineModelRelative),
          ]);
          const run = async (session) => {
            const output = await session.run(feed);
            return session.outputNames.map((name) => ({
              name,
              dims: Array.from(output[name].dims),
              dtype: output[name].type,
              values: Array.from(output[name].data, Number),
            }));
          };
          const [instrumented, baseline] = await Promise.all([
            run(instrumentedSession),
            run(baselineSession),
          ]);
          return { instrumented, baseline };
        } finally {
          for (const session of [instrumentedSession, baselineSession]) {
            if (session) await session.release();
          }
          for (const tensor of Object.values(feed)) {
            if (typeof tensor.dispose === "function") tensor.dispose();
          }
        }
      },
      {
        inputIds: item.expected_input_ids,
        attentionMask: item.expected_attention_mask,
        modelRelative,
        baselineModelRelative,
        graphOptimization,
      },
    );
    const expectedNames = ["logits", ...captureOutputs];
    if (
      JSON.stringify(result.instrumented.map((output) => output.name)) !==
      JSON.stringify(expectedNames)
    )
      throw new Error(
        "instrumented output names do not match the pinned order",
      );
    const baselineLogits = result.baseline.find(
      (output) => output.name === "logits",
    );
    const instrumentedLogits = result.instrumented.find(
      (output) => output.name === "logits",
    );
    if (!baselineLogits || !instrumentedLogits)
      throw new Error("logits output is missing");
    const browserInstrumentation = compareOutput(
      {
        dtype: "<f4",
        shape: baselineLogits.dims,
        values: baselineLogits.values,
      },
      {
        dtype: instrumentedLogits.dtype,
        shape: instrumentedLogits.dims,
        values: instrumentedLogits.values,
      },
    );
    const summaries = {};
    result.instrumented.forEach((output, index) => {
      const reference = npz.get(`output_${index}`);
      if (!reference)
        throw new Error(`CPU output cache is missing output_${index}`);
      summaries[output.name] = compareOutput(reference, {
        dtype: output.dtype,
        shape: output.dims,
        values: output.values,
      });
    });
    const intermediateDivergence = firstDivergence(captureOutputs, summaries);
    const logitsSummary = summaries.logits;
    const report = {
      schema_version: "jwtd-quantized-intermediate-browser-v1",
      status: "pending",
      fixture_sha256: fixtureSha,
      cpu_report_sha256: await sha256(cpuReportPath),
      cpu_npz_sha256: npzSha,
      source_commit:
        process.env.SOURCE_COMMIT ?? process.env.GITHUB_SHA ?? "unknown",
      model_sha256: await sha256(modelPath),
      baseline_model_sha256: await sha256(baselineModelPath),
      row: {
        index: cpuReport.row.index,
        id: cpuReport.row.id,
        token_count: item.expected_input_ids.length,
      },
      capture_profile: captureProfile,
      intermediate_output_order: captureOutputs,
      graph_optimization: {
        requested: graphOptimization,
        session_option: graphOptimization,
        effective: null,
        evidence:
          "ORT session accepted supplied options; internal optimized graph not observed",
      },
      instrumented_logits_reproduction: browserInstrumentation,
      outputs: summaries,
      first_divergence_candidate:
        intermediateDivergence ??
        (logitsSummary &&
        (!logitsSummary.shape_match ||
          !logitsSummary.dtype_match ||
          !logitsSummary.finite ||
          logitsSummary.exact_mismatch_count > 0 ||
          logitsSummary.max_abs_delta > 0.001)
          ? "logits"
          : null),
      external_request_count: requests.length,
      page_error_count: pageErrors.length,
      network_audit_scope:
        "Context request and page error events observed after listener registration; context startup before registration is outside this audit.",
      environment: {
        offline: true,
        browser: context.browser()?.version() ?? "unknown",
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      gate: { passed: false, failures: [] },
    };
    if (
      !browserInstrumentation.shape_match ||
      !browserInstrumentation.finite ||
      browserInstrumentation.max_abs_delta > 0
    )
      report.gate.failures.push(
        "browser instrumentation changed unmodified logits",
      );
    for (const name of expectedNames) {
      const summary = summaries[name];
      if (!summary.shape_match || !summary.dtype_match || !summary.finite)
        report.gate.failures.push(`${name}: shape, dtype, or finite mismatch`);
      if (summary.exact_mismatch_count > 0 || summary.max_abs_delta > 0.001)
        report.gate.failures.push(`${name}: CPU/WASM intermediate mismatch`);
    }
    if (requests.length)
      report.gate.failures.push("external requests observed");
    if (pageErrors.length) report.gate.failures.push("page errors observed");
    if (result.instrumented.length !== expectedNames.length)
      report.gate.failures.push("instrumented output count mismatch");
    report.status = report.gate.failures.length ? "failed" : "passed";
    report.gate.passed = report.gate.failures.length === 0;
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    console.log(
      JSON.stringify(
        {
          output: path.relative(root, reportPath),
          status: report.status,
          first_divergence_candidate: report.first_divergence_candidate,
        },
        null,
        2,
      ),
    );
    if (!report.gate.passed) process.exitCode = 1;
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await main();
  } catch {
    console.error("browser intermediate parity failed");
    process.exitCode = 1;
  }
}

export {
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
};
