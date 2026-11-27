/* global performance, chrome, navigator */
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectEntrypoint } from "./browser_security_audit_helpers.mjs";
import {
  sampleLinuxBrowserMemory,
  sampleWindowsBrowserMemory,
} from "./browser_process_memory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lengths = [32, 64, 128, 256, 512, 1024];
const warmupRuns = 3;
const sampleRuns = 20;
const defaultModelRelative = "models/onnx/model_quantized.onnx";
const defaultManifestRelative = "models/manifest.json";
const expectedModelId = "sbintuitions/ja-typo-detector-modernbert-ja-base-30m";
const expectedModelRevision = "8d640720bddeb64c89dc1fa7780c3ea29fa523e8";
const supportedCandidateKinds = new Set([
  "weight-only-qdq",
  "embedding-u8-matmul-fp16-storage",
]);

export function parseArgs(argv) {
  const values = {};
  const valueOptions = new Set([
    "extension",
    "model-relative",
    "model-manifest",
    "model-kind",
    "output",
    "wasm-threads",
    "token-lengths",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help") return { help: true };
    if (!value.startsWith("--") || !valueOptions.has(value.slice(2))) {
      throw new Error(`unknown or malformed option: ${value}`);
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`option requires a value: ${value}`);
    }
    values[key] = next;
    index += 1;
  }
  return values;
}

export function resolveBenchmarkConfig(values = {}) {
  const modelRelative = (
    values["model-relative"] ?? defaultModelRelative
  ).replaceAll("\\", "/");
  const manifestRelative = (
    values["model-manifest"] ?? defaultManifestRelative
  ).replaceAll("\\", "/");
  const wasmThreadsValue = values["wasm-threads"] ?? "1";
  let tokenLengths = [...lengths];
  if (values["token-lengths"] !== undefined) {
    const requested = values["token-lengths"];
    if (typeof requested !== "string" || !/^\d+(,\d+)*$/.test(requested))
      throw new Error(
        "--token-lengths requires comma-separated supported integers",
      );
    tokenLengths = requested.split(",").map(Number);
    if (
      new Set(tokenLengths).size !== tokenLengths.length ||
      tokenLengths.some((value) => !lengths.includes(value))
    )
      throw new Error(
        "--token-lengths contains duplicate or unsupported lengths",
      );
    if (values.output === undefined)
      throw new Error(
        "changed token-length scope requires an explicit --output",
      );
  }
  if (!/^[124]$/.test(wasmThreadsValue)) {
    throw new Error("--wasm-threads must be one of 1, 2, or 4");
  }
  const wasmThreads = Number(wasmThreadsValue);
  const candidate = [
    "extension",
    "model-relative",
    "model-manifest",
    "model-kind",
    "wasm-threads",
  ].some((key) => values[key] !== undefined);
  if (
    values["model-kind"] !== undefined &&
    !/^[a-z0-9][a-z0-9._-]+$/.test(values["model-kind"])
  ) {
    throw new Error(
      "--model-kind must contain only lowercase ASCII identifiers",
    );
  }
  if (candidate && values.output === undefined) {
    throw new Error("candidate benchmark requires an explicit --output");
  }
  if (candidate && values["model-kind"] === undefined) {
    throw new Error("candidate benchmark requires an explicit --model-kind");
  }
  return {
    extensionDir: path.resolve(root, values.extension ?? "dist/extension"),
    artifactPath: path.resolve(
      root,
      values.output ?? "artifacts/browser-benchmark.json",
    ),
    modelRelative,
    manifestRelative,
    modelKind: values["model-kind"] ?? null,
    wasmThreads,
    tokenLengths,
    customScope: values["token-lengths"] !== undefined,
    candidate,
  };
}

export function resolveSourceCommit(values, environment = process.env) {
  const sourceCommit = environment.SOURCE_COMMIT ?? environment.GITHUB_SHA;
  if (
    (values.candidate || values.customScope) &&
    !/^[0-9a-f]{40}$/i.test(sourceCommit ?? "")
  ) {
    throw new Error(
      "candidate benchmark requires SOURCE_COMMIT or GITHUB_SHA as a 40-hex commit",
    );
  }
  return sourceCommit ?? "unknown";
}

