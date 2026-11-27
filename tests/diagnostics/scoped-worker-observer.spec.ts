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
import { createChromiumLaunchOptions } from "../e2e/browser-options";
import { ScopedWorkerObserver } from "../e2e/scoped-worker-observer";
import {
  visibilityDeadline,
  visibilityFixtureFiles,
} from "./worker-visibility";

const CHROME116 = "116.0.5845.96";
const CONTROL_FILES = [
  "tests/diagnostics/scoped-worker-observer.spec.ts",
  "playwright.scoped-worker.config.ts",
  "tests/e2e/scoped-worker-observer.ts",
  "tests/e2e/scoped-worker-ledger.ts",
  "tests/diagnostics/worker-visibility.ts",
  "tests/e2e/browser-options.ts",
  "scripts/browser_audit_evidence.mjs",
  "package-lock.json",
];

function readEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const sourceCommit = environment.SOURCE_COMMIT;
  const executablePath = environment.KOTOBA_GUARD_BROWSER_EXECUTABLE;
  const output = environment.KOTOBA_SCOPED_WORKER_OUTPUT;
  const expected = sourceCommit
    ? path.resolve(
        "artifacts/scoped-worker-observer",
        sourceCommit,
        "report.json",
      )
    : "";
  if (
    !/^[a-f0-9]{40}$/.test(sourceCommit ?? "") ||
    !executablePath ||
    !path.isAbsolute(executablePath) ||
    !output ||
    !path.isAbsolute(output) ||
    output !== expected
  )
    throw new Error("Invalid scoped observer trial environment");
  return { sourceCommit, executablePath, output };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

type Phase = {
  readonly name: string;
  readonly workers: number;
  readonly parentBound: boolean;
  readonly status: string;
};

type Observation = {
  readonly status: "complete" | "unavailable";
  readonly workers: string[] | null;
};

async function observeUntil(
  observer: ScopedWorkerObserver,
  expectedWorkers: number,
): Promise<Observation> {
  let latest: Observation = { status: "unavailable", workers: null };
  await expect
    .poll(
      async () => {
        try {
          const workers = await visibilityDeadline(() => observer.observe());
          latest = { status: "complete", workers };
          return workers.length === expectedWorkers;
        } catch {
          latest = { status: "unavailable", workers: null };
          return false;
        }
      },
      { timeout: 10_000, intervals: [250, 500, 1_000, 2_000] },
    )
    .toBe(true);
  return latest;
}

