/* global chrome */
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const next = argv[index + 1];
    values[value.slice(2)] =
      next === undefined || next.startsWith("--") ? true : argv[++index];
  }
  return values;
}

function parseWasmGraphOptimization(value) {
  if (value === undefined) return undefined;
  if (value !== "all" && value !== "disabled") {
    throw new Error(
      "--wasm-graph-optimization requires exactly 'all' or 'disabled'",
    );
  }
  return value;
}

function wasmSessionOptions(graphOptimization) {
  return {
    executionProviders: ["wasm"],
    ...(graphOptimization === undefined
      ? {}
      : { graphOptimizationLevel: graphOptimization }),
  };
}

function graphOptimizationReport(requested, directOrt) {
  const requestedValue = requested ?? null;
  return {
    requested: requestedValue,
    session_option: requestedValue,
    effective: null,
    evidence:
      directOrt && requestedValue !== null
        ? "ORT session accepted supplied options; internal optimized graph not observed"
        : directOrt
          ? "Direct ORT session used without graph optimization override; internal optimized graph not observed"
          : "SDK session factory default; internal optimized graph not observed",
  };
}

/**
 * Install the self-contained logits validator into a browser global.
 * @param {{ __kotobaGuardSummarizeFloat32Logits?: unknown }} [target]
 */
function installLogitsValidator(target = globalThis) {
  const summarizeFloat32Logits = (logitsTensor) => {
    const reportedDtype =
      typeof logitsTensor?.type === "string" ? logitsTensor.type : null;
    const data = logitsTensor?.data;
    const actualDtype =
      data instanceof Float32Array
        ? "float32"
        : (data?.constructor?.name ?? null);
    const dtypeMatch =
      reportedDtype === "float32" && data instanceof Float32Array;
    return {
      reported_dtype: reportedDtype,
      actual_dtype: actualDtype,
      dtype_match: dtypeMatch,
      values: dtypeMatch ? Array.from(data, Number) : [],
    };
  };
  target.__kotobaGuardSummarizeFloat32Logits = summarizeFloat32Logits;
  return summarizeFloat32Logits;
}

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function codepointToUtf16(text, start, end) {
  const points = Array.from(text);
  return [
    points.slice(0, start).join("").length,
    points.slice(0, end).join("").length,
  ];
}

function spansFromCachedLogits(item, labels, threshold = 0.5) {
  const spans = [];
  for (let token = 0; token < item.expected_logits.length; token += 1) {
    const offset = item.expected_offsets[token];
    if (!offset || offset[1] <= offset[0]) continue;
    const scores = item.expected_logits[token];
    let labelId = 0;
    for (let index = 1; index < scores.length; index += 1) {
      if (scores[index] > scores[labelId]) labelId = index;
    }
    const maximum = Math.max(...scores);
    const probabilities = scores.map((score) => Math.exp(score - maximum));
    const total = probabilities.reduce((sum, value) => sum + value, 0);
    const confidence = probabilities[labelId] / total;
    if (labels[labelId] === "OK" || confidence < threshold) continue;
    const [start, end] = codepointToUtf16(item.text, offset[0], offset[1]);
    spans.push({ start, end, label: labels[labelId] });
  }
  return spans;
}

function goldSpans(item) {
  return (item.errors ?? []).map((error) => ({
    start: codepointToUtf16(item.text, error.start, error.end)[0],
    end: codepointToUtf16(item.text, error.start, error.end)[1],
    label: error.label,
  }));
}

function spanKeys(spans) {
  return new Set(
    spans.map((span) => `${span.start}:${span.end}:${span.label ?? span.type}`),
  );
}

