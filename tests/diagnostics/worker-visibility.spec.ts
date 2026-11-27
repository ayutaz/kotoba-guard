import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type CDPSession,
} from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  captureSourceIdentity,
  reserveAuditReport,
  verifyAuditIdentity,
} from "../../scripts/browser_audit_evidence.mjs";
import { cleanupFixtureResources } from "../e2e/fixture-resources";
import { createChromiumLaunchOptions } from "../e2e/browser-options";
import {
  classifyProbeTargets,
  readVisibilityEnvironment,
  visibilityFixtureFiles,
  visibilityDeadline,
  findProbeParents,
} from "./worker-visibility";

test("model-free Chrome116: observe one offscreen Worker generation", async () => {
  const environment = readVisibilityEnvironment();
  const output = await reserveAuditReport(environment.output);
  const controlFiles = [
    "tests/diagnostics/worker-visibility.spec.ts",
    "tests/diagnostics/worker-visibility.ts",
    "tests/e2e/browser-options.ts",
    "tests/e2e/fixture-resources.ts",
    "scripts/browser_audit_evidence.mjs",
    "playwright.visibility.config.ts",
    "package-lock.json",
  ];
  const sha = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
  let context: BrowserContext | undefined;
  let cdp: CDPSession | undefined;
  let failure: unknown;
  let stage = "source-preflight";
  const report: Record<string, unknown> = {
    status: "failed",
    modelInferenceCount: 0,
    modelFilesPresent: false,
    fixtureOnly: true,
    sourceCommit: environment.sourceCommit,
    browserVersion: null,
    workerPong: false,
    offscreenCreated: false,
    offscreenClosed: false,
    attachment: "not-attempted",
    postListenerExternalRequests: null,
    pageErrors: null,
  };
  const snapshots: Array<{
    phase: string;
    targets: ReturnType<typeof classifyProbeTargets>;
  }> = [];
  const events: Array<{
    event: string;
    targets: ReturnType<typeof classifyProbeTargets>;
  }> = [];
  let eventOverflow = false;
  const eventCounts = {
    created: 0,
    changed: 0,
    destroyed: 0,
    attached: 0,
    detached: 0,
  };
  const cleanupPhases: Array<{
    resource: string;
    status: string;
    elapsedMs: number;
  }> = [];
  const started = performance.now();
  try {
    const beforeSource = await captureSourceIdentity({
      expectedCommit: environment.sourceCommit,
      controlFiles,
    });
    report.sourceBefore = beforeSource;
    const files = visibilityFixtureFiles();
    const directory = await mkdtemp(path.resolve(".cache/visibility-fixture-"));
    const assets: Record<string, { bytes: number; sha256: string }> = {};
    for (const [name, value] of Object.entries(files)) {
      await writeFile(path.join(directory, name), value, { flag: "wx" });
      assets[name] = { bytes: Buffer.byteLength(value), sha256: sha(value) };
    }
    report.fixtureDirectory = path
      .relative(process.cwd(), directory)
      .replaceAll("\\", "/");
    report.fixtureAssets = assets;
    stage = "launch";
    context = await chromium.launchPersistentContext("", {
      ...createChromiumLaunchOptions(directory),
      timeout: 30_000,
    });
    report.browserVersion = context.browser()!.version();
    expect(report.browserVersion).toBe("116.0.5845.96");
    let externalRequests = 0;
    let pageErrors = 0;
    context.on("request", (request) => {
      if (/^(https?|wss?):/.test(request.url())) externalRequests += 1;
    });
    context.on("weberror", () => {
      pageErrors += 1;
    });
    const background =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 5_000 }));
    const id = new URL(background.url()).host;
    cdp = await visibilityDeadline(() =>
      context!.browser()!.newBrowserCDPSession(),
    );
    const session = cdp;
    const recordEvent = (
      event: string,
      target: Parameters<typeof classifyProbeTargets>[0][number],
    ) => {
      if (events.length >= 256) {
        eventOverflow = true;
        return;
      }
      events.push({ event, targets: classifyProbeTargets([target], id) });
    };
    cdp.on("Target.targetCreated", (e) => {
      eventCounts.created += 1;
      recordEvent("created", e.targetInfo);
    });
    cdp.on("Target.targetInfoChanged", (e) => {
      eventCounts.changed += 1;
      recordEvent("changed", e.targetInfo);
    });
    cdp.on("Target.targetDestroyed", () => {
      eventCounts.destroyed += 1;
    });
    cdp.on("Target.attachedToTarget", (e) => {
      eventCounts.attached += 1;
      recordEvent("attached", e.targetInfo);
    });
    cdp.on("Target.detachedFromTarget", () => {
      eventCounts.detached += 1;
    });
    // Match the discovery options used by the failed real trial.
    await visibilityDeadline(() =>
      session.send("Target.setDiscoverTargets", { discover: true }),
    );
    const snapshot = async (phase: string) => {
      const { targetInfos } = await visibilityDeadline(() =>
        session.send("Target.getTargets", {
          filter: [{}],
        }),
      );
      snapshots.push({ phase, targets: classifyProbeTargets(targetInfos, id) });
      return targetInfos;
    };
    await snapshot("initial");
    const page = await visibilityDeadline(() => context!.newPage());
    page.setDefaultTimeout(5_000);
    page.setDefaultNavigationTimeout(5_000);
    page.on("websocket", () => {
      externalRequests += 1;
    });
    await page.goto(`chrome-extension://${id}/popup.html`);
    await visibilityDeadline(() => context!.setOffline(true));
    stage = "positive-worker";
    expect(
      await visibilityDeadline(() =>
        page.evaluate(() => chrome.runtime.sendMessage({ type: "start" })),
      ),
    ).toEqual({ ok: true });
    report.offscreenCreated = true;
    await expect
      .poll(() =>
        visibilityDeadline(() =>
          page.evaluate(() => chrome.runtime.sendMessage({ type: "state" })),
        ),
      )
      .toEqual({ ready: true });
    report.workerPong = true;
    const contexts = await visibilityDeadline(() =>
      page.evaluate(() =>
        chrome.runtime
          .getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
          })
          .then((rows) =>
            rows.map((row) => ({
              documentIdPresent:
                typeof row.documentId === "string" && row.documentId.length > 0,
            })),
          ),
      ),
    );
    report.contextsRunning = contexts;
    expect(contexts).toEqual([{ documentIdPresent: true }]);
    stage = "parent-inventory";
    const targets = await snapshot("worker-ready-before-attach");
    const parents = findProbeParents(targets, id);
    report.parentCandidates = parents.length;
    if (parents.length !== 1) {
      report.attachment =
        parents.length === 0
          ? "not-attempted-zero-parent"
          : "not-attempted-multiple-parents";
      throw new Error("Expected one owned parent");
    }
    stage = "related-attachment";
    report.attachment = "attempted";
    try {
      await visibilityDeadline(() =>
        session.send("Target.autoAttachRelated", {
          targetId: parents[0]!.targetId,
          waitForDebuggerOnStart: false,
          filter: [{}],
        }),
      );
      report.attachment = "completed";
    } catch {
      report.attachment = "protocol-error";
      throw new Error("Related attachment failed");
    }
    stage = "worker-inventory";
    await snapshot("after-attach");
    for (let index = 0; index < 10; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await snapshot(`poll-${index + 1}`);
    }
    report.strictWorkerVisible = snapshots.some(
      (s) =>
        s.phase.startsWith("poll-") &&
        s.targets.some(
          (t) => t.role === "worker" && t.type === "worker" && t.exactLocation,
        ),
    );
    report.anyOwnedWorkerVisible = snapshots.some((s) =>
      s.targets.some((t) => t.role === "worker"),
    );
    stage = "offscreen-close";
    expect(
      await visibilityDeadline(() =>
        page.evaluate(() => chrome.runtime.sendMessage({ type: "stop" })),
      ),
    ).toEqual({ ok: true });
    const closed = await visibilityDeadline(() =>
      page.evaluate(() =>
        chrome.runtime
          .getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
          })
          .then((rows) => rows.length),
      ),
    );
    report.contextsAfterClose = closed;
    expect(closed).toBe(0);
    report.offscreenClosed = true;
    await snapshot("after-close");
    report.postListenerExternalRequests = externalRequests;
    report.pageErrors = pageErrors;
    expect(externalRequests).toBe(0);
    expect(pageErrors).toBe(0);
    expect(eventOverflow).toBe(false);
    stage = "asset-source-postflight";
    for (const [name, expected] of Object.entries(assets)) {
      const bytes = await readFile(path.join(directory, name));
      expect({ bytes: bytes.length, sha256: sha(bytes) }).toEqual(expected);
    }
    const afterSource = await captureSourceIdentity({
      expectedCommit: environment.sourceCommit,
      controlFiles,
    });
    verifyAuditIdentity(beforeSource, afterSource);
    report.sourceAfter = afterSource;
    report.fixtureAssetsUnchanged = true;
    report.status = "completed";
    // A negative visibility result is evidence, not product compatibility.
  } catch (error) {
    failure = error;
    report.status = "failed";
    report.failureStage = stage;
    report.failure = "probe-or-assertion-failed";
  } finally {
    const measure = async (resource: string, action: () => Promise<void>) => {
      const start = performance.now();
      try {
        await action();
        cleanupPhases.push({
          resource,
          status: "completed",
          elapsedMs: performance.now() - start,
        });
      } catch (error) {
        cleanupPhases.push({
          resource,
          status: "failed",
          elapsedMs: performance.now() - start,
        });
        throw error;
      }
    };
    const ownedContext = context;
    const ownedCdp = cdp;
    try {
      await cleanupFixtureResources(
        ownedContext
          ? { close: () => measure("context", () => ownedContext.close()) }
          : undefined,
        async () => {},
        5_000,
        ownedCdp
          ? { detach: () => measure("cdp", () => ownedCdp.detach()) }
          : undefined,
      );
      report.cleanup = "completed";
    } catch (error) {
      failure =
        failure === undefined
          ? error
          : new AggregateError([failure, error], "Probe and cleanup failed");
      report.status = "failed";
      report.cleanup = "failed";
    }
    report.cleanupPhases = cleanupPhases;
    report.snapshots = snapshots;
    report.events = events;
    report.eventCounts = eventCounts;
    report.eventOverflow = eventOverflow;
    report.elapsedMs = performance.now() - started;
    report.productCompatibilityAcceptance = false;
    report.fullM5Acceptance = false;
    try {
      await output.writeFile(JSON.stringify(report, null, 2) + "\n");
    } finally {
      await output.close();
    }
  }
  if (failure !== undefined) throw failure;
});
