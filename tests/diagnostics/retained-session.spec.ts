import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Worker,
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
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  sampleLinuxBrowserMemory,
  sampleWindowsBrowserMemory,
} from "../../scripts/browser_process_memory.mjs";
import { createChromiumLaunchOptions } from "../e2e/browser-options";
import { cleanupFixtureResources } from "../e2e/fixture-resources";
import { ScopedWorkerObserver } from "../e2e/scoped-worker-observer";
import { readSourceIdentity } from "../e2e/source-identity";
import { watchTraffic } from "../e2e/traffic";

const SAMPLE = "明日の予定については、来週移行にご連絡します。";
const EXPECTED_MODEL_SHA =
  "dd651e144640ab13f5e43197e3aa9f51689f623181b0e2b80dd057ca225c2fab";
const IDLE_MS = 60_000;
const RETENTION_MS = 60_000;
const RELEASES = {
  completed: 0,
  failed: 0,
  timedOut: 0,
  sendFailed: 0,
};
const PHASES = [
  "before-inference",
  "shared-inference",
  "idle-1",
  "resume-1",
  "idle-2",
  "resume-2",
] as const;

type ReleaseCounts = typeof RELEASES;
type Notice = {
  documentId: string;
  releases: ReleaseCounts;
  senderDocumentId: string | null;
};
type RuntimeStatus = {
  ready: boolean;
  retiring: boolean;
  releases: ReleaseCounts;
};
type Observation = {
  phase: string;
  status: string;
  parentBound: boolean;
  workers: number;
  pendingCommands: number;
  ownedParentSessions: number;
  disposed: boolean;
};

async function digest(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function inventory(
  directory: string,
): Promise<Record<string, { bytes: number; sha256: string }>> {
  const result: Record<string, { bytes: number; sha256: string }> = {};
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      if (entry.isSymbolicLink()) throw new Error("invalid-extension-link");
      const name = path.posix.join(relative, entry.name);
      const absolute = path.join(directory, name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile())
        result[name] = {
          bytes: (await stat(absolute)).size,
          sha256: await digest(absolute),
        };
      else throw new Error("invalid-extension-entry");
    }
  };
  await visit("");
  return result;
}

async function status(
  popup: Page,
  tabId: number,
): Promise<Record<string, unknown>> {
  return popup.evaluate(
    (id) => chrome.runtime.sendMessage({ type: "get-status", tabId: id }),
    tabId,
  ) as Promise<Record<string, unknown>>;
}

async function offscreenStatus(background: Worker): Promise<RuntimeStatus> {
  return background.evaluate(
    () =>
      new Promise<RuntimeStatus>((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "offscreen-status" }, (response) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else if (
            !response ||
            typeof response !== "object" ||
            typeof response.ready !== "boolean" ||
            typeof response.retiring !== "boolean" ||
            !response.releases ||
            typeof response.releases !== "object"
          ) {
            reject(new Error("invalid-offscreen-status"));
          } else resolve(response as RuntimeStatus);
        });
      }),
  );
}

async function contexts(popup: Page): Promise<string[]> {
  return popup.evaluate(async () =>
    (
      await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
      })
    )
      .map((row) => row.documentId)
      .filter((id): id is string => typeof id === "string"),
  );
}

async function memorySnapshot(cdp: CDPSession) {
  const options = {
    getProcessInfo: () => cdp.send("SystemInfo.getProcessInfo"),
  };
  if (process.platform === "win32") return sampleWindowsBrowserMemory(options);
  if (process.platform === "linux") return sampleLinuxBrowserMemory(options);
  return { status: "unavailable", rows: [], missingPids: [] };
}

