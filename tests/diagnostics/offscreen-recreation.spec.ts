// Historical three-key notice diagnostic, closed at runtime72236f2.
// New instance-marker protocol requires the separately registered instance lane;
// do not reuse this file to claim current runtime acceptance.
import {
  chromium,
  expect,
  test,
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
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  boundedDiagnosticCommand,
  createModelHeapBudget,
} from "./model-heap-contract";
import {
  parseOffscreenIdleTrialEnvironment,
  isSuccessfulOffscreenIdleNotice,
  validateOffscreenIdlePreflight,
  compareOffscreenProcessCohorts,
} from "./offscreen-recreation-contract";
import { createResourceCdp } from "./resource-contract";
import { ParentWorkerSession } from "./parent-worker-session";
import {
  sampleLinuxBrowserMemory,
  sampleWindowsBrowserMemory,
} from "../../scripts/browser_process_memory.mjs";
import { createChromiumLaunchOptions } from "../e2e/browser-options";
import { cleanupFixtureResources } from "../e2e/fixture-resources";
import { watchTraffic } from "../e2e/traffic";

const sample = "明日の予定については、来週移行にご連絡します。";
const expectedModelSha256 =
  "dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab";
const trial = parseOffscreenIdleTrialEnvironment(process.env);

type Asset = { readonly bytes: number; readonly sha256: string };
type Notice = {
  readonly documentId: string;
  readonly releases: {
    readonly completed: number;
    readonly failed: number;
    readonly timedOut: number;
    readonly sendFailed: number;
  };
  readonly senderDocumentId: string | null;
};

let observedNotices: Notice[] = [];

const git = (...args: string[]) =>
  execFileSync(
    "git",
    ["-c", `safe.directory=${process.cwd().replaceAll("\\", "/")}`, ...args],
    { encoding: "utf8" },
  ).trim();

async function digest(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function assetInventory(
  directory: string,
): Promise<Record<string, Asset>> {
  const result: Record<string, Asset> = {};
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      if (entry.isSymbolicLink()) throw new Error("invalid-fixture-link");
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile())
        result[name] = {
          bytes: (await stat(path.join(directory, name))).size,
          sha256: await digest(path.join(directory, name)),
        };
      else throw new Error("invalid-fixture-entry");
    }
  };
  await visit("");
  return result;
}

async function status(
  popup: Page,
  tabId: number,
): Promise<{ modelReady: boolean; backend: string; detectionCount: number }> {
  return boundedDiagnosticCommand(
    popup.evaluate(
      (id) => chrome.runtime.sendMessage({ type: "get-status", tabId: id }),
      tabId,
    ),
  );
}

async function contexts(
  popup: Page,
): Promise<Array<{ documentId: string | undefined }>> {
  return boundedDiagnosticCommand(
    popup.evaluate(async () =>
      (
        await chrome.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
        })
      ).map((context) => ({ documentId: context.documentId })),
    ),
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
    scope: "cdp-associated-browser-processes",
    reason: "unsupported-platform",
    rows: [],
    missingPids: [],
  };
}

