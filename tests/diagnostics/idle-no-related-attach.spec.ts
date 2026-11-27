import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "@playwright/test";
import { createServer } from "node:http";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  sampleWindowsBrowserMemory,
  sampleLinuxBrowserMemory,
} from "../../scripts/browser_process_memory.mjs";
import { createChromiumLaunchOptions } from "../e2e/browser-options";
import { cleanupFixtureResources } from "../e2e/fixture-resources";
import { watchTraffic } from "../e2e/traffic";
import {
  createResourceCdp,
  parseResourceTrialEnvironment,
  isSuccessfulRelease,
  validateResourcePreflight,
} from "./resource-contract";

const sample = "明日の予定については、来週移行にご連絡します。";
const expectedModelSha =
  "dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab";
const trial = parseResourceTrialEnvironment(process.env);
const { sourceCommit, runtimeSourceCommit, output, preflightSha256 } = trial;

async function digest(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function identity(root: string): Promise<Record<string, string>> {
  const entries = await Promise.all(
    [
      "distribution-manifest.json",
      "core.js",
      "background.js",
      "content.js",
      "offscreen.js",
      "worker.js",
      "models/onnx/model_quantized.onnx",
    ].map(async (name) => [name, await digest(path.join(root, name))] as const),
  );
  return Object.fromEntries(entries);
}

async function status(
  popup: Page,
  tabId: number,
): Promise<{ modelReady: boolean; backend: string; detectionCount: number }> {
  return popup.evaluate(
    (id) => chrome.runtime.sendMessage({ type: "get-status", tabId: id }),
    tabId,
  );
}

async function memorySnapshot(cdp: ReturnType<typeof createResourceCdp>) {
  const options = {
    getProcessInfo: () =>
      cdp.send("SystemInfo.getProcessInfo") as Promise<{
        processInfo: unknown;
      }>,
  };
  if (process.platform === "win32") return sampleWindowsBrowserMemory(options);
  if (process.platform === "linux") return sampleLinuxBrowserMemory(options);
  return {
    status: "unavailable",
    reason: "unsupported-platform",
    rows: [],
    missingPids: [],
  };
}

test("diagnostic: idle resources without owned related-target attachment", async () => {
  test.setTimeout(240_000);
  expect(process.platform).toBe("win32");
  const preflight = await readFile(
    path.join(path.dirname(output), "build-control.json"),
  );
  validateResourcePreflight(
    JSON.parse(preflight.toString("utf8")),
    trial,
    createHash("sha256").update(preflight).digest("hex"),
  );
  try {
    await stat(output);
    throw new Error("idle artifact already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const testSha256 = await digest(
    "tests/diagnostics/idle-no-related-attach.spec.ts",
  );
  const fixture = await readFile("tests/fixtures/editors.html");
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(fixture);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let context: BrowserContext | undefined;
  let cdp: CDPSession | undefined;
  let report: Record<string, unknown> = {};
  let failure: unknown;
  let stage = "setup";
  const startedAt = performance.now();
  const snapshots: Array<{
    phase: string;
    elapsedMs: number;
    sampleDurationMs: number;
    modelReady: boolean;
    workerTargets: "unobserved";
    memory: Awaited<ReturnType<typeof memorySnapshot>>;
  }> = [];
  const cycles: Array<{
    idleObservedAfterMs: number;
    releases: {
      completed: number;
      failed: number;
      timedOut: number;
      sendFailed: number;
    };
  }> = [];
  const baseReport = {
    sourceCommit,
    runtimeSourceCommit,
    preflightSha256,
    acceptance: "requires-source-bound-final-control",
    scope: "resource-diagnostic-only",
    workerTargets: "unobserved",
    productWorkerAcceptance: false,
    testSha256,
    expectedModelSha256: expectedModelSha,
    fixturePermission: "isolated-pregrant",
    backend: "wasm",
    wasmThreads: 1,
    idlePolicyMs: 60_000,
    idleObservedAfterMsIsPostSnapshot: true,
  };
  try {
    await mkdir(".cache", { recursive: true });
    const extension = await mkdtemp(path.resolve(".cache/idle-extension-"));
    await cp("dist/extension", extension, { recursive: true });
    const beforeIdentity = await identity(extension);
    expect(beforeIdentity["models/onnx/model_quantized.onnx"]).toBe(
      expectedModelSha,
    );
    const manifestPath = path.join(extension, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.host_permissions = [`${origin}/*`];
    await writeFile(manifestPath, JSON.stringify(manifest));
    context = await chromium.launchPersistentContext(
      "",
      createChromiumLaunchOptions(extension),
    );
    const browserVersion = context.browser()!.version();
    expect(browserVersion).toBe("159.0.8154.6");
    cdp = await context.browser()!.newBrowserCDPSession();
    const ownedCdp = cdp;
    const memoryCdp = createResourceCdp(async (method) => {
      if (method === "SystemInfo.getProcessInfo")
        return ownedCdp.send("SystemInfo.getProcessInfo");
      return ownedCdp.send("Target.setDiscoverTargets", { discover: true });
    });
    await memoryCdp.send("Target.setDiscoverTargets", { discover: true });
    const traffic = watchTraffic(context, origin);
    let pageErrors = 0;
    context.on("weberror", () => {
      pageErrors += 1;
    });
    const background =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(background.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    expect(
      await popup.evaluate(
        (value) =>
          chrome.runtime.sendMessage({
            type: "set-site-enabled",
            origin: value,
            enabled: true,
          }),
        origin,
      ),
    ).toEqual({ ok: true });
    const pages = [await context.newPage(), await context.newPage()];
    for (const page of pages) await page.goto(origin);
    const tabIds: number[] = await popup.evaluate(
      async (value) =>
        (await chrome.tabs.query({}))
          .filter((tab) => tab.url === `${value}/`)
          .map((tab) => tab.id!),
      origin,
    );
    expect(tabIds).toHaveLength(2);
    await context.setOffline(true);
    const capture = async (phase: string) => {
      const sampleStartedAt = performance.now();
      const current = await status(popup, tabIds[0]!);
      const memory = await memorySnapshot(memoryCdp);
      snapshots.push({
        phase,
        elapsedMs: sampleStartedAt - startedAt,
        sampleDurationMs: performance.now() - sampleStartedAt,
        modelReady: current.modelReady,
        workerTargets: "unobserved",
        memory,
      });
    };
    stage = "before-inference";
    expect(await status(popup, tabIds[0]!)).toMatchObject({
      modelReady: false,
    });
    await capture(stage);
    stage = "shared-inference";
    for (const page of pages) {
      await page.locator("#text").fill(sample);
      await expect(page.locator(".kotoba-guard-mark")).toContainText(["移行"]);
    }
    for (const tabId of tabIds)
      expect(await status(popup, tabId)).toMatchObject({
        modelReady: true,
        backend: "wasm",
      });
    await capture(stage);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      stage = `idle-${cycle + 1}`;
      const idleStarted = performance.now();
      await expect
        .poll(
          async () => {
            // Repeated status inspection must not keep the model alive.
            const current = await status(popup, tabIds[0]!);
            const release = await popup.evaluate(() =>
              chrome.runtime.sendMessage({ type: "offscreen-status" }),
            );
            return {
              ready: current.modelReady,
              released: isSuccessfulRelease(release, cycle + 1),
            };
          },
          { timeout: 85_000, intervals: [500, 1000, 2000, 5000] },
        )
        .toEqual({ ready: false, released: true });
      const idleObservedAfterMs = performance.now() - idleStarted;
      const releaseStatus = await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: "offscreen-status" }),
      );
      expect(releaseStatus).toMatchObject({
        ready: false,
        releases: {
          completed: cycle + 1,
          failed: 0,
          timedOut: 0,
          sendFailed: 0,
        },
      });
      expect(
        await popup.evaluate(
          async () =>
            (
              await chrome.runtime.getContexts({
                contextTypes: [
                  "OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType,
                ],
              })
            ).length,
        ),
      ).toBe(1);
      await capture(stage);
      stage = `resume-${cycle + 1}`;
      const page = pages[cycle]!;
      await page.locator("#text").fill("");
      await page.locator("#text").fill(sample);
      await expect
        .poll(() => status(popup, tabIds[cycle]!))
        .toMatchObject({ modelReady: true, backend: "wasm" });
      await expect(page.locator(".kotoba-guard-mark")).toContainText(["移行"]);
      cycles.push({
        idleObservedAfterMs,
        releases: releaseStatus.releases,
      });
      await capture(stage);
    }
    stage = "final-validation";
    for (const page of pages)
      await expect(page.locator("#text")).toHaveValue(sample);
    const stored = JSON.stringify(
      await popup.evaluate(() => chrome.storage.local.get(null)),
    );
    expect(stored).not.toContain(sample);
    expect(traffic.unexpected).toHaveLength(0);
    expect(pageErrors).toBe(0);
    expect(await identity(extension)).toEqual(beforeIdentity);
    expect(
      snapshots.every(
        (value) =>
          value.memory.status === "measured" && value.memory.rows.length > 0,
      ),
    ).toBe(true);
    report = {
      ...baseReport,
      status: "completed",
      modelSha256: beforeIdentity["models/onnx/model_quantized.onnx"],
      browserVersion,
      platform: process.platform,
      node: process.version,
      elapsedMs: performance.now() - startedAt,
      completedInferences: 4,
      cycles,
      snapshots,
      assets: beforeIdentity,
      ownedCdpCommands: [...memoryCdp.commands],
      unexpectedRequests: traffic.unexpected.length,
      pageErrors,
      limitations: [
        "CDP-associated process cohort; no extension-only RSS attribution",
        "post-listener traffic only",
        "bounded two-cycle test; no long-term leak proof",
        "worker termination does not guarantee immediate OS working-set reclamation",
        "Playwright still uses CDP; the additional owned related-target monitor is omitted; worker counts and IDs are unobserved",
        "fixture pregrant; no native permissions or physical IME",
      ],
    };
  } catch (error) {
    failure = error;
    report = {
      ...baseReport,
      status: "failed",
      stage,
      failure: "assertion-or-setup-failed",
      elapsedMs: performance.now() - startedAt,
      cycles,
      snapshots,
    };
  } finally {
    const cleanupPhases: Array<{
      resource: string;
      status: "pending" | "completed" | "failed";
      elapsedMs: number | null;
    }> = [];
    const measuredCleanup = async (
      resource: string,
      action: () => Promise<void>,
    ) => {
      const entry: (typeof cleanupPhases)[number] = {
        resource,
        status: "pending",
        elapsedMs: null,
      };
      cleanupPhases.push(entry);
      const cleanupStarted = performance.now();
      try {
        await action();
        entry.status = "completed";
      } catch (error) {
        entry.status = "failed";
        throw error;
      } finally {
        entry.elapsedMs = performance.now() - cleanupStarted;
      }
    };
    const ownedContext = context;
    const ownedCdp = cdp;
    try {
      await cleanupFixtureResources(
        ownedContext === undefined
          ? undefined
          : {
              close: () =>
                measuredCleanup("browser-context", () => ownedContext.close()),
            },
        () =>
          measuredCleanup(
            "fixture-server",
            () =>
              new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
              ),
          ),
        5_000,
        ownedCdp === undefined
          ? undefined
          : {
              detach: () =>
                measuredCleanup("cdp-session", () => ownedCdp.detach()),
            },
      );
      report.cleanup = "completed";
    } catch (error) {
      report = { ...report, status: "failed", cleanup: "failed" };
      failure =
        failure === undefined
          ? error
          : new AggregateError(
              [failure, error],
              "Idle test and cleanup failed",
            );
    }
    report.cleanupPhases = cleanupPhases;
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
    });
  }
  if (failure !== undefined) throw failure;
});
