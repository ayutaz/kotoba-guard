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
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  sampleWindowsBrowserMemory,
  sampleLinuxBrowserMemory,
} from "../../scripts/browser_process_memory.mjs";
import { createChromiumLaunchOptions } from "./browser-options";
import { cleanupFixtureResources } from "./fixture-resources";
import { watchTraffic } from "./traffic";
import { ScopedWorkerObserver } from "./scoped-worker-observer";
import { readSourceIdentity } from "./source-identity";

const sample = "明日の予定については、来週移行にご連絡します。";
const expectedModelSha =
  "dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab";
const sourceIdentity = readSourceIdentity();

type IdleNotice = {
  readonly documentId: string;
  readonly releases: {
    readonly completed: number;
    readonly failed: number;
    readonly timedOut: number;
    readonly sendFailed: number;
  };
  readonly senderDocumentId: string | null;
};

type ScopedWorkerObservation = {
  readonly phase: string;
  readonly status: string;
  readonly parentBound: boolean;
  readonly workers: number;
  readonly pendingCommands: number;
  readonly ownedParentSessions: number;
  readonly disposed: boolean;
};

type WorkerState = {
  readonly status: "complete" | "unavailable";
  readonly workers: number | null;
  readonly parentBound: boolean;
};

function scopedWorkerObservationReport(
  observations: readonly ScopedWorkerObservation[],
  latest: ScopedWorkerObservation | null,
): readonly ScopedWorkerObservation[] | ScopedWorkerObservation | null {
  return observations.length >= 6 ? observations.slice(0, 6) : latest;
}

let observedNotices: IdleNotice[] = [];

async function installIdleNoticeListener(popup: Page): Promise<void> {
  await popup.evaluate(() => {
    const windowWithNotices = window as Window & {
      __kotobaOffscreenIdleNotices?: IdleNotice[];
    };
    windowWithNotices.__kotobaOffscreenIdleNotices = [];
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (
        sender.id !== chrome.runtime.id ||
        sender.tab !== undefined ||
        sender.url !== chrome.runtime.getURL("offscreen.html") ||
        (sender.documentId != null &&
          (typeof sender.documentId !== "string" ||
            sender.documentId.length === 0))
      )
        return;
      if (!message || typeof message !== "object") return;
      const value = message as {
        type?: unknown;
        documentId?: unknown;
        instanceId?: unknown;
        releases?: unknown;
      };
      if (
        value.type !== "offscreen-idle" ||
        Object.keys(value).sort().join(",") !==
          "documentId,instanceId,releases,type" ||
        typeof value.instanceId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          value.instanceId,
        ) ||
        typeof value.documentId !== "string" ||
        value.documentId.length === 0 ||
        value.documentId.length > 128 ||
        (typeof sender.documentId === "string" &&
          sender.documentId.length > 0 &&
          sender.documentId !== value.documentId) ||
        !value.releases
      )
        return;
      const releases = value.releases as Record<string, unknown>;
      if (
        Object.keys(releases).sort().join(",") !==
          "completed,failed,sendFailed,timedOut" ||
        !Number.isSafeInteger(releases.completed) ||
        !Number.isSafeInteger(releases.failed) ||
        !Number.isSafeInteger(releases.timedOut) ||
        !Number.isSafeInteger(releases.sendFailed) ||
        (releases.completed as number) < 0 ||
        (releases.failed as number) < 0 ||
        (releases.timedOut as number) < 0 ||
        (releases.sendFailed as number) < 0
      )
        return;
      const senderDocumentId =
        typeof sender.documentId === "string" && sender.documentId.length > 0
          ? sender.documentId
          : null;
      windowWithNotices.__kotobaOffscreenIdleNotices?.push({
        documentId: value.documentId,
        releases: {
          completed: releases.completed as number,
          failed: releases.failed as number,
          timedOut: releases.timedOut as number,
          sendFailed: releases.sendFailed as number,
        },
        senderDocumentId,
      });
    });
  });
}