function createWorkerTargetObserver(cdp: CDPSession, extensionId: string) {
  const offscreenUrl = `chrome-extension://${extensionId}/offscreen.html`;
  const workerUrl = `chrome-extension://${extensionId}/worker.js`;
  const observations: unknown[] = [];
  return {
    observations,
    async observe(owned = false) {
      const targets = (
        await boundedDiagnosticCommand(
          cdp.send("Target.getTargets", { filter: [{}] }),
        )
      ).targetInfos as Array<{
        targetId: string;
        type: string;
        url: string;
      }>;
      const liveParents = new Set(
        targets
          .filter(
            (target) =>
              target.url === offscreenUrl &&
              ["background_page", "other", "page"].includes(target.type),
          )
          .map((target) => target.targetId),
      );
      if (owned) {
        expect(liveParents.size).toBe(1);
        const parent = await ParentWorkerSession.attach(cdp, extensionId);
        const observation: Record<string, unknown> = {
          status: "pending",
          cleanup: [],
        };
        observations.push(observation);
        const cleanup = observation.cleanup as Array<{
          resource: string;
          status: string;
          elapsedMs: number;
        }>;
        let workerId: string | undefined;
        let failure: unknown;
        try {
          const child = await parent.observeWorker();
          const before = parent.metadata();
          observation.before = before;
          expect(before.bindingValid).toBe(true);
          expect(before.activeChildren).toBe(1);
          expect(before.explicitParentId).toBe(before.parentTargetId);
          expect(liveParents.has(before.parentTargetId)).toBe(true);
          workerId = child.targetId;
        } catch (error) {
          failure = error;
        }
        for (const [resource, operation] of [
          ["worker-session", () => parent.detachChildren()],
          ["parent-session", () => parent.close()],
        ] as const) {
          const started = performance.now();
          try {
            await boundedDiagnosticCommand(operation());
            cleanup.push({
              resource,
              status: "completed",
              elapsedMs: performance.now() - started,
            });
            if (resource === "worker-session")
              observation.after = parent.metadata();
          } catch (error) {
            cleanup.push({
              resource,
              status: "failed",
              elapsedMs: performance.now() - started,
            });
            failure =
              failure === undefined
                ? error
                : new AggregateError(
                    [failure, error],
                    "owned-worker-cleanup-failed",
                  );
          }
        }
        if (failure !== undefined) {
          observation.status = "failed";
          throw failure;
        }
        const after = parent.metadata();
        expect(after.activeChildren).toBe(0);
        expect(after.childDetachObserved).toBe(true);
        observation.status = "completed";
        return {
          workerTargetIds: [workerId!],
          parentTargetIds: [...liveParents],
        };
      }
      return {
        workerTargetIds: targets
          .filter(
            (target) => target.type === "worker" && target.url === workerUrl,
          )
          .map((target) => target.targetId)
          .sort(),
        parentTargetIds: [...liveParents].sort(),
      };
    },
  };
}

