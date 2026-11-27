import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type CDPSession,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createChromiumLaunchOptions } from "../e2e/browser-options";
import { findCalibrationWorker } from "./heap-target";
import { cleanupFixtureResources } from "../e2e/fixture-resources";
import { heapFixtureFiles } from "./heap-fixture";
import { WorkerHeapSession } from "./worker-heap-session";

test("calibration: distinguish linear WASM, backing storage and JS heap without a model", async () => {
  const sourceCommit = process.env.SOURCE_COMMIT!;
  const output = process.env.KOTOBA_HEAP_PROBE_OUTPUT!;
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", `safe.directory=${process.cwd().replaceAll("\\", "/")}`, ...args],
      { encoding: "utf8" },
    ).trim();
  expect(git("rev-parse", "HEAD")).toBe(sourceCommit);
  expect(git("status", "--porcelain")).toBe("");
  expect(process.platform).toBe("win32");
  const sha = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
  const controls: Record<string, string> = {};
  for (const name of [
    "tests/diagnostics/heap-calibration.spec.ts",
    "tests/diagnostics/heap-fixture.ts",
    "tests/diagnostics/worker-heap-session.ts",
    "scripts/diagnostics/wasm-memory-probe.mjs",
    "playwright.heap-probe.config.ts",
    "tests/e2e/browser-options.ts",
    "tests/diagnostics/heap-target.ts",
    "tests/e2e/fixture-resources.ts",
  ]) {
    controls[name] = sha(await readFile(name));
  }
  const files = heapFixtureFiles(
    await readFile("scripts/diagnostics/wasm-memory-probe.mjs", "utf8"),
  );
  const fixtureAssets = Object.fromEntries(
    Object.entries(files).map(([name, content]) => [name, sha(content)]),
  );
  const samples: Array<{
    phase: string;
    elapsedMs: number;
    metadata: Awaited<ReturnType<WorkerHeapSession["read"]>>;
  }> = [];
  const cleanupPhases: Array<{
    resource: string;
    status: string;
    elapsedMs: number | null;
  }> = [];
  let context: BrowserContext | undefined;
  let cdp: CDPSession | undefined;
  let child: WorkerHeapSession | undefined;
  let failure: unknown;
  let status = "failed";
  let stage = "setup";
  let browserVersion: string | undefined;
  let externalRequests = 0;
  let pageErrors = 0;
  const startedAt = performance.now();
  try {
    await mkdir(".cache", { recursive: true });
    const directory = await mkdtemp(path.resolve(".cache/heap-calibration-"));
    for (const [name, content] of Object.entries(files))
      await writeFile(path.join(directory, name), content, { flag: "wx" });
    context = await chromium.launchPersistentContext(
      "",
      createChromiumLaunchOptions(directory),
    );
    browserVersion = context.browser()!.version();
    expect(browserVersion).toBe("159.0.8154.6");
    context.on("request", (request) => {
      if (/^(https?|wss?):/.test(request.url())) externalRequests += 1;
    });
    context.on("weberror", () => {
      pageErrors += 1;
    });
    const background =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(background.url()).host;
    const page = await context.newPage();
    page.on("websocket", () => {
      externalRequests += 1;
    });
    await page.goto(`chrome-extension://${id}/popup.html`);
    await context.setOffline(true);
    expect(
      await page.evaluate(() => chrome.runtime.sendMessage({ type: "start" })),
    ).toEqual({ ok: true });
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(() =>
              chrome.runtime.sendMessage({ type: "state" }),
            )
          ).phase,
      )
      .toBe("baseline");
    cdp = await context.browser()!.newBrowserCDPSession();
    const observe = () => findCalibrationWorker(cdp!, id);
    await expect.poll(observe).toBeTruthy();
    child = await WorkerHeapSession.attach(cdp, (await observe())!);
    for (const phase of ["baseline", "wasm", "array-buffer", "js"]) {
      stage = phase;
      if (phase !== "baseline") {
        await page.evaluate(
          (value) =>
            chrome.runtime.sendMessage({ type: "allocate", phase: value }),
          phase,
        );
        await expect
          .poll(
            async () =>
              (
                await page.evaluate(() =>
                  chrome.runtime.sendMessage({ type: "state" }),
                )
              ).phase,
          )
          .toBe(phase);
      }
      samples.push({
        phase,
        elapsedMs: performance.now() - startedAt,
        metadata: await child.read(),
      });
    }
    expect(new Set(samples.map((value) => value.metadata.isolateId)).size).toBe(
      1,
    );
    expect(samples.map((value) => value.metadata.wasm.totalBytes)).toEqual([
      0,
      16 * 1024 * 1024,
      16 * 1024 * 1024,
      16 * 1024 * 1024,
    ]);
    expect(
      samples[2]!.metadata.heap.backingStorageSize -
        samples[1]!.metadata.heap.backingStorageSize,
    ).toBeGreaterThanOrEqual(8 * 1024 * 1024);
    expect(
      samples[3]!.metadata.heap.usedSize - samples[2]!.metadata.heap.usedSize,
    ).toBeGreaterThanOrEqual(3 * 1024 * 1024);
    expect(externalRequests).toBe(0);
    expect(pageErrors).toBe(0);
    for (const [name, digest] of Object.entries(fixtureAssets))
      expect(sha(await readFile(path.join(directory, name)))).toBe(digest);
    status = "completed";
  } catch (error) {
    failure = error;
  } finally {
    const measured = async (resource: string, action: () => Promise<void>) => {
      const entry = {
        resource,
        status: "pending",
        elapsedMs: null as number | null,
      };
      cleanupPhases.push(entry);
      const start = performance.now();
      try {
        await action();
        entry.status = "completed";
      } catch (error) {
        entry.status = "failed";
        throw error;
      } finally {
        entry.elapsedMs = performance.now() - start;
      }
    };
    const ownedChild = child,
      ownedCdp = cdp,
      ownedContext = context;
    const cleanupErrors: unknown[] = [];
    try {
      await cleanupFixtureResources(
        undefined,
        async () => undefined,
        5000,
        ownedChild
          ? {
              detach: () =>
                measured("worker-session", () => ownedChild.close()),
            }
          : undefined,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await cleanupFixtureResources(
        ownedContext
          ? {
              close: () =>
                measured("browser-context", () => ownedContext.close()),
            }
          : undefined,
        async () => undefined,
        5000,
        ownedCdp
          ? {
              detach: () =>
                measured("root-cdp-session", () => ownedCdp.detach()),
            }
          : undefined,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (
      cleanupPhases.some(
        (value) =>
          value.status !== "completed" ||
          value.elapsedMs === null ||
          value.elapsedMs >= 5000,
      )
    )
      cleanupErrors.push(new Error("heap-cleanup-deadline-failed"));
    if (cleanupErrors.length) {
      status = "failed";
      failure =
        failure === undefined
          ? new AggregateError(cleanupErrors, "heap-session-cleanup-failed")
          : new AggregateError(
              [failure, ...cleanupErrors],
              "heap-test-and-cleanup-failed",
            );
    }
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      output,
      JSON.stringify(
        {
          sourceCommit,
          sourceTree: git("rev-parse", "HEAD^{tree}"),
          sourceClean: git("status", "--porcelain") === "",
          status,
          stage,
          modelUsed: false,
          browserVersion,
          platform: process.platform,
          node: process.version,
          controls,
          fixtureAssets,
          samples,
          cleanupPhases,
          elapsedMs: performance.now() - startedAt,
          externalRequests,
          pageErrors,
          limitations: [
            "synthetic calibration only; no model capacity or leak acceptance",
            "owned debugger and Proxy/microtask overhead included",
            "heap/backing storage/linear memory are distinct counters, not additive resident memory",
            "post-listener traffic only",
          ],
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  }
  if (failure !== undefined) throw failure;
});
