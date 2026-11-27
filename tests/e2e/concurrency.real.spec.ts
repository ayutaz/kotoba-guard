import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createChromiumLaunchOptions } from "./browser-options";
import { cleanupFixtureResources } from "./fixture-resources";
import { readSourceIdentity } from "./source-identity";
import { inventory } from "../../scripts/retention_trial_evidence.mjs";

test("real: shared model Worker completes two concurrent requests without cancellation", async () => {
  const extension = process.env.KOTOBA_CONCURRENCY_EXTENSION;
  const output = process.env.KOTOBA_CONCURRENCY_OUTPUT;
  expect(extension && path.isAbsolute(extension)).toBe(true);
  expect(output && path.isAbsolute(output)).toBe(true);
  await expect(stat(output!)).rejects.toMatchObject({ code: "ENOENT" });
  const identity = readSourceIdentity();
  expect(identity.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(identity.runtimeSourceCommit).toBe(identity.sourceCommit);
  const assets = inventory(extension!) as Record<
    string,
    { bytes: number; sha256: string }
  >;
  expect(Object.keys(assets)).toHaveLength(78);
  const expectedModelSha =
    process.env.KOTOBA_CONCURRENCY_MODEL_SHA256 ??
    "dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab";
  expect(expectedModelSha).toMatch(/^[0-9a-f]{64}$/);
  expect(assets["models/onnx/model_quantized.onnx"]?.sha256).toBe(
    expectedModelSha,
  );
  let context: BrowserContext | undefined;
  let unexpectedRequests = 0;
  let pageErrors = 0;
  let failure: unknown;
  const report: Record<string, unknown> = {
    ...identity,
    status: "failed",
    cleanup: "pending",
    completedInferences: 0,
    assets,
    testSha256: createHash("sha256")
      .update(await readFile("tests/e2e/concurrency.real.spec.ts"))
      .digest("hex"),
  };
  try {
    context = await chromium.launchPersistentContext(
      "",
      createChromiumLaunchOptions(extension!),
    );
    context.on("request", (request) => {
      if (/^https?:|^wss?:/.test(request.url())) unexpectedRequests++;
    });
    context.on("weberror", () => {
      pageErrors++;
    });
    const background =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    report.browserVersion = context.browser()!.version();
    const extensionId = new URL(background.url()).host;
    await context.setOffline(true);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const result = await popup.evaluate(async () => {
      const worker = new Worker(chrome.runtime.getURL("worker.js"), {
        type: "module",
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<{
          completedInferences: number;
          busyResponses: number;
          disposed: boolean;
          backend: string;
          modelVersion: string;
        }>((resolve, reject) => {
          const completed = new Set<number>();
          let busyResponses = 0;
          let disposing = false;
          let modelVersion = "";
          const invalid = () =>
            reject(new Error("concurrent-worker-result-invalid"));
          timer = setTimeout(
            () => reject(new Error("concurrent-worker-timeout")),
            60000,
          );
          worker.onerror = () => reject(new Error("concurrent-worker-error"));
          worker.onmessage = (event) => {
            const value = event.data;
            if (value?.type === "disposed") {
              if (!disposing || value.ok !== true) return invalid();
              resolve({
                completedInferences: completed.size,
                busyResponses,
                disposed: true,
                backend: "wasm",
                modelVersion,
              });
              return;
            }
            if (value?.id === 3) {
              if (
                value.ok !== false ||
                value.code !== "worker-busy" ||
                busyResponses !== 0
              )
                return invalid();
              busyResponses++;
            } else if (value?.id === 1 || value?.id === 2) {
              const result = value.result;
              if (
                value.ok !== true ||
                completed.has(value.id) ||
                result?.backend !== "wasm" ||
                !Array.isArray(result.detections) ||
                !result.detections.some(
                  (d: { text?: string }) => d.text === "移行",
                )
              )
                return invalid();
              if (modelVersion && result.modelVersion !== modelVersion)
                return invalid();
              modelVersion = result.modelVersion;
              completed.add(value.id);
            } else return invalid();
            if (completed.size === 2 && busyResponses === 1 && !disposing) {
              disposing = true;
              worker.postMessage({ type: "dispose" });
            }
          };
          for (const id of [1, 2, 3])
            worker.postMessage({
              id,
              type: "detect",
              text: "明日の予定については、来週移行にご連絡します。",
            });
        });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        worker.terminate();
      }
    });
    expect(result).toMatchObject({
      completedInferences: 2,
      busyResponses: 1,
      disposed: true,
      backend: "wasm",
      modelVersion: "8d640720bddeb64c89dc1fa7780c3ea29fa523e8",
    });
    expect(unexpectedRequests).toBe(0);
    expect(pageErrors).toBe(0);
    Object.assign(report, result, {
      status: "completed",
      offlineBeforeWorker: true,
    });
  } catch (error) {
    failure = error;
  } finally {
    try {
      await cleanupFixtureResources(context, async () => undefined);
      report.cleanup = "completed";
    } catch (error) {
      report.cleanup = "failed";
      failure ??= error;
    }
    report.unexpectedRequests = unexpectedRequests;
    report.pageErrors = pageErrors;
    report.assetsUnchanged =
      JSON.stringify(inventory(extension!)) === JSON.stringify(assets);
    if (failure) report.status = "failed";
    await writeFile(output!, JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
    });
  }
  if (failure) throw failure;
  expect(report.assetsUnchanged).toBe(true);
});
