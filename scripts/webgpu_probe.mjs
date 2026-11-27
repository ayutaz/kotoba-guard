/* global chrome, navigator, performance */

import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceExtension = path.join(root, "dist", "extension");
const isolatedExtension = path.join(root, ".cache", "isolated-gpu-extension");
const revision = "8d640720bddeb64c89dc1fa7780c3ea29fa523e8";
const fp16Source = path.join(
  root,
  "models",
  "converted",
  revision,
  "onnx",
  "model_fp16.onnx",
);
const fp16Target = path.join(
  isolatedExtension,
  "models",
  "onnx",
  "model_fp16.onnx",
);
const outputPath = path.join(root, "artifacts", "webgpu-probe.json");

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function main() {
  const startedAt = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    measuredAt: startedAt,
    status: "not-run",
    requestedBackend: "webgpu",
    fallbackToWasm: false,
    environment: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
      playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
      offline: true,
    },
    model: {
      modelId: "sbintuitions/ja-typo-detector-modernbert-ja-base-30m",
      revision,
      source: path.relative(root, fp16Source).replaceAll(path.sep, "/"),
      isolatedTarget: path.relative(root, fp16Target).replaceAll(path.sep, "/"),
    },
    adapter: null,
    initialization: null,
    shortInference: null,
    benchmark: null,
    externalRequests: [],
    pageErrors: [],
    error: null,
    limitations: [
      "This is an isolated probe using a temporary FP16 copy; dist/extension is not modified.",
      "A successful run establishes this browser's WebGPU execution path only, not cross-device performance.",
      "The measured latency excludes extension UI and post-processing.",
    ],
  };
  let context;
  let userDataDir;
  try {
    if (
      path.relative(root, isolatedExtension) !==
      path.join(".cache", "isolated-gpu-extension")
    )
      throw new Error("Invalid isolated extension target");
    await rm(isolatedExtension, { recursive: true, force: true });
    await cp(sourceExtension, isolatedExtension, { recursive: true });
    await cp(fp16Source, fp16Target);
    report.model.fp16Bytes = (await readFile(fp16Target)).byteLength;
    report.model.fp16Sha256 = await sha256(fp16Target);
    userDataDir = await mkdtemp(
      path.join(os.tmpdir(), "kotoba-guard-webgpu-probe-"),
    );
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      args: [
        "--enable-unsafe-extension-debugging",
        "--enable-unsafe-webgpu",
        `--disable-extensions-except=${isolatedExtension}`,
        `--load-extension=${isolatedExtension}`,
      ],
    });
    await context.setOffline(true);
    report.environment.browser = context.browser()?.version();
    context.on("request", (request) => {
      const url = request.url();
      if (/^(https?|ws|wss):/.test(url)) report.externalRequests.push(url);
    });
    context.on("weberror", (error) =>
      report.pageErrors.push(error.error().message),
    );
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
    const extensionId = new URL(worker.url()).host;
    report.environment.extensionId = extensionId;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.waitForLoadState("domcontentloaded");
    const result = await page.evaluate(async () => {
      const getAdapterInfo = async () => {
        if (typeof navigator.gpu?.requestAdapter !== "function")
          return {
            apiAvailable: false,
            available: false,
            info: null,
            isFallbackAdapter: null,
          };
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter)
          return {
            apiAvailable: true,
            available: false,
            info: null,
            isFallbackAdapter: null,
          };
        const info = adapter.info;
        const read = (name) => {
          try {
            return info?.[name] ?? adapter?.[name] ?? null;
          } catch {
            return null;
          }
        };
        return {
          apiAvailable: true,
          available: true,
          info: {
            vendor: read("vendor"),
            architecture: read("architecture"),
            device: read("device"),
            description: read("description"),
          },
          isFallbackAdapter:
            typeof adapter.isFallbackAdapter === "boolean"
              ? adapter.isFallbackAdapter
              : null,
        };
      };
      const adapter = await getAdapterInfo();
      if (!adapter.available)
        return {
          status: "adapter-unavailable",
          adapter,
        };
      try {
        const started = performance.now();
        const core = await import(chrome.runtime.getURL("core.js"));
        const modelRoot = chrome.runtime.getURL("models/");
        const tokenizer = await core.createTransformersTokenizer(modelRoot);
        const factory = core.createOrtSessionFactory(
          chrome.runtime.getURL("models/onnx/model_fp16.onnx"),
          { wasmThreads: 1, wasmPath: chrome.runtime.getURL("wasm/") },
        );
        const session = await factory("webgpu");
        const initializationMs = performance.now() - started;
        const seed = await tokenizer.encode(
          "これはWebGPU実行プローブ用の日本語文章です。",
        );
        const seedIds = Array.from(seed.inputIds, Number);
        const body = seedIds.slice(1, -1);
        if (body.length === 0) throw new Error("tokenizer produced no IDs");
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
        const runLength = async (length) => {
          const ids = new Array(length);
          ids[0] = 1;
          ids[length - 1] = 2;
          for (let index = 1; index < length - 1; index += 1)
            ids[index] = body[(index - 1) % body.length];
          const feeds = {};
          for (const name of session.inputNames) {
            if (name === "input_ids")
              feeds[name] = core.createTensor("int64", ids, [1, length]);
            else if (name === "attention_mask")
              feeds[name] = core.createTensor(
                "int64",
                new Array(length).fill(1),
                [1, length],
              );
            else if (name === "token_type_ids")
              feeds[name] = core.createTensor(
                "int64",
                new Array(length).fill(0),
                [1, length],
              );
            else throw new Error(`unsupported model input: ${name}`);
          }
          const runStarted = performance.now();
          const outputs = await session.run(feeds);
          const elapsedMs = performance.now() - runStarted;
          for (const tensor of Object.values(feeds)) tensor.dispose?.();
          for (const tensor of Object.values(outputs)) tensor.dispose?.();
          return elapsedMs;
        };
        const shortInferenceMs = await runLength(16);
        for (let index = 0; index < 3; index += 1) await runLength(128);
        const samples = [];
        for (let index = 0; index < 20; index += 1)
          samples.push(await runLength(128));
        await session.release?.();
        return {
          status: "success",
          adapter,
          initializationMs,
          sessionInputs: [...session.inputNames],
          sessionOutputs: [...session.outputNames],
          shortInferenceMs,
          benchmark: {
            tokenLength: 128,
            warmupRuns: 3,
            sampleRuns: 20,
            ...summarizeInPage(samples),
          },
        };
      } catch (error) {
        return {
          status: "webgpu-execution-failed",
          adapter,
          error: {
            name: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    });
    report.status = result.status;
    report.adapter = result.adapter;
    if (result.initializationMs !== undefined)
      report.initialization = {
        coldMs: result.initializationMs,
        sessionInputs: result.sessionInputs,
        sessionOutputs: result.sessionOutputs,
      };
    if (result.shortInferenceMs !== undefined)
      report.shortInference = {
        tokens: 16,
        elapsedMs: result.shortInferenceMs,
      };
    if (result.benchmark !== undefined) report.benchmark = result.benchmark;
    if (result.error !== undefined) report.error = result.error;
  } catch (error) {
    report.status = "probe-failed";
    report.error = {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await context?.close();
    if (userDataDir) {
      const safeProfile =
        path.dirname(userDataDir) === os.tmpdir() &&
        path.basename(userDataDir).startsWith("kotoba-guard-webgpu-probe-");
      if (safeProfile) await rm(userDataDir, { recursive: true, force: true });
      else {
        process.exitCode = 1;
        console.error("Refusing to remove an unexpected browser profile path");
      }
    }
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "success") process.exitCode = 1;
}

await main();