test("model-free Chrome116: observe one scoped Worker generation", async () => {
  const environment = readEnvironment();
  const output = await reserveAuditReport(environment.output);
  let context: BrowserContext | undefined;
  let cdp: CDPSession | undefined;
  let observer: ScopedWorkerObserver | undefined;
  let failure: unknown;
  let stage = "source-preflight";
  const started = performance.now();
  let fixtureDirectory: string | undefined;
  let externalRequests: number | null = null;
  let pageErrors: number | null = null;
  let monitoringStarted = false;
  const report: Record<string, unknown> = {
    status: "failed",
    sourceCommit: environment.sourceCommit,
    browserVersion: null,
    modelInferenceCount: 0,
    fixtureOnly: true,
    workerGenerationCount: 1,
    ownedWorkerId: null,
    contextsInitial: null,
    contextsBeforeClose: null,
    contextsAfterClose: null,
    postListenerExternalRequests: null,
    pageErrors: null,
  };
  const phases: Phase[] = [];
  const cleanupPhases: Array<{
    resource: string;
    status: string;
    elapsedMs: number | null;
  }> = [];

  try {
    const beforeSource = await captureSourceIdentity({
      expectedCommit: environment.sourceCommit,
      controlFiles: CONTROL_FILES,
    });
    report.sourceBefore = beforeSource;

    const files = visibilityFixtureFiles();
    const directory = await mkdtemp(
      path.resolve(".cache/scoped-worker-fixture-"),
    );
    fixtureDirectory = directory;
    report.fixtureDirectory = path
      .relative(process.cwd(), directory)
      .replaceAll("\\", "/");
    const assets: Record<string, { bytes: number; sha256: string }> = {};
    for (const [name, value] of Object.entries(files)) {
      await writeFile(path.join(directory, name), value, { flag: "wx" });
      assets[name] = { bytes: Buffer.byteLength(value), sha256: sha256(value) };
    }
    report.fixtureAssets = assets;

    stage = "launch";
    context = await chromium.launchPersistentContext("", {
      ...createChromiumLaunchOptions(directory),
      timeout: 30_000,
    });
    const browserVersion = context.browser()?.version() ?? null;
    report.browserVersion = browserVersion;
    expect(browserVersion).toBe(CHROME116);

    externalRequests = 0;
    pageErrors = 0;
    context.on("request", (request) => {
      if (monitoringStarted && /^(https?|wss?):/.test(request.url()))
        externalRequests = (externalRequests ?? 0) + 1;
    });
    context.on("weberror", () => {
      if (monitoringStarted) pageErrors = (pageErrors ?? 0) + 1;
    });

    stage = "observer-setup";
    const background =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 5_000 }));
    const extensionId = new URL(background.url()).host;
    cdp = await visibilityDeadline(() =>
      context!.browser()!.newBrowserCDPSession(),
    );
    observer = new ScopedWorkerObserver(cdp, extensionId);
    await visibilityDeadline(() =>
      cdp!.send("Target.setDiscoverTargets", { discover: true }),
    );

    const absent = await observeUntil(observer, 0);
    expect(absent).toEqual({ status: "complete", workers: [] });
    const absentMetadata = observer.metadata();
    expect(absentMetadata).toMatchObject({
      status: "complete",
      workers: 0,
      parentBound: false,
    });
    phases.push({
      name: "before-start",
      workers: absentMetadata.workers,
      parentBound: absentMetadata.parentBound,
      status: absentMetadata.status,
    });

    const page = await visibilityDeadline(() => context!.newPage());
    page.setDefaultTimeout(5_000);
    page.setDefaultNavigationTimeout(5_000);
    await visibilityDeadline(() =>
      page.goto(`chrome-extension://${extensionId}/popup.html`),
    );
    monitoringStarted = true;

    const initialContexts = await visibilityDeadline(() =>
      page.evaluate(() =>
        chrome.runtime
          .getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
          })
          .then((rows) => rows.length),
      ),
    );
    expect(initialContexts).toBe(0);
    report.contextsInitial = initialContexts;

    stage = "fixture-start";
    expect(
      await visibilityDeadline(() =>
        page.evaluate(() => chrome.runtime.sendMessage({ type: "start" })),
      ),
    ).toEqual({ ok: true });
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
          .then((rows) => rows.length),
      ),
    );
    expect(contexts).toBe(1);
    report.contextsBeforeClose = contexts;

    stage = "scoped-observe";
    const observedResult = await observeUntil(observer, 1);
    expect(observedResult.status).toBe("complete");
    expect(observedResult.workers).toHaveLength(1);
    report.ownedWorkerId = observedResult.workers?.[0] ?? null;
    const observed = observer.metadata();
    expect(observed).toMatchObject({
      status: "complete",
      parentBound: true,
      workers: 1,
    });
    phases.push({
      name: "after-start",
      workers: observed.workers,
      parentBound: observed.parentBound,
      status: observed.status,
    });

    stage = "fixture-stop";
    expect(
      await visibilityDeadline(() =>
        page.evaluate(() => chrome.runtime.sendMessage({ type: "stop" })),
      ),
    ).toEqual({ ok: true });
    await expect
      .poll(() =>
        visibilityDeadline(() =>
          page.evaluate(() =>
            chrome.runtime
              .getContexts({
                contextTypes: [
                  "OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType,
                ],
              })
              .then((rows) => rows.length),
          ),
        ),
      )
      .toBe(0);
    report.contextsAfterClose = 0;
    const stopped = await observeUntil(observer, 0);
    expect(stopped).toEqual({ status: "complete", workers: [] });
    const stoppedMetadata = observer.metadata();
    expect(stoppedMetadata.status).toBe("complete");
    expect(stoppedMetadata.parentBound).toBe(false);
    expect(stoppedMetadata.workers).toBe(0);
    phases.push({
      name: "after-stop",
      workers: stoppedMetadata.workers,
      parentBound: stoppedMetadata.parentBound,
      status: stoppedMetadata.status,
    });

    report.postListenerExternalRequests = externalRequests;
    report.pageErrors = pageErrors;
    expect(externalRequests).toBe(0);
    expect(pageErrors).toBe(0);
    report.status = "completed";
  } catch (error) {
    failure = error;
    report.status = "failed";
    report.failureStage = stage;
    report.failure = "probe-or-assertion-failed";
  } finally {
    const cleanupErrors: unknown[] = [];
    const runCleanupPhase = async (
      resource: string,
      action: () => Promise<void>,
    ): Promise<void> => {
      const phase = {
        resource,
        status: "pending",
        elapsedMs: null as number | null,
      };
      cleanupPhases.push(phase);
      const startedAt = performance.now();
      try {
        await visibilityDeadline(action);
        phase.status = "completed";
      } catch (error) {
        phase.status = "failed";
        cleanupErrors.push(error);
      } finally {
        phase.elapsedMs = performance.now() - startedAt;
      }
    };
    await runCleanupPhase("scoped-observer", async () => {
      if (observer) await observer.dispose();
    });
    await runCleanupPhase("cdp-session", async () => {
      if (cdp) await cdp.detach();
    });
    await runCleanupPhase("browser-context", async () => {
      if (context) await context.close();
    });
    if (cleanupErrors.length > 0) {
      const cleanupFailure = new AggregateError(
        cleanupErrors,
        "Scoped observer cleanup failed",
      );
      failure =
        failure === undefined
          ? cleanupFailure
          : new AggregateError(
              [failure, cleanupFailure],
              "Probe and cleanup failed",
            );
      report.status = "failed";
    }
    report.phases = phases;
    report.cleanup = cleanupPhases.every(
      (phase) => phase.status === "completed",
    )
      ? "completed"
      : "failed";
    report.cleanupPhases = cleanupPhases;
    report.elapsedMs = performance.now() - started;
    report.postListenerExternalRequests = externalRequests;
    report.pageErrors = pageErrors;
    report.productCompatibilityAcceptance = false;
    report.fullM5Acceptance = false;
    try {
      const afterSource = await captureSourceIdentity({
        expectedCommit: environment.sourceCommit,
        controlFiles: CONTROL_FILES,
      });
      report.sourceAfter = afterSource;
      if (report.sourceBefore)
        verifyAuditIdentity(report.sourceBefore, afterSource);
      report.fixtureAssetsUnchanged = false;
      if (
        fixtureDirectory !== undefined &&
        report.fixtureAssets &&
        typeof report.fixtureAssets === "object"
      ) {
        const files = visibilityFixtureFiles();
        const recorded = report.fixtureAssets as Record<
          string,
          { bytes: number; sha256: string }
        >;
        const expectedNames = Object.keys(files).sort();
        const recordedNames = Object.keys(recorded).sort();
        if (JSON.stringify(expectedNames) === JSON.stringify(recordedNames)) {
          report.fixtureAssetsUnchanged = true;
          for (const name of expectedNames) {
            const expected = recorded[name];
            const expectedFixture = files[name];
            if (!expected || expectedFixture === undefined) {
              report.fixtureAssetsUnchanged = false;
              continue;
            }
            const bytes = await readFile(path.join(fixtureDirectory, name));
            if (
              bytes.length !== expected.bytes ||
              sha256(bytes) !== expected.sha256 ||
              sha256(expectedFixture) !== expected.sha256
            )
              report.fixtureAssetsUnchanged = false;
          }
        }
      }
      if (report.fixtureAssetsUnchanged !== true) {
        report.status = "failed";
        const fixtureFailure = new Error(
          "Fixture assets changed or were not verified",
        );
        failure =
          failure === undefined
            ? fixtureFailure
            : new AggregateError(
                [failure, fixtureFailure],
                "Probe verification failed",
              );
      }
    } catch {
      report.sourceAfter = null;
      report.fixtureAssetsUnchanged = false;
      report.status = "failed";
      const verificationFailure = new Error(
        "Source or fixture verification failed",
      );
      failure =
        failure === undefined
          ? verificationFailure
          : new AggregateError(
              [failure, verificationFailure],
              "Probe verification failed",
            );
    }
    try {
      await output.writeFile(JSON.stringify(report, null, 2) + "\n");
    } finally {
      await output.close();
    }
  }
  if (failure !== undefined) throw failure;
});