test("diagnostic: control and retained Worker session lifecycle", async () => {
  const arm = process.env.KOTOBA_RETENTION_ARM;
  const extensionInput = process.env.KOTOBA_RETENTION_EXTENSION;
  const output = process.env.KOTOBA_RETENTION_OUTPUT;
  expect(arm === "control" || arm === "retained").toBe(true);
  expect(extensionInput && path.isAbsolute(extensionInput)).toBe(true);
  expect(output && path.isAbsolute(output)).toBe(true);
  test.setTimeout(arm === "retained" ? 360_000 : 240_000);

  try {
    await stat(output!);
    throw new Error("retention-artifact-already-exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const sourceIdentity = readSourceIdentity();
  expect(sourceIdentity.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(sourceIdentity.runtimeSourceCommit).toMatch(/^[0-9a-f]{40}$/);
  const testSha256 = await digest("tests/diagnostics/retained-session.spec.ts");
  const fixture = await readFile("tests/fixtures/editors.html");
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(fixture);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let context: BrowserContext | undefined;
  let background: Worker | undefined;
  let cdp: CDPSession | undefined;
  let observer: ScopedWorkerObserver | undefined;
  let traffic: ReturnType<typeof watchTraffic> | undefined;
  let failure: unknown;
  let stage = "setup";
  let pageErrors = 0;
  let browserVersion: string | null = null;
  let storageContainsInput: boolean | null = null;
  let completedInferences = 0;
  let extensionDirectory: string | undefined;
  let report: Record<string, unknown> = {
    ...sourceIdentity,
    status: "failed",
    arm,
    testSha256,
    expectedModelSha256: EXPECTED_MODEL_SHA,
    completedInferences,
    storageContainsInput,
    browserVersion,
    unexpectedRequests: null,
    pageErrors: null,
    snapshots: [],
    cycles: [],
    observedNotices: [],
  };
  const startedAt = performance.now();
  let lastInputIssuedAt: number | null = null;
  const snapshots: Array<Record<string, unknown>> = [];
  const observations: Observation[] = [];
  const cycles: Array<Record<string, unknown>> = [];
  let finalExpiry: Record<string, unknown> | null = null;
  let finalReleaseStatusObservedAt: number | null = null;
  let finalIdleNoticeObservedAt: number | null = null;
  let finalReleaseWorkerTargetId: string | null = null;
  let finalReleaseOffscreenDocumentId: string | null = null;
  const notices: Notice[] = [];
  let initialAssets: Record<string, { bytes: number; sha256: string }> = {};
  let cloneAssets: Record<string, { bytes: number; sha256: string }> = {};

  const cleanupPhases: Array<{
    resource: string;
    status: "pending" | "completed" | "failed";
    elapsedMs: number | null;
  }> = [];
  const measuredCleanup = async (
    resource: string,
    action: () => Promise<void>,
  ): Promise<void> => {
    const phase: {
      resource: string;
      status: "pending" | "completed" | "failed";
      elapsedMs: number | null;
    } = { resource, status: "pending", elapsedMs: null };
    cleanupPhases.push(phase);
    const started = performance.now();
    try {
      await action();
      phase.status = "completed";
    } catch (error) {
      phase.status = "failed";
      throw error;
    } finally {
      phase.elapsedMs = performance.now() - started;
    }
  };

  try {
    await mkdir(".cache", { recursive: true });
    extensionDirectory = await mkdtemp(
      path.resolve(".cache/retention-extension-"),
    );
    await cp(extensionInput!, extensionDirectory, { recursive: true });
    initialAssets = await inventory(extensionDirectory);
    const manifestPath = path.join(extensionDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    manifest.host_permissions = [`${origin}/*`];
    await writeFile(manifestPath, JSON.stringify(manifest));
    cloneAssets = await inventory(extensionDirectory);
    const model = cloneAssets["models/onnx/model_quantized.onnx"];
    expect(model?.sha256).toBe(EXPECTED_MODEL_SHA);
    expect(cloneAssets["manifest.json"]?.sha256).not.toBe(
      initialAssets["manifest.json"]?.sha256,
    );
    const clonedManifest = JSON.parse(
      await readFile(path.join(extensionDirectory, "manifest.json"), "utf8"),
    ) as { host_permissions?: unknown };
    expect(clonedManifest.host_permissions).toEqual([`${origin}/*`]);
    expect(Object.keys(cloneAssets).sort()).toEqual(
      Object.keys(initialAssets).sort(),
    );
    const changedFiles = Object.keys(initialAssets).filter(
      (name) =>
        initialAssets[name]?.sha256 !== cloneAssets[name]?.sha256 ||
        !(name in cloneAssets),
    );
    expect(changedFiles).toEqual(["manifest.json"]);

    context = await chromium.launchPersistentContext(
      "",
      createChromiumLaunchOptions(extensionDirectory),
    );
    browserVersion = context.browser()?.version() ?? null;
    cdp = await context.browser()!.newBrowserCDPSession();
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    traffic = watchTraffic(context, origin);
    context.on("weberror", () => {
      pageErrors += 1;
    });
    background =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 5_000 }));
    const extensionId = new URL(background.url()).host;
    observer = new ScopedWorkerObserver(cdp, extensionId);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.evaluate(() => {
      const value = window as Window & { __kotobaRetentionNotices?: Notice[] };
      value.__kotobaRetentionNotices = [];
      chrome.runtime.onMessage.addListener((message, sender) => {
        if (
          sender.id !== chrome.runtime.id ||
          sender.tab !== undefined ||
          sender.url !== chrome.runtime.getURL("offscreen.html") ||
          (sender.documentId != null &&
            (typeof sender.documentId !== "string" ||
              sender.documentId.length === 0)) ||
          !message ||
          typeof message !== "object"
        )
          return;
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
          (sender.documentId != null &&
            (typeof sender.documentId !== "string" ||
              sender.documentId.length === 0 ||
              sender.documentId !== value.documentId)) ||
          !value.releases ||
          typeof value.releases !== "object"
        )
          return;
        const releases = value.releases as Record<string, unknown>;
        const total =
          (releases.completed as number) +
          (releases.failed as number) +
          (releases.timedOut as number) +
          (releases.sendFailed as number);
        if (
          !Object.keys(releases)
            .sort()
            .join(",")
            .match(/^completed,failed,sendFailed,timedOut$/) ||
          !Object.values(releases).every(
            (entry) =>
              typeof entry === "number" &&
              Number.isSafeInteger(entry) &&
              entry >= 0,
          ) ||
          total <= 0
        )
          return;
        const noticeStore = window as Window & {
          __kotobaRetentionNotices?: Notice[];
        };
        noticeStore.__kotobaRetentionNotices?.push({
          documentId: value.documentId,
          releases: releases as ReleaseCounts,
          senderDocumentId:
            typeof sender.documentId === "string" ? sender.documentId : null,
        });
      });
    });
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

    const readNotices = async (): Promise<Notice[]> =>
      popup.evaluate(() => {
        const value = window as Window & {
          __kotobaRetentionNotices?: Notice[];
        };
        return value.__kotobaRetentionNotices
          ? [...value.__kotobaRetentionNotices]
          : [];
      });
    const observe = async (
      phase: string,
      expectedWorkers: number,
      record = true,
    ) => {
      await expect
        .poll(async () => {
          const workers = await observer!.observe();
          const metadata = { phase, ...observer!.metadata() };
          return {
            workers: workers.length,
            complete:
              metadata.status === "complete" &&
              metadata.workers === expectedWorkers,
          };
        })
        .toEqual({ workers: expectedWorkers, complete: true });
      const metadata = { phase, ...observer!.metadata() };
      expect(metadata).toMatchObject({
        status: "complete",
        parentBound: expectedWorkers > 0,
        workers: expectedWorkers,
        pendingCommands: 0,
        disposed: false,
      });
      if (record) observations.push(metadata);
      return await observer!.observe();
    };
    const capture = async (phase: (typeof PHASES)[number], workers: number) => {
      const sampleStartedAt = performance.now();
      const current = await status(popup, tabIds[0]!);
      const currentContexts = await contexts(popup);
      const observed = await observe(phase, workers);
      const memory = await memorySnapshot(cdp!);
      snapshots.push({
        phase,
        elapsedMs: sampleStartedAt - startedAt,
        sampleDurationMs: performance.now() - sampleStartedAt,
        modelReady: current.modelReady === true,
        offscreenDocumentId: currentContexts[0] ?? null,
        workerTargetIds: observed,
        memory,
      });
    };
    stage = "before-inference";
    expect((await status(popup, tabIds[0]!)).modelReady).toBe(false);
    await capture("before-inference", 0);
    stage = "shared-inference";
    for (const page of pages) {
      lastInputIssuedAt = performance.now();
      await page.locator("#text").fill(SAMPLE);
      await expect(page.locator(".kotoba-guard-mark")).toContainText(["移行"]);
      completedInferences += 1;
    }
    for (const tabId of tabIds)
      expect(await status(popup, tabId)).toMatchObject({
        modelReady: true,
        backend: "wasm",
      });
    await capture("shared-inference", 1);
    let activeWorkers = [...(snapshots[1]!.workerTargetIds as string[])];
    let activeDocument = snapshots[1]!.offscreenDocumentId as string;
    expect(activeWorkers).toHaveLength(1);
    expect(activeDocument).toMatch(/\S/);

    for (let cycle = 0; cycle < 2; cycle += 1) {
      const phase = `idle-${cycle + 1}` as "idle-1" | "idle-2";
      stage = phase;
      const idleStarted = performance.now();
      expect(lastInputIssuedAt).not.toBeNull();
      const idleStartedAfterLastInputMs = idleStarted - lastInputIssuedAt!;
      await expect
        .poll(
          async () => {
            const workerIds = await observer!.observe();
            const documentIds = await contexts(popup);
            const current =
              arm === "retained" && documentIds.length > 0
                ? await offscreenStatus(background!)
                : null;
            const publicStatus = await status(popup, tabIds[0]!);
            const currentNotices = await readNotices();
            const retained = arm === "retained";
            return {
              ready: current?.ready ?? publicStatus.modelReady === true,
              retiring: current?.retiring ?? null,
              releases: current?.releases ?? null,
              workers: workerIds.length,
              documents: documentIds.length,
              sameWorker: retained ? workerIds[0] === activeWorkers[0] : true,
              sameDocument: retained ? documentIds[0] === activeDocument : true,
              notices: currentNotices.length,
            };
          },
          { timeout: IDLE_MS + 25_000, intervals: [500, 1000, 2000, 5000] },
        )
        .toEqual(
          arm === "retained"
            ? {
                ready: false,
                retiring: false,
                releases: { ...RELEASES, completed: cycle + 1 },
                workers: 1,
                documents: 1,
                sameWorker: true,
                sameDocument: true,
                notices: 0,
              }
            : {
                ready: false,
                retiring: null,
                releases: null,
                workers: 0,
                documents: 0,
                sameWorker: true,
                sameDocument: true,
                notices: cycle + 1,
              },
        );
      const releaseObservedAfterMs = performance.now() - idleStarted;
      const releaseObservedAfterLastInputMs =
        idleStartedAfterLastInputMs + releaseObservedAfterMs;
      // This clock starts before issuing input, so it precedes the inference
      // completion that arms the configured sixty-second idle timer.
      expect(releaseObservedAfterLastInputMs).toBeGreaterThanOrEqual(IDLE_MS);
      const oldWorker = activeWorkers[0];
      const oldDocument = activeDocument;
      const currentNotices = await readNotices();
      notices.splice(0, notices.length, ...currentNotices);
      if (arm === "control") {
        expect(currentNotices).toHaveLength(cycle + 1);
        expect(currentNotices[cycle]?.documentId).toBe(oldDocument);
        expect(currentNotices[cycle]?.releases).toEqual({
          ...RELEASES,
          completed: 1,
        });
      }
      await capture(phase, arm === "retained" ? 1 : 0);
      stage = `resume-${cycle + 1}`;
      const page = pages[cycle]!;
      await page.locator("#text").fill("");
      lastInputIssuedAt = performance.now();
      await page.locator("#text").fill(SAMPLE);
      await expect(page.locator(".kotoba-guard-mark")).toContainText(["移行"]);
      completedInferences += 1;
      await expect
        .poll(() => status(popup, tabIds[cycle]!))
        .toMatchObject({ modelReady: true, backend: "wasm" });
      const resumed = await observe(`resume-${cycle + 1}`, 1, false);
      const resumedContexts = await contexts(popup);
      expect(resumedContexts).toHaveLength(1);
      const resumedDocument = resumedContexts[0]!;
      if (arm === "retained") {
        expect(resumed[0]).toBe(oldWorker);
        expect(resumedDocument).toBe(oldDocument);
      } else {
        expect(resumed[0]).not.toBe(oldWorker);
        expect(resumedDocument).not.toBe(oldDocument);
      }
      activeWorkers = resumed;
      activeDocument = resumedDocument;
      await capture(`resume-${cycle + 1}` as "resume-1" | "resume-2", 1);
      cycles.push({
        cycle: cycle + 1,
        releaseObservedAfterMs,
        idleStartedAfterLastInputMs,
        releaseObservedAfterLastInputMs,
        worker: activeWorkers[0],
        document: activeDocument,
        releases:
          arm === "control"
            ? (currentNotices[cycle]?.releases ?? null)
            : (await offscreenStatus(background!)).releases,
      });
    }

    if (arm === "retained") {
      stage = "retention-expiry";
      const retentionDeadline = performance.now() + RETENTION_MS + 85_000;
      const remainingRetentionBudget = (): number => {
        const remaining = retentionDeadline - performance.now();
        if (remaining <= 0)
          throw new Error("retention-expiry-deadline-exceeded");
        return remaining;
      };
      await expect
        .poll(
          async () => {
            const documentIds = await contexts(popup);
            const current =
              documentIds.length > 0
                ? await offscreenStatus(background!)
                : null;
            const workerIds = await observer!.observe();
            const metadata = { ...observer!.metadata() };
            const currentNotices = await readNotices();
            if (
              current !== null &&
              current.ready === false &&
              current.retiring === false &&
              current.releases.completed === 3 &&
              current.releases.failed === 0 &&
              current.releases.timedOut === 0 &&
              current.releases.sendFailed === 0 &&
              workerIds.length === 1 &&
              documentIds.length === 1 &&
              workerIds[0] === activeWorkers[0] &&
              documentIds[0] === activeDocument &&
              finalReleaseStatusObservedAt === null
            ) {
              finalReleaseStatusObservedAt = performance.now();
              finalReleaseWorkerTargetId = workerIds[0] ?? null;
              finalReleaseOffscreenDocumentId = documentIds[0] ?? null;
            }
            if (
              currentNotices.length === 1 &&
              finalIdleNoticeObservedAt === null
            )
              finalIdleNoticeObservedAt = performance.now();
            return {
              ready: current?.ready ?? false,
              workers: workerIds.length,
              documents: documentIds.length,
              notices: currentNotices.length,
              release: current?.releases ?? null,
              observerStatus: metadata.status,
              observerParentBound: metadata.parentBound,
              observerWorkers: metadata.workers,
              observerPendingCommands: metadata.pendingCommands,
              observerDisposed: metadata.disposed,
              sameWorker: workerIds[0] === activeWorkers[0],
              sameDocument: documentIds[0] === activeDocument,
            };
          },
          {
            timeout: remainingRetentionBudget(),
            intervals: [500, 1000, 2000, 5000],
          },
        )
        .toEqual({
          ready: false,
          workers: 1,
          documents: 1,
          notices: 0,
          release: { ...RELEASES, completed: 3 },
          observerStatus: "complete",
          observerParentBound: true,
          observerWorkers: 1,
          observerPendingCommands: 0,
          observerDisposed: false,
          sameWorker: true,
          sameDocument: true,
        });
      await expect
        .poll(
          async () => {
            const publicStatus = await status(popup, tabIds[0]!);
            const expiryDocuments = await contexts(popup);
            const expiryWorkers = await observer!.observe();
            const expiryMetadata = { ...observer!.metadata() };
            const currentNotices = await readNotices();
            if (
              currentNotices.length === 1 &&
              finalIdleNoticeObservedAt === null
            )
              finalIdleNoticeObservedAt = performance.now();
            return {
              ready: publicStatus.modelReady === true,
              workers: expiryWorkers.length,
              documents: expiryDocuments.length,
              notices: currentNotices.length,
              release: currentNotices[0]?.releases ?? null,
              observerStatus: expiryMetadata.status,
              observerParentBound: expiryMetadata.parentBound,
              observerWorkers: expiryMetadata.workers,
              observerPendingCommands: expiryMetadata.pendingCommands,
              observerDisposed: expiryMetadata.disposed,
            };
          },
          {
            timeout: remainingRetentionBudget(),
            intervals: [500, 1000, 2000, 5000],
          },
        )
        .toEqual({
          ready: false,
          workers: 0,
          documents: 0,
          notices: 1,
          release: { ...RELEASES, completed: 3 },
          observerStatus: "complete",
          observerParentBound: false,
          observerWorkers: 0,
          observerPendingCommands: 0,
          observerDisposed: false,
        });
      const expiryObservedAt = performance.now();
      const expiryDocuments = await contexts(popup);
      const expiryWorkers = await observer!.observe();
      const expiryMetadata = { ...observer!.metadata() };
      expect(finalReleaseStatusObservedAt).not.toBeNull();
      const releaseStatusToExpiryObservedMs =
        expiryObservedAt - finalReleaseStatusObservedAt!;
      expect(releaseStatusToExpiryObservedMs).toBeGreaterThan(0);
      expect(releaseStatusToExpiryObservedMs).toBeLessThanOrEqual(85_000);
      finalExpiry = {
        releaseStatusObserved: finalReleaseStatusObservedAt !== null,
        releaseStatusObservedAfterMs:
          finalReleaseStatusObservedAt === null
            ? null
            : finalReleaseStatusObservedAt - startedAt,
        idleNoticeObservedAfterMs:
          finalIdleNoticeObservedAt === null
            ? null
            : finalIdleNoticeObservedAt - startedAt,
        expiryObservedAfterMs: expiryObservedAt - startedAt,
        releaseStatusToExpiryObservedMs,
        releaseWorkerTargetId: finalReleaseWorkerTargetId,
        releaseOffscreenDocumentId: finalReleaseOffscreenDocumentId,
        documents: expiryDocuments.length,
        workers: expiryWorkers.length,
        observer: expiryMetadata,
        notices: (await readNotices()).length,
      };
      notices.splice(0, notices.length, ...(await readNotices()));
      expect(notices).toHaveLength(1);
      expect(notices[0]?.releases).toEqual({ ...RELEASES, completed: 3 });
    }
    expect(notices).toHaveLength(arm === "retained" ? 1 : 2);
    for (const page of pages)
      await expect(page.locator("#text")).toHaveValue(SAMPLE);
    const stored = JSON.stringify(
      await popup.evaluate(() => chrome.storage.local.get(null)),
    );
    storageContainsInput = stored.includes(SAMPLE);
    expect(storageContainsInput).toBe(false);
    expect(traffic?.unexpected ?? []).toHaveLength(0);
    expect(pageErrors).toBe(0);
    expect(completedInferences).toBe(4);
    expect(snapshots.map((row) => row.phase)).toEqual(PHASES);
    expect(observations.map((row) => row.phase)).toEqual([...PHASES]);
    const finalAssets = await inventory(extensionDirectory!);
    expect(finalAssets).toEqual(cloneAssets);
    cloneAssets = finalAssets;
    expect(cloneAssets["models/onnx/model_quantized.onnx"]?.sha256).toBe(
      EXPECTED_MODEL_SHA,
    );
    report = {
      ...sourceIdentity,
      status: "completed",
      arm,
      testSha256,
      expectedModelSha256: EXPECTED_MODEL_SHA,
      modelSha256: cloneAssets["models/onnx/model_quantized.onnx"]?.sha256,
      browserVersion,
      platform: process.platform,
      node: process.version,
      completedInferences,
      storageContainsInput,
      unexpectedRequests: traffic?.unexpected.length ?? null,
      pageErrors,
      backend: "wasm",
      wasmThreads: 1,
      fixturePermission: "isolated-pregrant",
      workerObservationMethod: "parent-session",
      workerObservation: observations.slice(0, 6),
      snapshots,
      cycles,
      observedNotices: notices,
      finalExpiry,
      assets: cloneAssets,
      clone: {
        baselineAssets: initialAssets,
        changedFiles: ["manifest.json"],
        originalManifestSha256: initialAssets["manifest.json"]?.sha256,
      },
      retentionMs: arm === "retained" ? RETENTION_MS : 0,
      limitations: [
        "CDP-associated process cohort; no extension-only RSS attribution",
        "post-listener traffic only",
        "fixture pregrant; no native permissions or physical IME",
        "single bounded two-cycle arm; no long-term leak proof",
      ],
      elapsedMs: performance.now() - startedAt,
    };
  } catch (error) {
    failure = error;
    report = {
      ...report,
      status: "failed",
      stage,
      browserVersion,
      completedInferences,
      storageContainsInput,
      unexpectedRequests: traffic?.unexpected.length ?? null,
      pageErrors,
      snapshots,
      cycles,
      observedNotices: notices,
      finalExpiry,
      assets: cloneAssets,
      failure: "assertion-or-setup-failed",
    };
  } finally {
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
        observer === undefined
          ? undefined
          : {
              dispose: () =>
                measuredCleanup("worker-observer", () => observer!.dispose()),
            },
      );
      report.cleanup = "completed";
    } catch (error) {
      failure ??= error;
      report = { ...report, status: "failed", cleanup: "failed" };
    }
    report.cleanupPhases = cleanupPhases;
    report.elapsedMs = performance.now() - startedAt;
    await mkdir(path.dirname(output!), { recursive: true });
    await writeFile(output!, JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
    });
  }
  if (failure !== undefined) throw failure;
});