async function installIdleNoticeListener(popup: Page): Promise<void> {
  await boundedDiagnosticCommand(
    popup.evaluate(() => {
      const windowWithNotices = window as Window & {
        __kotobaOffscreenIdleNotices?: Notice[];
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
        const senderDocumentId =
          typeof sender.documentId === "string" && sender.documentId.length > 0
            ? sender.documentId
            : null;
        if (!message || typeof message !== "object") return;
        const value = message as {
          type?: unknown;
          documentId?: unknown;
          releases?: unknown;
        };
        if (
          value.type !== "offscreen-idle" ||
          Object.keys(value).sort().join(",") !== "documentId,releases,type" ||
          typeof value.documentId !== "string" ||
          value.documentId.length === 0 ||
          value.documentId.length > 128 ||
          (senderDocumentId !== null &&
            senderDocumentId !== value.documentId) ||
          !value.releases ||
          typeof value.releases !== "object" ||
          Array.isArray(value.releases)
        )
          return;
        const releases = value.releases as Record<string, unknown>;
        if (
          Object.keys(releases).sort().join(",") !==
            "completed,failed,sendFailed,timedOut" ||
          !["completed", "failed", "timedOut", "sendFailed"].every(
            (key) =>
              Number.isSafeInteger(releases[key]) &&
              (releases[key] as number) >= 0,
          ) ||
          !Number.isSafeInteger(releases.completed) ||
          !Number.isSafeInteger(releases.failed) ||
          !Number.isSafeInteger(releases.timedOut) ||
          !Number.isSafeInteger(releases.sendFailed)
        )
          return;
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
    }),
  );
}

async function idleNotices(popup: Page): Promise<Notice[]> {
  const notices = await boundedDiagnosticCommand(
    popup.evaluate(() => {
      const notices = (
        window as Window & { __kotobaOffscreenIdleNotices?: Notice[] }
      ).__kotobaOffscreenIdleNotices;
      return notices ? [...notices] : [];
    }),
  );
  observedNotices = notices;
  return notices;
}

test("diagnostic: offscreen document closes and recreates after two idle cycles", async () => {
  test.setTimeout(240_000);
  observedNotices = [];
  expect(process.platform).toBe("win32");
  expect(git("rev-parse", "HEAD")).toBe(trial.sourceCommit);
  expect(git("status", "--porcelain")).toBe("");
  const preflightPath = path.join(
    path.dirname(trial.output),
    "build-control.json",
  );
  const preflight = await readFile(preflightPath);
  const expectedAssets = validateOffscreenIdlePreflight(
    JSON.parse(preflight.toString("utf8")),
    trial,
    createHash("sha256").update(preflight).digest("hex"),
    expectedModelSha256,
  );
  try {
    await stat(trial.output);
    throw new Error("offscreen-idle artifact already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const testSha256 = await digest(
    "tests/diagnostics/offscreen-recreation.spec.ts",
  );
  const fixture = await readFile("tests/fixtures/editors.html");
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(fixture);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let context: BrowserContext | undefined;
  let cdp: CDPSession | undefined;
  let report: Record<string, unknown> = {};
  let failure: unknown;
  let stage = "setup";
  const startedAt = performance.now();
  const budget = createModelHeapBudget(startedAt);
  let completedInferences = 0;
  const inferenceChecks: Array<{
    ordinal: number;
    tabIndex: number;
    start: number;
    end: number;
    textRetained: boolean;
    inputStored: boolean;
    backend: string;
  }> = [];
  const snapshots: Array<{
    phase: string;
    elapsedMs: number;
    memory: Awaited<ReturnType<typeof memorySnapshot>>;
    modelReady: boolean;
    contexts: number;
    workerTargetIds: string[];
    parentTargetIds: string[];
    inferenceOrdinal: number;
    documentId: string | null;
  }> = [];
  let traffic: ReturnType<typeof watchTraffic> | undefined;
  let pageErrors = 0;
  const cycles: Array<{
    idleObservedAfterMs: number;
    retiredDocumentId: string;
    replacementDocumentId: string;
    retiredWorkerTargetId: string;
    replacementWorkerTargetId: string;
    releases: Notice["releases"];
  }> = [];
  const baseReport = {
    sourceCommit: trial.sourceCommit,
    runtimeSourceCommit: trial.runtimeSourceCommit,
    preflightSha256: trial.preflightSha256,
    testSha256,
    expectedModelSha256,
    acceptance: "offscreen-document-recreation-diagnostic",
    idlePolicyMs: 60_000,
    bodyDeadlineMs: 190_000,
    inferenceBudget: 4,
    idleCycles: 2,
    productMemoryAcceptance: false,
  };
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await mkdir(".cache", { recursive: true });
    const extension = await mkdtemp(
      path.resolve(".cache/offscreen-idle-extension-"),
    );
    await cp("dist/extension", extension, { recursive: true });
    const beforeAssets = await assetInventory(extension);
    expect(beforeAssets).toEqual(expectedAssets);
    const manifestPath = path.join(extension, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.host_permissions = [`${origin}/*`];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const fixtureAssets = await assetInventory(extension);
    expect(fixtureAssets).toEqual({
      ...beforeAssets,
      "manifest.json": {
        bytes: Buffer.byteLength(JSON.stringify(manifest)),
        sha256: createHash("sha256")
          .update(JSON.stringify(manifest))
          .digest("hex"),
      },
    });
    Object.assign(baseReport, {
      fixtureOrigin: origin,
      baselineAssets: beforeAssets,
      variantAssets: fixtureAssets,
    });
    context = await chromium.launchPersistentContext(
      "",
      createChromiumLaunchOptions(extension),
    );
    test.info().annotations.push(
      {
        type: "browser-version",
        description: context.browser()?.version() ?? "unavailable",
      },
      {
        type: "browser-source",
        description:
          process.env.KOTOBA_GUARD_BROWSER_EXECUTABLE === undefined
            ? "playwright-channel"
            : "configured-executable",
      },
    );
    const browserVersion = context.browser()!.version();
    cdp = await context.browser()!.newBrowserCDPSession();
    const ownedCdp = cdp;
    const memoryCdp = createResourceCdp(async (method) => {
      if (method === "SystemInfo.getProcessInfo")
        return boundedDiagnosticCommand(ownedCdp.send(method));
      throw new Error("unexpected-offscreen-resource-cdp-command");
    });
    await boundedDiagnosticCommand(
      ownedCdp.send("Target.setDiscoverTargets", { discover: true }),
    );
    traffic = watchTraffic(context, origin);
    context.on("weberror", () => {
      pageErrors += 1;
    });
    const background =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(background.url()).host;
    const observer = createWorkerTargetObserver(ownedCdp, extensionId);
    const observeWorkers = () => observer.observe();
    Object.assign(baseReport, { workerObservations: observer.observations });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await installIdleNoticeListener(popup);
    expect(
      await boundedDiagnosticCommand(
        popup.evaluate(
          (value) =>
            chrome.runtime.sendMessage({
              type: "set-site-enabled",
              origin: value,
              enabled: true,
            }),
          origin,
        ),
      ),
    ).toEqual({ ok: true });
    const pages = [await context.newPage(), await context.newPage()];
    for (const page of pages) await page.goto(origin);
    const tabIds: number[] = await boundedDiagnosticCommand(
      popup.evaluate(
        async (value) =>
          (await chrome.tabs.query({}))
            .filter((tab) => tab.url === `${value}/`)
            .map((tab) => tab.id!),
        origin,
      ),
    );
    expect(tabIds).toHaveLength(2);
    await context.setOffline(true);

    const verifyInference = async (page: Page, tabIndex: number) => {
      budget.assertActive();
      const mark = page.locator(".kotoba-guard-mark");
      await expect
        .poll(
          async () => {
            const parts = await mark.allTextContents();
            return parts.length === 1 && parts[0] === "移行";
          },
          { timeout: budget.timeout(30_000) },
        )
        .toBe(true);
      await expect(mark.first()).toBeVisible({
        timeout: budget.timeout(30_000),
      });
      const span = await mark.first().evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element.parentElement!);
        range.setEndBefore(element);
        const start = range.toString().length;
        return { start, end: start + (element.textContent?.length ?? 0) };
      });
      expect(span).toEqual({ start: 13, end: 15 });
      expect((await page.locator("#text").inputValue()) === sample).toBe(true);
      const stored = JSON.stringify(
        await boundedDiagnosticCommand(
          popup.evaluate(() => chrome.storage.local.get(null)),
        ),
      );
      expect(stored.includes(sample)).toBe(false);
      const current = await status(popup, tabIds[tabIndex]!);
      expect(current).toMatchObject({ modelReady: true, backend: "wasm" });
      completedInferences += 1;
      inferenceChecks.push({
        ordinal: completedInferences,
        tabIndex,
        ...span,
        textRetained: true,
        inputStored: false,
        backend: current.backend,
      });
      budget.assertActive();
    };

    const capture = async (phase: string) => {
      budget.assertActive(20_000);
      const current = await status(popup, tabIds[0]!);
      const currentContexts = await contexts(popup);
      const workers = await observer.observe(current.modelReady);
      budget.assertActive(20_000);
      const memory = await memorySnapshot(memoryCdp);
      snapshots.push({
        phase,
        elapsedMs: performance.now() - startedAt,
        memory,
        modelReady: current.modelReady,
        contexts: currentContexts.length,
        workerTargetIds: workers.workerTargetIds,
        parentTargetIds: workers.parentTargetIds,
        inferenceOrdinal: completedInferences,
        documentId: currentContexts[0]?.documentId ?? null,
      });
      const expectedReady =
        phase === "shared-inference" || phase.startsWith("resume-");
      expect(current.modelReady).toBe(expectedReady);
      expect(currentContexts).toHaveLength(Number(expectedReady));
      expect(workers.workerTargetIds).toHaveLength(Number(expectedReady));
      expect(workers.parentTargetIds).toHaveLength(Number(expectedReady));
      expect(memory.status).toBe("measured");
      expect(memory.missingPids).toHaveLength(0);
      expect(memory.rows.length).toBeGreaterThan(0);
      expect(
        memory.rows.every(
          (row) =>
            Number.isSafeInteger(row.pid) &&
            row.pid > 0 &&
            typeof row.role === "string" &&
            row.role.length > 0 &&
            Number.isSafeInteger(row.currentBytes) &&
            row.currentBytes > 0,
        ),
      ).toBe(true);
      expect(new Set(memory.rows.map((row) => row.pid)).size).toBe(
        memory.rows.length,
      );
      budget.assertActive();
      return snapshots[snapshots.length - 1]!;
    };

    stage = "before-inference";
    expect(await status(popup, tabIds[0]!)).toMatchObject({
      modelReady: false,
    });
    expect(await contexts(popup)).toHaveLength(0);
    expect((await observeWorkers()).workerTargetIds).toHaveLength(0);
    expect((await observeWorkers()).parentTargetIds).toHaveLength(0);
    await capture(stage);

    stage = "shared-inference";
    for (const [tabIndex, page] of pages.entries()) {
      budget.assertActive();
      await page.locator("#text").fill(sample);
      await verifyInference(page, tabIndex);
    }
    expect(await status(popup, tabIds[0]!)).toMatchObject({
      modelReady: true,
      backend: "wasm",
    });
    const initialContexts = await contexts(popup);
    expect(initialContexts).toHaveLength(1);
    const initialDocumentId = initialContexts[0]?.documentId;
    expect(initialDocumentId).toMatch(/\S/);
    let activeWorkers = (await capture(stage)).workerTargetIds;
    expect(activeWorkers).toHaveLength(1);

    for (let cycle = 0; cycle < 2; cycle += 1) {
      stage = `idle-${cycle + 1}`;
      budget.assertActive(85_000);
      const idleStarted = performance.now();
      const retiredDocumentId = (await contexts(popup))[0]?.documentId;
      const retiredWorkerTargetId = activeWorkers[0];
      expect(retiredDocumentId).toMatch(/\S/);
      expect(retiredWorkerTargetId).toMatch(/\S/);
      await expect
        .poll(
          async () => {
            const current = await status(popup, tabIds[0]!);
            const currentContexts = await contexts(popup);
            const workers = await observeWorkers();
            const notices = await idleNotices(popup);
            const notice = notices[notices.length - 1];
            return {
              ready: current.modelReady,
              contexts: currentContexts.length,
              workers: workers.workerTargetIds.length,
              parents: workers.parentTargetIds.length,
              released: notice
                ? isSuccessfulOffscreenIdleNotice(notice, 1, retiredDocumentId!)
                : false,
            };
          },
          {
            timeout: budget.timeout(85_000),
            intervals: [500, 1000, 2000, 5000],
          },
        )
        .toEqual({
          ready: false,
          contexts: 0,
          workers: 0,
          parents: 0,
          released: true,
        });
      const idleObservedAfterMs = performance.now() - idleStarted;
      await capture(stage);
      stage = `resume-${cycle + 1}`;
      const page = pages[cycle]!;
      budget.assertActive();
      await page.locator("#text").fill("");
      budget.assertActive();
      await page.locator("#text").fill(sample);
      await verifyInference(page, cycle);
      await expect
        .poll(
          async () => {
            const current = await status(popup, tabIds[cycle]!);
            const currentContexts = await contexts(popup);
            return {
              ready: current.modelReady,
              contexts: currentContexts.length,
              documentId: currentContexts[0]?.documentId ?? null,
            };
          },
          { timeout: budget.timeout(30_000) },
        )
        .toMatchObject({ ready: true, contexts: 1 });
      const replacementContexts = await contexts(popup);
      const replacementDocumentId = replacementContexts[0]?.documentId;
      expect(replacementDocumentId).toMatch(/\S/);
      expect(replacementDocumentId).not.toBe(retiredDocumentId);
      activeWorkers = (await capture(stage)).workerTargetIds;
      expect(activeWorkers).toHaveLength(1);
      expect(activeWorkers[0]).not.toBe(retiredWorkerTargetId);
      const notices = await idleNotices(popup);
      const releaseNotice = notices[notices.length - 1];
      expect(releaseNotice).toBeDefined();
      cycles.push({
        idleObservedAfterMs,
        retiredDocumentId: retiredDocumentId!,
        replacementDocumentId: replacementDocumentId!,
        retiredWorkerTargetId: retiredWorkerTargetId!,
        replacementWorkerTargetId: activeWorkers[0]!,
        releases: releaseNotice!.releases,
      });
    }

    stage = "final-validation";
    for (const page of pages)
      expect((await page.locator("#text").inputValue()) === sample).toBe(true);
    const stored = JSON.stringify(
      await boundedDiagnosticCommand(
        popup.evaluate(() => chrome.storage.local.get(null)),
      ),
    );
    expect(stored.includes(sample)).toBe(false);
    expect(traffic?.unexpected ?? []).toHaveLength(0);
    expect(pageErrors).toBe(0);
    expect(await assetInventory(extension)).toEqual(fixtureAssets);
    expect(completedInferences).toBe(4);
    expect(await idleNotices(popup)).toHaveLength(2);
    expect(snapshots).toHaveLength(6);
    expect(snapshots.map((snapshot) => snapshot.phase)).toEqual([
      "before-inference",
      "shared-inference",
      "idle-1",
      "resume-1",
      "idle-2",
      "resume-2",
    ]);
    const processCohort = compareOffscreenProcessCohorts(snapshots);
    expect(
      snapshots.every(
        (snapshot) =>
          snapshot.memory.status === "measured" &&
          snapshot.memory.missingPids.length === 0 &&
          snapshot.memory.rows.length > 0,
      ),
    ).toBe(true);
    report = {
      ...baseReport,
      status: "completed",
      browserVersion,
      platform: process.platform,
      node: process.version,
      elapsedMs: performance.now() - startedAt,
      completedInferences,
      inferenceChecks,
      cycles,
      snapshots,
      observedNotices: await idleNotices(popup),
      processCohort,
      processCdpCommands: memoryCdp.commands,
      noticeCount: (await idleNotices(popup)).length,
      assetCount: Object.keys(beforeAssets).length,
      modelSha256: beforeAssets["models/onnx/model_quantized.onnx"]?.sha256,
      unexpectedRequests: traffic?.unexpected.length ?? null,
      pageErrors: traffic === undefined ? null : pageErrors,
      limitations: [
        "CDP-associated process cohort; no extension-only RSS attribution",
        "post-listener traffic only",
        "two idle cycles; no long-term leak proof",
        "parent non-flat owned worker observation and detach overhead included; no heap hook",
        "a matching PID/role cohort is required for process ratio; churn yields null",
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
      completedInferences,
      inferenceChecks,
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
    try {
      await cleanupFixtureResources(
        context === undefined
          ? undefined
          : {
              close: () =>
                measuredCleanup("browser-context", () => context!.close()),
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
        cdp === undefined
          ? undefined
          : {
              detach: () => measuredCleanup("cdp-session", () => cdp!.detach()),
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
              "Offscreen recreation cleanup failed",
            );
    }
    report.cleanupPhases = cleanupPhases;
    report.sourceTree = git("rev-parse", "HEAD^{tree}");
    report.sourceClean = git("status", "--porcelain") === "";
    await mkdir(path.dirname(trial.output), { recursive: true });
    await writeFile(trial.output, JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
    });
  }
  if (failure !== undefined) throw failure;
});