function resolveInside(rootDir, relativePath, label) {
  const resolved = path.resolve(rootDir, relativePath);
  const relative = path.relative(rootDir, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must stay inside the extension directory`);
  }
  return resolved;
}

function manifestEntry(manifest, relativePath) {
  const key = relativePath.replaceAll("\\", "/").replace(/^models\//, "");
  return manifest?.files?.[key] ?? manifest?.artifacts?.[key] ?? null;
}

export function verifyModelManifest(manifest, modelRelative, modelStats) {
  const declared = manifestEntry(manifest, modelRelative);
  if (!declared)
    throw new Error(`model is missing from manifest: ${modelRelative}`);
  if (
    declared.bytes !== modelStats.bytes ||
    declared.sha256 !== modelStats.sha256
  ) {
    throw new Error("model size or SHA-256 does not match its manifest");
  }
  return declared;
}

export function verifyManifestIdentity(manifest, config) {
  if (
    manifest.model_id !== expectedModelId ||
    manifest.revision !== expectedModelRevision
  ) {
    throw new Error("manifest model identity does not match the pinned model");
  }
  if (
    config.candidate &&
    (!supportedCandidateKinds.has(config.modelKind) ||
      manifest.model_kind !== config.modelKind)
  ) {
    throw new Error("candidate manifest kind is unsupported or mismatched");
  }
  if (config.modelKind === "embedding-u8-matmul-fp16-storage") {
    const conversion = manifest.conversion;
    const expected = {
      embedding_dequantize_after_gather: true,
      matmul_fp16_storage: true,
      matmul_storage_dtype: "FLOAT16",
      matmul_compute_dtype: "FLOAT",
      activation_dtype: "FLOAT",
    };
    if (
      conversion?.schema_version !== "weight-only-matmul-fp16-storage-v1" ||
      Object.entries(expected).some(
        ([key, value]) => conversion?.options?.[key] !== value,
      )
    ) {
      throw new Error(
        "FP16 storage conversion schema/options are missing or mismatched",
      );
    }
  }
}

export function verifyAssetManifest(manifest, assets) {
  for (const [relativePath, observed] of Object.entries(assets)) {
    if (!relativePath.startsWith("models/")) continue;
    const declared = manifestEntry(manifest, relativePath);
    if (
      !declared ||
      declared.bytes !== observed.bytes ||
      declared.sha256 !== observed.sha256
    ) {
      throw new Error(
        `asset size or SHA-256 does not match its manifest: ${relativePath}`,
      );
    }
  }
}

export function assessThreadConfiguration({
  requested,
  effective,
  crossOriginIsolated,
  sharedArrayBufferAvailable,
  hardwareConcurrency = null,
}) {
  const failures = [];
  if (effective !== requested) failures.push("ort-num-threads-fallback");
  if (requested > 1 && !crossOriginIsolated)
    failures.push("cross-origin-isolation-unavailable");
  if (requested > 1 && !sharedArrayBufferAvailable)
    failures.push("shared-array-buffer-unavailable");
  return {
    status: failures.length === 0 ? "passed" : "failed",
    requested,
    effective,
    crossOriginIsolated,
    sharedArrayBufferAvailable,
    hardwareConcurrency,
    effectiveEvidence: "post-initialization ort.env.wasm.numThreads",
    failures,
    workerEventsAreDiagnosticOnly: true,
  };
}

export function summarizeProcessMemory(initial, final) {
  const sum = (rows, field) => {
    if (
      !Array.isArray(rows) ||
      rows.length === 0 ||
      rows.some((row) => !Number.isSafeInteger(row?.[field]) || row[field] <= 0)
    )
      return null;
    const total = rows.reduce((value, row) => value + row[field], 0);
    return Number.isSafeInteger(total) ? total : null;
  };
  const baselineBytes = sum(initial?.rows, "currentBytes");
  const currentBytes = sum(final?.rows, "currentBytes");
  const hwmSumBytes = sum(final?.rows, "peakBytes");
  const measured =
    initial?.status === "measured" &&
    final?.status === "measured" &&
    baselineBytes !== null &&
    currentBytes !== null &&
    hwmSumBytes !== null;
  return {
    measured,
    scope: "cdp-associated-browser-processes",
    initialStatus: initial?.status ?? "unavailable",
    finalStatus: final?.status ?? "unavailable",
    initial,
    final,
    baselineBytes,
    currentBytes,
    hwmSumBytes,
    limitations: [
      "HWM sum is not a simultaneous process RSS peak.",
      "Only CDP-enumerated browser processes are included; helper scope excludes other processes.",
    ],
  };
}

export function buildExtensionProvenance({
  rootDir,
  extensionDir,
  manifestPath,
  modelManifest,
  modelRelative,
  modelKind,
  modelStats,
  assets,
  sourceCommit,
  extensionId = null,
}) {
  return {
    path: path.relative(rootDir, extensionDir).replaceAll(path.sep, "/"),
    extensionId,
    sourceCommit,
    manifest: path.relative(rootDir, manifestPath).replaceAll(path.sep, "/"),
    modelRevision: modelManifest.revision,
    modelId: modelManifest.model_id,
    modelKind: modelKind ?? modelManifest.model_kind ?? null,
    modelFile: modelRelative.replaceAll(path.sep, "/"),
    model: modelStats,
    assets,
  };
}

export async function assertCandidateOutputAvailable(config) {
  if (
    (config.candidate || config.customScope) &&
    (await pathExists(config.artifactPath))
  ) {
    throw new Error(
      `refusing to overwrite candidate output: ${config.artifactPath}`,
    );
  }
}

async function assetHashes(extensionDir) {
  const assets = {};
  for (const relative of ["core.js", "manifest.json"]) {
    const filePath = resolveInside(
      extensionDir,
      relative,
      "extension asset path",
    );
    const info = await stat(filePath);
    assets[relative] = { bytes: info.size, sha256: await sha256(filePath) };
  }
  for (const relative of [
    "models/config.json",
    "models/tokenizer.json",
    "models/tokenizer_config.json",
  ]) {
    const filePath = resolveInside(extensionDir, relative, "asset path");
    const info = await stat(filePath);
    assets[relative] = { bytes: info.size, sha256: await sha256(filePath) };
  }
  const wasmDir = resolveInside(extensionDir, "wasm", "WASM directory");
  for (const name of (await readdir(wasmDir)).sort()) {
    if (
      name !== "ort.webgpu.min.mjs" &&
      !/^ort-wasm.*\.(?:wasm|mjs)$/.test(name)
    )
      continue;
    const relative = `wasm/${name}`;
    const filePath = resolveInside(extensionDir, relative, "WASM asset path");
    const info = await stat(filePath);
    assets[relative] = { bytes: info.size, sha256: await sha256(filePath) };
  }
  if (!Object.keys(assets).some((relative) => relative.startsWith("wasm/"))) {
    throw new Error("WASM runtime asset inventory is empty");
  }
  return assets;
}

export function resolveOrtWebVersion(lockfile) {
  const version = lockfile?.packages?.["node_modules/onnxruntime-web"]?.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(
      "onnxruntime-web version is missing from package-lock.json",
    );
  }
  return version;
}

async function readOrtWebVersion() {
  return resolveOrtWebVersion(
    JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")),
  );
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    console.log(
      "Usage: node scripts/browser_benchmark.mjs [--extension DIR] [--model-relative PATH] [--model-manifest PATH] [--model-kind NAME] [--wasm-threads 1|2|4] [--token-lengths 32,64,128,256,512,1024] [--output FILE]",
    );
    return;
  }
  const config = resolveBenchmarkConfig(parsed);
  const { extensionDir, artifactPath, modelRelative, manifestRelative } =
    config;
  await assertCandidateOutputAvailable(config);
  const sourceCommit = resolveSourceCommit(config);
  const manifestPath = resolveInside(
    extensionDir,
    manifestRelative,
    "model manifest path",
  );
  const modelManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  verifyManifestIdentity(modelManifest, config);
  const modelPath = resolveInside(extensionDir, modelRelative, "model path");
  const modelInfo = await stat(modelPath);
  const modelStats = {
    bytes: modelInfo.size,
    sha256: await sha256(modelPath),
  };
  verifyModelManifest(modelManifest, modelRelative, modelStats);
  const assets = await assetHashes(extensionDir);
  verifyAssetManifest(modelManifest, assets);
  const ortWebVersion = await readOrtWebVersion();
  const modelConfig = JSON.parse(
    await readFile(path.join(extensionDir, "models", "config.json"), "utf8"),
  );
  const specialTokenIds = {
    bos: modelConfig.bos_token_id,
    eos: modelConfig.eos_token_id,
  };
  if (
    !Number.isSafeInteger(specialTokenIds.bos) ||
    !Number.isSafeInteger(specialTokenIds.eos)
  ) {
    throw new Error("model config must provide integer BOS/EOS token IDs");
  }
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), "kotoba-guard-browser-benchmark-"),
  );
  const externalRequests = [];
  const pageErrors = [];
  let context;
  let cdp;
  let browserVersion;
  let measurement;
  let processMemory;
  try {
    const extensionManifest = JSON.parse(
      await readFile(path.join(extensionDir, "manifest.json"), "utf8"),
    );
    const expectedWorkerPath = `/${extensionManifest.background?.service_worker ?? ""}`;
    if (expectedWorkerPath === "/")
      throw new Error("selected extension has no background service worker");
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      channel: "chromium",
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        "--enable-unsafe-extension-debugging",
        "--enable-precise-memory-info",
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
      ],
    });
    await context.setOffline(true);
    browserVersion = context.browser()?.version();
    cdp = await context.browser()?.newBrowserCDPSession();
    const getProcessInfo = async () => cdp.send("SystemInfo.getProcessInfo");
    const sampleMemory =
      process.platform === "win32"
        ? () => sampleWindowsBrowserMemory({ getProcessInfo })
        : () => sampleLinuxBrowserMemory({ getProcessInfo });
    const initialProcessMemory = await sampleMemory();
    const isExpectedWorker = (worker) => {
      try {
        const url = new URL(worker.url());
        return (
          url.protocol === "chrome-extension:" &&
          url.pathname === expectedWorkerPath
        );
      } catch {
        return false;
      }
    };
    const serviceWorker =
      context.serviceWorkers().find(isExpectedWorker) ??
      (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
    if (!isExpectedWorker(serviceWorker)) {
      throw new Error(
        "selected service worker is not the extension background worker",
      );
    }
    const extensionId = new URL(serviceWorker.url()).host;
    const page = await context.newPage();
    const workerUrls = [];
    page.on("worker", (worker) => workerUrls.push(worker.url()));
    page.on("request", (request) => {
      const url = request.url();
      if (/^(https?|ws|wss):/.test(url)) externalRequests.push(url);
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.waitForLoadState("domcontentloaded");
    measurement = await page.evaluate(
      async ({
        lengths: requestedLengths,
        warmup,
        samples,
        modelPath,
        specialTokenIds,
        requestedWasmThreads,
      }) => {
        const memorySnapshot = () => {
          const memory = performance.memory;
          if (!memory) return null;
          return {
            usedJSHeapSize: memory.usedJSHeapSize,
            totalJSHeapSize: memory.totalJSHeapSize,
            jsHeapSizeLimit: memory.jsHeapSizeLimit,
          };
        };
        const now = () => performance.now();
        const summarizeInPage = (values) => {
          const ordered = [...values].sort((a, b) => a - b);
          const at = (percentage) =>
            ordered[
              Math.max(
                0,
                Math.min(
                  Math.ceil((percentage / 100) * ordered.length) - 1,
                  ordered.length - 1,
                ),
              )
            ];
          return {
            samples: values.length,
            minMs: Math.min(...values),
            maxMs: Math.max(...values),
            p50Ms: at(50),
            p95Ms: at(95),
            p99Ms: at(99),
            meanMs:
              values.reduce((sum, value) => sum + value, 0) / values.length,
          };
        };
        const moduleStart = now();
        const ortRuntime = await import(
          chrome.runtime.getURL("wasm/ort.webgpu.min.mjs")
        );
        ortRuntime.env.wasm.numThreads = requestedWasmThreads;
        const core = await import(chrome.runtime.getURL("core.js"));
        const coreImportMs = now() - moduleStart;
        const modelRoot = chrome.runtime.getURL("models/");
        const tokenizerStart = now();
        const tokenizer = await core.createTransformersTokenizer(modelRoot);
        const tokenizerMs = now() - tokenizerStart;
        const seed = await tokenizer.encode(
          "これはブラウザ推論の計測に使う日本語の文章です。",
        );
        const seedIds = Array.from(seed.inputIds, Number);
        const bos = specialTokenIds.bos;
        const eos = specialTokenIds.eos;
        const body = seedIds.filter((id) => id !== bos && id !== eos);
        if (body.length === 0)
          throw new Error("tokenizer produced no ordinary IDs");
        const factory = core.createOrtSessionFactory(
          chrome.runtime.getURL(modelPath),
          {
            wasmThreads: requestedWasmThreads,
            wasmPath: chrome.runtime.getURL("wasm/"),
          },
        );
        const sessionStart = now();
        const session = await factory("wasm");
        const sessionMs = now() - sessionStart;
        const coldInitMs = now() - moduleStart;
        const memoryBeforeRuns = memorySnapshot();
        const crossOriginIsolatedValue =
          globalThis.crossOriginIsolated === true;
        const sharedArrayBufferAvailable = (() => {
          try {
            return (
              typeof globalThis.SharedArrayBuffer === "function" &&
              new globalThis.SharedArrayBuffer(1).byteLength === 1
            );
          } catch {
            return false;
          }
        })();

        const runLength = async (length) => {
          const ids = new Array(length);
          const mask = new Array(length).fill(1);
          ids[0] = bos;
          ids[length - 1] = eos;
          for (let index = 1; index < length - 1; index += 1)
            ids[index] = body[(index - 1) % body.length];
          const feeds = {};
          for (const name of session.inputNames) {
            if (name === "input_ids")
              feeds[name] = core.createTensor("int64", ids, [1, length]);
            else if (name === "attention_mask")
              feeds[name] = core.createTensor("int64", mask, [1, length]);
            else if (name === "token_type_ids")
              feeds[name] = core.createTensor(
                "int64",
                new Array(length).fill(0),
                [1, length],
              );
            else throw new Error(`unsupported model input: ${name}`);
          }
          const started = now();
          const outputs = await session.run(feeds);
          const elapsedMs = now() - started;
          for (const tensor of Object.values(feeds)) tensor.dispose?.();
          for (const tensor of Object.values(outputs)) tensor.dispose?.();
          return elapsedMs;
        };

        const runs = {};
        for (const length of requestedLengths) {
          for (let index = 0; index < warmup; index += 1)
            await runLength(length);
          const values = [];
          for (let index = 0; index < samples; index += 1)
            values.push(await runLength(length));
          runs[String(length)] = {
            tokenLength: length,
            ...summarizeInPage(values),
            memoryAfterRuns: memorySnapshot(),
          };
        }
        const adapter =
          typeof navigator.gpu?.requestAdapter === "function"
            ? await navigator.gpu.requestAdapter()
            : null;
        const adapterInfo = adapter?.info ?? {};
        const adapterText = JSON.stringify(adapterInfo).toLowerCase();
        await session.release?.();
        return {
          backend: "wasm",
          threadRuntime: {
            requested: requestedWasmThreads,
            effective: ortRuntime.env.wasm.numThreads,
            crossOriginIsolated: crossOriginIsolatedValue,
            sharedArrayBufferAvailable,
            hardwareConcurrency: navigator.hardwareConcurrency ?? null,
          },
          coreImportMs,
          tokenizerMs,
          sessionMs,
          coldInitMs,
          modelRoot,
          sessionInputs: [...session.inputNames],
          sessionOutputs: [...session.outputNames],
          memory: {
            scope:
              "performance.memory JavaScript heap counters for the extension page; process peak and native WASM memory are not measured",
            available: memoryBeforeRuns !== null,
            beforeRuns: memoryBeforeRuns,
          },
          runs,
          webgpu: {
            apiAvailable: typeof navigator.gpu?.requestAdapter === "function",
            adapterAvailable: adapter !== null,
            adapterInfo,
            softwareLikely:
              adapter !== null &&
              /(swiftshader|software|llvmpipe|llvmpipe|angle)/.test(
                adapterText,
              ),
            measured: false,
            note: "WebGPU adapter discovery only; this run did not execute the model with WebGPU and does not establish hardware-GPU performance.",
          },
        };
      },
      {
        lengths: config.tokenLengths,
        warmup: warmupRuns,
        samples: sampleRuns,
        modelPath: modelRelative,
        specialTokenIds,
        requestedWasmThreads: config.wasmThreads,
      },
    );
    const threadRuntime = assessThreadConfiguration(measurement.threadRuntime);
    const finalProcessMemory = await sampleMemory();
    processMemory = summarizeProcessMemory(
      initialProcessMemory,
      finalProcessMemory,
    );
    const report = {
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      environment: {
        os: process.platform,
        arch: process.arch,
        node: process.version,
        browser: browserVersion,
        playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
        offline: true,
      },
      extension: {
        ...buildExtensionProvenance({
          rootDir: root,
          extensionDir,
          manifestPath,
          modelManifest,
          modelRelative,
          modelKind: config.modelKind,
          modelStats,
          assets,
          sourceCommit,
          extensionId,
        }),
      },
      benchmark: {
        backend: "wasm",
        wasmThreads: config.wasmThreads,
        runtime: {
          provider: "wasm",
          onnxruntimeWeb: ortWebVersion,
          wasmThreads: config.wasmThreads,
          sessionRunOnly: true,
        },
        threads: {
          ...threadRuntime,
          workerEventCount: workerUrls.length,
          workerUrls,
        },
        specialTokenIds,
        tokenLengths: config.tokenLengths,
        warmupRuns,
        sampleRuns,
        timingUnit: "ms",
        measurement,
      },
      processMemory,
      externalRequests,
      pageErrors,
      limitations: [
        `This is a local ${process.platform} headless Chromium measurement of the selected extension directory: ${path.relative(root, extensionDir).replaceAll(path.sep, "/")}.`,
        "Latency is session.run only after tokenizer and session initialization; it excludes extension UI and text post-processing.",
        "The memory field covers JavaScript heap counters only; native WASM and process peak memory are not measured.",
        "Process memory is sampled before and after timed runs; HWM sum is not a simultaneous RSS peak and only CDP-associated browser processes are included.",
        "External requests and page errors are observed on the benchmark popup page only; this is not a full extension security audit.",
        "WebGPU was only probed for adapter availability; no WebGPU model timing or hardware-GPU claim is made.",
        "Worker event URLs and counts are diagnostics only and do not prove the effective WebAssembly thread count.",
      ],
    };
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(
      artifactPath,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    console.log(
      JSON.stringify({
        output: path.relative(root, artifactPath).replaceAll(path.sep, "/"),
        model: report.extension.model,
        modelKind: report.extension.modelKind,
        sourceCommit,
        backend: report.benchmark.backend,
        wasmThreads: report.benchmark.wasmThreads,
        threadStatus: report.benchmark.threads.status,
        effectiveWasmThreads: report.benchmark.threads.effective,
        tokenLengths: config.tokenLengths,
        externalRequestCount: externalRequests.length,
        pageErrorCount: pageErrors.length,
      }),
    );
    if (
      externalRequests.length > 0 ||
      pageErrors.length > 0 ||
      !processMemory.measured ||
      threadRuntime.status === "failed"
    ) {
      process.exitCode = 1;
      console.error(
        `benchmark integrity failure: ${externalRequests.length} external requests, ${pageErrors.length} page errors, process memory measured: ${processMemory.measured}, thread status: ${threadRuntime.status}`,
      );
    }
  } finally {
    if (cdp) await cdp.detach().catch(() => undefined);
    await context?.close();
    const safeProfile =
      path.dirname(userDataDir) === os.tmpdir() &&
      path.basename(userDataDir).startsWith("kotoba-guard-browser-benchmark-");
    if (safeProfile) await rm(userDataDir, { recursive: true, force: true });
    else {
      process.exitCode = 1;
      console.error("Refusing to remove an unexpected browser profile path");
    }
  }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1]))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