async function idleNotices(popup: Page): Promise<IdleNotice[]> {
  const notices = await popup.evaluate(() => {
    const notices = (
      window as Window & { __kotobaOffscreenIdleNotices?: IdleNotice[] }
    ).__kotobaOffscreenIdleNotices;
    return notices ? [...notices] : [];
  });
  observedNotices = notices;
  return notices;
}

function isPerDocumentRelease(
  notice: IdleNotice | undefined,
  documentId: string,
): notice is IdleNotice {
  return (
    notice?.documentId === documentId &&
    (notice.senderDocumentId === null ||
      notice.senderDocumentId === notice.documentId) &&
    notice.releases.completed === 1 &&
    notice.releases.failed === 0 &&
    notice.releases.timedOut === 0 &&
    notice.releases.sendFailed === 0
  );
}

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

async function memorySnapshot(cdp: CDPSession) {
  const options = {
    getProcessInfo: () => cdp.send("SystemInfo.getProcessInfo"),
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

test("real: one shared model worker idles and reinitializes twice offline", async () => {
  test.setTimeout(240_000);
  observedNotices = [];
  const output =
    process.env.KOTOBA_IDLE_OUTPUT ??
    path.resolve("artifacts/idle-real", randomUUID(), "report.json");
  try {
    await stat(output);
    throw new Error("idle artifact already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const testSha256 = await digest("tests/e2e/idle.real.spec.ts");
  const fixture = await readFile("tests/fixtures/editors.html");
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(fixture);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let context: BrowserContext | undefined;
  let cdp: CDPSession | undefined;
  let observer: ScopedWorkerObserver | undefined;
  let traffic: ReturnType<typeof watchTraffic> | undefined;
  let pageErrors = 0;
  let browserVersion: string | null = null;
  let completedInferences = 0;
  let storageContainsInput: boolean | null = null;
  const workerObservations: ScopedWorkerObservation[] = [];
  let latestWorkerObservation: ScopedWorkerObservation | null = null;
  let report: Record<string, unknown> = {};
  let failure: unknown;
  let stage = "setup";
  const startedAt = performance.now();
  const snapshots: Array<{
    phase: string;
    elapsedMs: number;
    sampleDurationMs: number;
    modelReady: boolean;
    offscreenDocumentId: string | null;
    workerTargetIds: string[];
    memory: Awaited<ReturnType<typeof memorySnapshot>>;
  }> = [];
  const cycles: Array<{
    idleObservedAfterMs: number;
    retiredDocumentId: string;
    replacementDocumentId: string;
    retiredWorker: string;
    replacementWorker: string;
    releases: {
      completed: number;
      failed: number;
      timedOut: number;
      sendFailed: number;
    };
  }> = [];
  const baseReport = {
    ...sourceIdentity,
    testSha256,
    expectedModelSha256: expectedModelSha,
    fixturePermission: "isolated-pregrant",
    backend: "wasm",
    wasmThreads: 1,
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
    browserVersion = context.browser()!.version();
    cdp = await context.browser()!.newBrowserCDPSession();
    const memoryCdp = cdp;
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    traffic = watchTraffic(context, origin);
    context.on("weberror", () => {
      pageErrors += 1;
    });
    const background =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(background.url()).host;
    observer = new ScopedWorkerObserver(cdp, extensionId);
    const observeWorkers = () => observer!.observe();
    const readWorkerObservation = (
      phase: string,
      append: boolean,
    ): ScopedWorkerObservation => {
      const metadata = observer!.metadata();
      const value: ScopedWorkerObservation = { phase, ...metadata };
      latestWorkerObservation = value;
      if (append) workerObservations.push(value);
      return value;
    };
    const pollWorkerState = async (phase: string): Promise<WorkerState> => {
      try {
        const workers = await observeWorkers();
        const metadata = readWorkerObservation(phase, false);
        if (
          metadata.status !== "complete" ||
          metadata.workers !== workers.length
        )
          return { status: "unavailable", workers: null, parentBound: false };
        return {
          status: "complete",
          workers: workers.length,
          parentBound: metadata.parentBound,
        };
      } catch {
        readWorkerObservation(phase, false);
        return { status: "unavailable", workers: null, parentBound: false };
      }
    };
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await installIdleNoticeListener(popup);
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
    const capture = async (
      phase: string,
      expectedWorkers: number,
      appendObservation: boolean,
    ) => {
      const sampleStartedAt = performance.now();
      const targets = await observeWorkers();
      const metadata = readWorkerObservation(phase, appendObservation);
      expect(metadata).toMatchObject({
        status: "complete",
        parentBound: expectedWorkers > 0,
        workers: expectedWorkers,
      });
      expect(targets).toHaveLength(expectedWorkers);
      const current = await status(popup, tabIds[0]!);
      const currentContexts = await popup.evaluate(async () =>
        (
          await chrome.runtime.getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
          })
        ).map((context) => context.documentId),
      );
      const memory = await memorySnapshot(memoryCdp);
      snapshots.push({
        phase,
        elapsedMs: sampleStartedAt - startedAt,
        sampleDurationMs: performance.now() - sampleStartedAt,
        modelReady: current.modelReady,
        offscreenDocumentId: currentContexts[0] ?? null,
        workerTargetIds: targets,
        memory,
      });
    };
    stage = "before-inference";
    expect(await status(popup, tabIds[0]!)).toMatchObject({
      modelReady: false,
    });
    await capture(stage, 0, true);
    stage = "shared-inference";
    for (const page of pages) {
      await page.locator("#text").fill(sample);
      await expect(page.locator(".kotoba-guard-mark")).toContainText(["移行"]);
      completedInferences += 1;
    }
    for (const tabId of tabIds)
      expect(await status(popup, tabId)).toMatchObject({
        modelReady: true,
        backend: "wasm",
      });
    await expect
      .poll(() => pollWorkerState("shared-inference"))
      .toEqual({ status: "complete", workers: 1, parentBound: true });
    let active = await observeWorkers();
    expect(active).toHaveLength(1);
    readWorkerObservation("shared-inference", true);
    const initialContexts = await popup.evaluate(async () =>
      (
        await chrome.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
        })
      ).map((context) => context.documentId),
    );
    expect(initialContexts).toHaveLength(1);
    let activeDocumentId = initialContexts[0];
    expect(activeDocumentId).toMatch(/\S/);
    await capture(stage, 1, false);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      stage = `idle-${cycle + 1}`;
      const idleStarted = performance.now();
      const retiredWorker = active[0]!;
      const retiredDocumentId = activeDocumentId!;
      await expect
        .poll(
          async () => {
            // Repeated status inspection must not keep the model alive.
            const current = await status(popup, tabIds[0]!);
            const workerState = await pollWorkerState(stage);
            const currentContexts = await popup.evaluate(async () =>
              (
                await chrome.runtime.getContexts({
                  contextTypes: [
                    "OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType,
                  ],
                })
              ).map((context) => context.documentId),
            );
            const notices = await idleNotices(popup);
            return {
              ready: current.modelReady,
              workerState,
              contexts: currentContexts.length,
              released: isPerDocumentRelease(
                notices[notices.length - 1],
                retiredDocumentId,
              ),
            };
          },
          { timeout: 85_000, intervals: [500, 1000, 2000, 5000] },
        )
        .toEqual({
          ready: false,
          workerState: {
            status: "complete",
            workers: 0,
            parentBound: false,
          },
          contexts: 0,
          released: true,
        });
      const idleObservedAfterMs = performance.now() - idleStarted;
      const documentNotices = (await idleNotices(popup)).filter(
        (notice) => notice.documentId === retiredDocumentId,
      );
      expect(documentNotices).toHaveLength(1);
      const releaseNotice = documentNotices[0];
      expect(isPerDocumentRelease(releaseNotice, retiredDocumentId)).toBe(true);
      await capture(stage, 0, true);
      stage = `resume-${cycle + 1}`;
      const page = pages[cycle]!;
      await page.locator("#text").fill("");
      await page.locator("#text").fill(sample);
      await expect
        .poll(() => status(popup, tabIds[cycle]!))
        .toMatchObject({ modelReady: true, backend: "wasm" });
      await expect(page.locator(".kotoba-guard-mark")).toContainText(["移行"]);
      completedInferences += 1;
      await expect
        .poll(() => pollWorkerState(`resume-${cycle + 1}`))
        .toEqual({ status: "complete", workers: 1, parentBound: true });
      active = await observeWorkers();
      expect(active).toHaveLength(1);
      readWorkerObservation(`resume-${cycle + 1}`, true);
      expect(active[0]).not.toBe(retiredWorker);
      const replacementContexts = await popup.evaluate(async () =>
        (
          await chrome.runtime.getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
          })
        ).map((context) => context.documentId),
      );
      expect(replacementContexts).toHaveLength(1);
      const replacementDocumentId = replacementContexts[0];
      expect(replacementDocumentId).toMatch(/\S/);
      expect(replacementDocumentId).not.toBe(retiredDocumentId);
      activeDocumentId = replacementDocumentId!;
      cycles.push({
        idleObservedAfterMs,
        retiredDocumentId,
        replacementDocumentId: replacementDocumentId!,
        retiredWorker,
        replacementWorker: active[0]!,
        releases: releaseNotice!.releases,
      });
      await capture(stage, 1, false);
    }
    stage = "final-validation";
    for (const page of pages)
      await expect(page.locator("#text")).toHaveValue(sample);
    const stored = JSON.stringify(
      await popup.evaluate(() => chrome.storage.local.get(null)),
    );
    storageContainsInput = stored.includes(sample);
    expect(storageContainsInput).toBe(false);
    expect(traffic?.unexpected ?? []).toHaveLength(0);
    expect(pageErrors).toBe(0);
    const finalNotices = await idleNotices(popup);
    expect(finalNotices).toHaveLength(2);
    for (const cycle of cycles) {
      const notices = finalNotices.filter(
        (notice) => notice.documentId === cycle.retiredDocumentId,
      );
      expect(notices).toHaveLength(1);
      expect(isPerDocumentRelease(notices[0], cycle.retiredDocumentId)).toBe(
        true,
      );
    }
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
      completedInferences,
      storageContainsInput,
      workerObservationMethod: "parent-session",
      workerObservation: scopedWorkerObservationReport(
        workerObservations,
        latestWorkerObservation,
      ),
      cycles,
      snapshots,
      observedNotices,
      assets: beforeIdentity,
      unexpectedRequests: traffic?.unexpected.length ?? null,
      pageErrors: traffic === undefined ? null : pageErrors,
      limitations: [
        "CDP-associated process cohort; no extension-only RSS attribution",
        "post-listener traffic only",
        "bounded two-cycle test; no long-term leak proof",
        "worker termination does not guarantee immediate OS working-set reclamation",
        "CDP observes child Workers through a non-flat offscreen parent session without pausing; debugger overhead is included",
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
      browserVersion,
      completedInferences,
      storageContainsInput,
      workerObservationMethod: "parent-session",
      workerObservation: scopedWorkerObservationReport(
        workerObservations,
        latestWorkerObservation,
      ),
      elapsedMs: performance.now() - startedAt,
      cycles,
      snapshots,
      observedNotices,
      unexpectedRequests: traffic?.unexpected.length ?? null,
      pageErrors: traffic === undefined ? null : pageErrors,
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
        observer === undefined
          ? undefined
          : {
              dispose: () =>
                measuredCleanup("worker-observer", () => observer!.dispose()),
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