async function main() {
  const values = argsFrom(process.argv.slice(2));
  const fp32Diagnostic = values["fp32-diagnostic"] === true;
  const candidateDiagnostic = values["candidate-diagnostic"] === true;
  const modelKind = values["model-kind"] ?? null;
  const wasmGraphOptimization = parseWasmGraphOptimization(
    values["wasm-graph-optimization"],
  );
  const usesDirectOrt =
    fp32Diagnostic ||
    candidateDiagnostic ||
    wasmGraphOptimization !== undefined;
  if (fp32Diagnostic && candidateDiagnostic) {
    throw new Error("FP32 and candidate diagnostics are mutually exclusive");
  }
  if (
    candidateDiagnostic &&
    (typeof modelKind !== "string" || !/^[a-z0-9][a-z0-9._-]+$/.test(modelKind))
  ) {
    throw new Error("candidate diagnostic requires a valid --model-kind");
  }
  const fixturePath = path.resolve(
    root,
    values.fixture ?? "artifacts/corpus-browser/jwtd-browser-v1.json",
  );
  const protocolPath = path.resolve(
    root,
    values.protocol ?? "benchmarks/protocols/jwtd-browser-v1.json",
  );
  const extensionDir = path.resolve(root, values.extension ?? "dist/extension");
  const reportPath = path.resolve(
    root,
    values.output ?? "artifacts/browser-corpus-parity.json",
  );
  const modelRelative =
    values["model-relative"] ??
    (fp32Diagnostic
      ? "models/onnx/model.onnx"
      : candidateDiagnostic
        ? "models/onnx/model_weight_only.onnx"
        : "models/onnx/model_quantized.onnx");
  const manifestRelative =
    values["model-manifest"] ??
    (fp32Diagnostic
      ? "models/fp32-manifest.json"
      : candidateDiagnostic
        ? "models/candidate-manifest.json"
        : "models/manifest.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const protocolSha = await sha256(protocolPath);
  const fixtureSha = await sha256(fixturePath);
  if (!Array.isArray(fixture.items) || fixture.items.length === 0) {
    throw new Error("browser parity fixture has no rows");
  }
  if (!Array.isArray(fixture.labels) || fixture.labels.length === 0) {
    throw new Error("browser parity fixture has no labels");
  }
  for (const item of fixture.items) {
    if (
      typeof item?.id !== "string" ||
      typeof item.text !== "string" ||
      !Array.isArray(item.expected_logits) ||
      !Array.isArray(item.expected_offsets) ||
      !Array.isArray(item.expected_input_ids) ||
      !Array.isArray(item.expected_attention_mask) ||
      !Array.isArray(item.errors) ||
      item.expected_logits.length !== item.expected_offsets.length ||
      item.expected_logits.length === 0
    ) {
      throw new Error("browser parity fixture row is missing required arrays");
    }
    const classCount = fixture.labels.length;
    for (const scores of item.expected_logits) {
      if (
        !Array.isArray(scores) ||
        scores.length !== classCount ||
        scores.some((value) => !Number.isFinite(value))
      ) {
        throw new Error("browser parity fixture logits shape is invalid");
      }
    }
    for (const offset of item.expected_offsets) {
      if (
        !Array.isArray(offset) ||
        offset.length !== 2 ||
        !offset.every((value) => Number.isInteger(value) && value >= 0) ||
        offset[1] < offset[0] ||
        offset[1] > Array.from(item.text).length
      ) {
        throw new Error("browser parity fixture offsets are invalid");
      }
    }
    if (
      item.expected_input_ids.length !== item.expected_logits.length ||
      item.expected_attention_mask.length !== item.expected_input_ids.length ||
      item.expected_input_ids.some(
        (value) => !Number.isInteger(value) || value < 0,
      ) ||
      item.expected_attention_mask.some((value) => ![0, 1].includes(value))
    ) {
      throw new Error("browser parity fixture tokenizer arrays are invalid");
    }
  }
  if (fixture.provenance?.protocol_sha256 !== protocolSha) {
    throw new Error("fixture protocol hash does not match the frozen protocol");
  }
  const distributionManifest = JSON.parse(
    await readFile(path.join(extensionDir, manifestRelative), "utf8"),
  );
  const extensionConfig = JSON.parse(
    await readFile(path.join(extensionDir, "models", "config.json"), "utf8"),
  );
  const extensionLabels = Object.keys(extensionConfig.id2label ?? {})
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => String(extensionConfig.id2label[key]));
  if (JSON.stringify(extensionLabels) !== JSON.stringify(fixture.labels)) {
    throw new Error("fixture labels do not match the distributed model config");
  }
  const modelPath = path.join(extensionDir, modelRelative);
  const actualModelSha = await sha256(modelPath);
  const manifestModelKey = modelRelative.startsWith("models/")
    ? modelRelative.slice("models/".length)
    : modelRelative;
  const declaredModelSha =
    distributionManifest.files?.[manifestModelKey]?.sha256 ??
    distributionManifest.artifacts?.[manifestModelKey]?.sha256;
  const rawModelSha = fixture.provenance?.raw_model_sha256;
  if (!fp32Diagnostic && !candidateDiagnostic) {
    const sanitizedSha = distributionManifest.sanitization?.sha256;
    if (
      actualModelSha !== declaredModelSha ||
      declaredModelSha !== sanitizedSha
    ) {
      throw new Error(
        "distribution model hash does not match its manifest/sanitization hash",
      );
    }
    if (
      distributionManifest.sanitization?.sourceSha256 !== rawModelSha ||
      actualModelSha === rawModelSha
    ) {
      throw new Error(
        "distribution sanitization provenance does not bind the raw model hash",
      );
    }
    if (fixture.provenance?.distribution_model_sha256 !== actualModelSha) {
      throw new Error(
        "fixture distribution model hash does not match the extension",
      );
    }
  } else if (
    fp32Diagnostic &&
    (fixture.provenance?.fp32_model_sha256 !== actualModelSha ||
      declaredModelSha !== actualModelSha ||
      fixture.provenance?.model_revision !== distributionManifest.revision)
  ) {
    throw new Error(
      "FP32 diagnostic model provenance does not match extension",
    );
  } else if (
    candidateDiagnostic &&
    (fixture.provenance?.candidate_model_sha256 !== actualModelSha ||
      declaredModelSha !== actualModelSha ||
      fixture.provenance?.model_revision !== distributionManifest.revision ||
      fixture.provenance?.model_kind !== modelKind)
  ) {
    throw new Error(
      "candidate diagnostic model provenance does not match extension",
    );
  }
  const distributedTextFiles = [
    ["tokenizer.json", "tokenizer_file_sha256"],
    ["tokenizer_config.json", "tokenizer_config_file_sha256"],
    ["config.json", "config_sha256"],
  ];
  for (const [relativePath, fixtureKey] of distributedTextFiles) {
    const filePath = path.join(extensionDir, "models", relativePath);
    const actualSha = await sha256(filePath);
    const expectedSha = fixture.provenance?.[fixtureKey];
    const declaredSha =
      distributionManifest.files?.[relativePath]?.sha256 ??
      distributionManifest.artifacts?.[relativePath]?.sha256;
    if (
      typeof expectedSha !== "string" ||
      expectedSha.length !== 64 ||
      actualSha !== expectedSha ||
      declaredSha !== actualSha
    ) {
      throw new Error(
        `distributed ${relativePath} hash does not match fixture`,
      );
    }
  }
  const runtimeFiles = {};
  const wasmRuntimeNames = await readdir(path.join(extensionDir, "wasm"))
    .then((names) =>
      names.filter((name) => /^ort-wasm.*\.(?:wasm|mjs)$/.test(name)).sort(),
    )
    .catch(() => []);
  for (const name of wasmRuntimeNames) {
    const relativePath = `wasm/${name}`;
    runtimeFiles[relativePath] = await sha256(
      path.join(extensionDir, relativePath),
    );
  }
  let externalDataSha = null;
  try {
    externalDataSha = await sha256(`${modelPath}.data`);
  } catch {
    // A self-contained ONNX file has no external data companion.
  }
  if (fp32Diagnostic || candidateDiagnostic) {
    const expectedExternalDataSha =
      fixture.provenance?.[
        fp32Diagnostic
          ? "fp32_external_data_sha256"
          : "candidate_external_data_sha256"
      ] ?? null;
    if (externalDataSha !== expectedExternalDataSha) {
      throw new Error("diagnostic external data hash does not match fixture");
    }
    const declaredExternalSha =
      distributionManifest.files?.[`${manifestModelKey}.data`]?.sha256 ??
      distributionManifest.artifacts?.[`${manifestModelKey}.data`]?.sha256 ??
      null;
    if (declaredExternalSha !== externalDataSha) {
      throw new Error("diagnostic external data hash does not match manifest");
    }
  }

  const requests = [];
  const pageErrors = [];
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), "kotoba-guard-browser-parity-"),
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
    await context.setOffline(true);
    context.on("request", (request) => {
      try {
        const url = new URL(request.url());
        if (["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
          requests.push({ protocol: url.protocol, host: url.host });
        }
      } catch {
        requests.push({ protocol: "invalid", host: "invalid" });
      }
    });
    context.on("weberror", () => pageErrors.push("error"));
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(installLogitsValidator);
    const result = await page.evaluate(
      async ({
        fixtureItems,
        labels,
        modelRelative,
        modelKind,
        externalDataSha,
        wasmSessionOptions,
        usesDirectOrt,
        graphOptimizationReport,
      }) => {
        const codepointToUtf16 = (text, start, end) => {
          const points = Array.from(text);
          return [
            points.slice(0, start).join("").length,
            points.slice(0, end).join("").length,
          ];
        };
        const summarizeFloat32Logits =
          globalThis.__kotobaGuardSummarizeFloat32Logits;
        if (typeof summarizeFloat32Logits !== "function")
          throw new Error("logits validator was not installed");
        const core = await import(chrome.runtime.getURL("core.js"));
        const modelUrl = chrome.runtime.getURL(modelRelative);
        const modelRoot = chrome.runtime.getURL("models/");
        const tokenizer = await core.createTransformersTokenizer(modelRoot);
        // The core factory intentionally exposes the common self-contained
        // model path. The paired FP32 experiment may use ONNX external data,
        // so load that isolated session through the documented ORT Web API.
        const directOrt = usesDirectOrt
          ? await import(chrome.runtime.getURL("wasm/ort.webgpu.min.mjs"))
          : null;
        if (directOrt) {
          directOrt.env.wasm.numThreads = 1;
          directOrt.env.wasm.wasmPaths = chrome.runtime.getURL("wasm/");
        }
        const externalData =
          directOrt && externalDataSha
            ? [
                {
                  path: `${modelRelative.split("/").at(-1)}.data`,
                  data: chrome.runtime.getURL(`${modelRelative}.data`),
                },
              ]
            : undefined;
        const factory = core.createOrtSessionFactory(modelUrl, {
          wasmThreads: 1,
          wasmPath: chrome.runtime.getURL("wasm/"),
        });
        const session = directOrt
          ? await directOrt.InferenceSession.create(modelUrl, {
              ...wasmSessionOptions,
              externalData,
            })
          : await factory("wasm");
        const detectorSession = directOrt
          ? {
              inputNames: session.inputNames,
              outputNames: session.outputNames,
              run: (...args) => session.run(...args),
              // The raw diagnostic session is released exactly once below.
              release: async () => {},
            }
          : null;
        const detectorFactory = directOrt
          ? async () => detectorSession
          : factory;
        const detector = new core.LocalTypoDetector({
          tokenizer,
          sessionFactory: detectorFactory,
          labels: {
            id2label: Object.fromEntries(
              labels.map((label, index) => [String(index), label]),
            ),
          },
          modelVersion: modelKind ?? "jwtd-browser-v1",
          backend: "wasm",
          confidenceThreshold: 0.5,
        });
        await detector.initialize();
        const rows = [];
        for (const item of fixtureItems) {
          const encoding = await tokenizer.encode(item.text);
          const inputIds = Array.from(encoding.inputIds, Number);
          const attentionMask = Array.from(
            encoding.attentionMask ?? inputIds.map(() => 1),
            Number,
          );
          const inputIdMismatchIndexes = [];
          const inputIdLength = Math.max(
            inputIds.length,
            item.expected_input_ids.length,
          );
          for (let index = 0; index < inputIdLength; index += 1) {
            if (inputIds[index] !== item.expected_input_ids[index]) {
              inputIdMismatchIndexes.push(index);
            }
          }
          const attentionMaskMismatchIndexes = [];
          const attentionLength = Math.max(
            attentionMask.length,
            item.expected_attention_mask.length,
          );
          for (let index = 0; index < attentionLength; index += 1) {
            if (attentionMask[index] !== item.expected_attention_mask[index]) {
              attentionMaskMismatchIndexes.push(index);
            }
          }
          const inputIdsMatch = inputIdMismatchIndexes.length === 0;
          const attentionMaskMatch = attentionMaskMismatchIndexes.length === 0;
          const feeds = {};
          for (const name of session.inputNames) {
            if (name === "input_ids")
              feeds[name] = core.createTensor("int64", inputIds, [
                1,
                inputIds.length,
              ]);
            else if (name === "attention_mask")
              feeds[name] = core.createTensor("int64", attentionMask, [
                1,
                inputIds.length,
              ]);
            else if (name === "token_type_ids")
              feeds[name] = core.createTensor(
                "int64",
                encoding.tokenTypeIds ?? inputIds.map(() => 0),
                [1, inputIds.length],
              );
            else throw new Error(`unsupported model input: ${name}`);
          }
          const outputs = await session.run(feeds);
          const logitsTensor = core.readLogits(outputs, session.outputNames);
          const logitsSummary = summarizeFloat32Logits(logitsTensor);
          const logits = logitsSummary.values;
          const dtypeMatch = logitsSummary.dtype_match;
          const classCount = logitsTensor.dims[2];
          const actualOffsets = encoding.offsets.map((offset) => [
            Number(offset[0]),
            Number(offset[1]),
          ]);
          const expectedOffsets = item.expected_offsets.map((offset) => {
            const converted = codepointToUtf16(item.text, offset[0], offset[1]);
            return converted;
          });
          const offsetMatch =
            JSON.stringify(actualOffsets) === JSON.stringify(expectedOffsets);
          const expected = item.expected_logits.flat();
          const expectedTokenCount = item.expected_logits.length;
          const expectedClassCount = expectedTokenCount
            ? item.expected_logits[0].length
            : 0;
          const shapeMatch =
            logitsTensor.dims.length === 3 &&
            logitsTensor.dims[0] === 1 &&
            logitsTensor.dims[1] === expectedTokenCount &&
            classCount === expectedClassCount &&
            actualOffsets.length === expectedTokenCount &&
            logits.length === expected.length;
          const finite =
            logits.every((value) => Number.isFinite(value)) &&
            expected.every((value) => Number.isFinite(value));
          if (!shapeMatch || !finite) {
            rows.push({
              id: item.id,
              input_ids_match: inputIdsMatch,
              input_id_mismatch_count: inputIdMismatchIndexes.length,
              input_id_mismatch_indexes: inputIdMismatchIndexes,
              attention_mask_match: attentionMaskMatch,
              attention_mask_mismatch_count:
                attentionMaskMismatchIndexes.length,
              attention_mask_mismatch_indexes: attentionMaskMismatchIndexes,
              shape_match: shapeMatch,
              reported_logits_dtype: logitsSummary.reported_dtype,
              actual_logits_dtype: logitsSummary.actual_dtype,
              dtype_match: dtypeMatch,
              finite,
              offset_match: offsetMatch,
              ordinary_tokens: 0,
              max_abs_logit_delta: null,
              all_tokens_max_abs_logit_delta: null,
              mean_abs_logit_delta: null,
              ordinary_token_argmax_agreement: null,
              expected_cached_spans: [],
              expected_error_count: item.errors.length,
              browser_spans: [],
            });
            for (const tensor of Object.values(feeds)) tensor.dispose?.();
            for (const tensor of Object.values(outputs)) tensor.dispose?.();
            continue;
          }
          let ordinaryMaxDelta = 0;
          let allTokensMaxDelta = 0;
          let ordinarySumDelta = 0;
          let ordinaryValueCount = 0;
          let allTokensSumDelta = 0;
          let comparedValues = 0;
          const tokenComparisons = [];
          let argmaxMatches = 0;
          let ordinaryTokens = 0;
          for (let token = 0; token < expectedTokenCount; token += 1) {
            const [start, end] = actualOffsets[token];
            const ordinary = end > start;
            let actualId = 0;
            let expectedId = 0;
            let tokenMaxDelta = 0;
            for (let label = 0; label < classCount; label += 1) {
              const delta = Math.abs(
                logits[token * classCount + label] -
                  item.expected_logits[token][label],
              );
              tokenMaxDelta = Math.max(tokenMaxDelta, delta);
              allTokensMaxDelta = Math.max(allTokensMaxDelta, delta);
              allTokensSumDelta += delta;
              comparedValues += 1;
              if (ordinary) {
                ordinarySumDelta += delta;
                ordinaryValueCount += 1;
              }
              if (
                logits[token * classCount + label] >
                logits[token * classCount + actualId]
              )
                actualId = label;
              if (
                item.expected_logits[token][label] >
                item.expected_logits[token][expectedId]
              )
                expectedId = label;
            }
            if (ordinary) {
              ordinaryTokens += 1;
              ordinaryMaxDelta = Math.max(ordinaryMaxDelta, tokenMaxDelta);
              if (actualId === expectedId) argmaxMatches += 1;
            }
            tokenComparisons.push({
              expected_argmax: expectedId,
              actual_argmax: actualId,
              expected_offset: expectedOffsets[token],
              actual_offset: [start, end],
              max_abs_logit_delta: tokenMaxDelta,
            });
          }
          const detection = await detector.detect(item.text);
          rows.push({
            id: item.id,
            input_ids_match: inputIdsMatch,
            input_id_mismatch_count: inputIdMismatchIndexes.length,
            input_id_mismatch_indexes: inputIdMismatchIndexes,
            attention_mask_match: attentionMaskMatch,
            attention_mask_mismatch_count: attentionMaskMismatchIndexes.length,
            attention_mask_mismatch_indexes: attentionMaskMismatchIndexes,
            shape_match: shapeMatch,
            reported_logits_dtype: logitsSummary.reported_dtype,
            actual_logits_dtype: logitsSummary.actual_dtype,
            dtype_match: dtypeMatch,
            finite,
            offset_match: offsetMatch,
            ordinary_tokens: ordinaryTokens,
            max_abs_logit_delta: ordinaryMaxDelta,
            all_tokens_max_abs_logit_delta: allTokensMaxDelta,
            mean_abs_logit_delta: ordinaryTokens
              ? ordinarySumDelta / ordinaryValueCount
              : 0,
            all_tokens_mean_abs_logit_delta: comparedValues
              ? allTokensSumDelta / comparedValues
              : 0,
            ordinary_token_argmax_agreement: ordinaryTokens
              ? argmaxMatches / ordinaryTokens
              : 1,
            token_comparisons: tokenComparisons,
            expected_cached_spans: [],
            expected_error_count: item.errors.length,
            browser_spans: detection.detections.map((value) => ({
              start: value.start,
              end: value.end,
              label: value.type,
            })),
          });
          for (const tensor of Object.values(feeds)) tensor.dispose?.();
          for (const tensor of Object.values(outputs)) tensor.dispose?.();
        }
        await detector.dispose();
        await session.release?.();
        return {
          rows,
          graphOptimization: graphOptimizationReport,
        };
      },
      {
        fixtureItems: fixture.items,
        labels: fixture.labels,
        modelRelative,
        fp32Diagnostic,
        candidateDiagnostic,
        modelKind,
        externalDataSha,
        wasmGraphOptimization,
        wasmSessionOptions: wasmSessionOptions(wasmGraphOptimization),
        usesDirectOrt,
        graphOptimizationReport: graphOptimizationReport(
          wasmGraphOptimization,
          usesDirectOrt,
        ),
      },
    );
    const expectedById = new Map(fixture.items.map((item) => [item.id, item]));
    for (const row of result.rows) {
      const expected = expectedById.get(row.id);
      if (!expected)
        throw new Error("browser result contains an unknown fixture row");
      const expectedCached = spansFromCachedLogits(expected, fixture.labels);
      const cachedKeys = spanKeys(expectedCached);
      const actualKeys = spanKeys(row.browser_spans);
      row.expected_cached_spans = expectedCached;
      row.span_exact_match =
        cachedKeys.size === actualKeys.size &&
        [...cachedKeys].every((key) => actualKeys.has(key));
      const goldKeys = spanKeys(goldSpans(expected));
      row.gold_diagnostic_span_match =
        goldKeys.size === actualKeys.size &&
        [...goldKeys].every((key) => actualKeys.has(key));
    }
    const gateFailures = [];
    for (const row of result.rows) {
      if (!row.input_ids_match)
        gateFailures.push(`${row.id}: tokenizer input IDs mismatch`);
      if (!row.attention_mask_match)
        gateFailures.push(`${row.id}: tokenizer attention mask mismatch`);
      if (!row.shape_match) gateFailures.push(`${row.id}: shape mismatch`);
      if (!row.dtype_match)
        gateFailures.push(`${row.id}: logits dtype mismatch`);
      if (!row.finite) gateFailures.push(`${row.id}: nonfinite logits`);
      if (!row.offset_match)
        gateFailures.push(`${row.id}: tokenizer offsets mismatch`);
      if (
        !Number.isFinite(row.max_abs_logit_delta) ||
        row.max_abs_logit_delta > 0.001
      ) {
        gateFailures.push(`${row.id}: ordinary logit delta exceeds 0.001`);
      }
      if (row.ordinary_token_argmax_agreement !== 1)
        gateFailures.push(`${row.id}: ordinary argmax mismatch`);
      if (!row.span_exact_match)
        gateFailures.push(`${row.id}: SDK span mismatch`);
    }
    if (result.rows.length !== fixture.items.length) {
      gateFailures.push("browser result row count does not match fixture");
    }
    if (pageErrors.length) gateFailures.push("page errors observed");
    const browserVersion = context.browser()?.version();
    if (!browserVersion) gateFailures.push("browser version unavailable");
    const report = {
      schema_version: fp32Diagnostic
        ? "jwtd-fp32-browser-diagnostic-v1"
        : candidateDiagnostic
          ? "jwtd-candidate-browser-diagnostic-v1"
          : "jwtd-browser-v1",
      diagnostic: fp32Diagnostic
        ? "fp32_cpu_vs_wasm"
        : candidateDiagnostic
          ? `${modelKind}_cpu_vs_wasm`
          : null,
      model_kind: candidateDiagnostic
        ? modelKind
        : fp32Diagnostic
          ? "fp32"
          : null,
      fixture: path.relative(root, fixturePath).replaceAll(path.sep, "/"),
      protocol: path.relative(root, protocolPath).replaceAll(path.sep, "/"),
      provenance: {
        fixture_sha256: fixtureSha,
        protocol_sha256: protocolSha,
        source_fixture_sha256:
          fixture.provenance?.source_fixture_sha256 ?? null,
        source_commit:
          process.env.GITHUB_SHA ?? process.env.SOURCE_COMMIT ?? "unknown",
        model_sha256: actualModelSha,
        candidate_model_sha256: candidateDiagnostic ? actualModelSha : null,
        external_data_sha256: externalDataSha,
        wasm_runtime_files: runtimeFiles,
      },
      extension: {
        path: path.relative(root, extensionDir).replaceAll(path.sep, "/"),
        model_relative: modelRelative,
        manifest_relative: manifestRelative,
        model_sha256: actualModelSha,
        raw_model_sha256: rawModelSha,
        sanitization_source_sha256:
          distributionManifest.sanitization?.sourceSha256 ?? null,
      },
      environment: {
        offline: true,
        browser: browserVersion ?? "unknown",
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      graph_optimization: result.graphOptimization,
      rows: result.rows,
      external_request_count: requests.length,
      external_request_hosts: requests,
      page_error_count: pageErrors.length,
      gate: {
        passed: gateFailures.length === 0 && requests.length === 0,
        failures: gateFailures,
      },
      limitations: [
        "This subset is a numerical/tokenization parity check, not an accuracy estimate.",
      ],
    };
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      JSON.stringify(
        {
          output: path.relative(root, reportPath),
          rows: result.rows.length,
          external_requests: requests.length,
          gate_passed: gateFailures.length === 0 && requests.length === 0,
        },
        null,
        2,
      ),
    );
    if (requests.length || gateFailures.length) process.exitCode = 1;
  } finally {
    await context.close();
    if (
      path.dirname(userDataDir) === os.tmpdir() &&
      path.basename(userDataDir).startsWith("kotoba-guard-browser-parity-")
    ) {
      await rm(userDataDir, { recursive: true, force: true });
    }
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await main();
  } catch {
    const values = argsFrom(process.argv.slice(2));
    const fixturePath = path.resolve(
      root,
      values.fixture ?? "artifacts/corpus-browser/jwtd-browser-v1.json",
    );
    const protocolPath = path.resolve(
      root,
      values.protocol ?? "benchmarks/protocols/jwtd-browser-v1.json",
    );
    const fp32Diagnostic = values["fp32-diagnostic"] === true;
    const candidateDiagnostic = values["candidate-diagnostic"] === true;
    const modelKind = values["model-kind"] ?? null;
    const reportPath = path.resolve(
      root,
      values.output ?? "artifacts/browser-corpus-parity.json",
    );
    try {
      let fixtureSha = null;
      let protocolSha = null;
      try {
        fixtureSha = await sha256(fixturePath);
        protocolSha = await sha256(protocolPath);
      } catch {
        // Keep the failure report free of raw paths and input contents.
      }
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(
        reportPath,
        `${JSON.stringify(
          {
            schema_version: fp32Diagnostic
              ? "jwtd-fp32-browser-diagnostic-v1"
              : candidateDiagnostic
                ? "jwtd-candidate-browser-diagnostic-v1"
                : "jwtd-browser-v1",
            diagnostic: fp32Diagnostic
              ? "fp32_cpu_vs_wasm"
              : candidateDiagnostic
                ? `${modelKind ?? "candidate"}_cpu_vs_wasm`
                : null,
            model_kind: candidateDiagnostic
              ? modelKind
              : fp32Diagnostic
                ? "fp32"
                : null,
            status: "failed",
            gate: {
              passed: false,
              failures: ["browser parity execution failed"],
            },
            provenance: {
              fixture_sha256: fixtureSha,
              protocol_sha256: protocolSha,
              source_commit:
                process.env.GITHUB_SHA ??
                process.env.SOURCE_COMMIT ??
                "unknown",
            },
            environment: {
              offline: true,
              browser: "unknown",
              node: process.version,
              platform: process.platform,
              arch: process.arch,
            },
            graph_optimization: {
              requested: values["wasm-graph-optimization"] ?? null,
              effective: null,
            },
            external_request_count: 0,
            page_error_count: 0,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    } catch {
      // Preserve the original nonzero result without printing paths or input text.
    }
    console.error("browser parity execution failed");
    process.exitCode = 1;
  }
}

export {
  argsFrom,
  graphOptimizationReport,
  parseWasmGraphOptimization,
  wasmSessionOptions,
  installLogitsValidator,
};
