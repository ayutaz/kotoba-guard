import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { createServer } from "node:http";
import {
  readFile,
  cp,
  mkdtemp,
  mkdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { watchTraffic } from "./traffic";

const fixturePath = "tests/fixtures/editors.html";
const typo = "明日の予定については、来週移行にご連絡します。";
const clean = "明日の予定については、来週の予定をご連絡します。";
const debounceMs = 700;

function readSoakDurationMs(): number {
  const raw = process.env.KOTOBA_GUARD_STRESS_DURATION_MS;
  if (raw === undefined) return 0;
  const durationMs = Number(raw);
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 86_400_000)
    throw new Error(
      "KOTOBA_GUARD_STRESS_DURATION_MS must be between 0 and 86400000",
    );
  return durationMs;
}

const soakDurationMs = readSoakDurationMs();
const artifactPath =
  process.env.KOTOBA_STRESS_OUTPUT ??
  path.resolve("artifacts/stress-real", randomUUID(), "report.json");
const testSourceCommit = process.env.SOURCE_COMMIT ?? "working-tree";
const runtimeSourceCommit = process.env.RUNTIME_SOURCE_COMMIT ?? "unknown";

type RunningBrowser = {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly popup: Page;
};

async function createFixtureServer(): Promise<{
  readonly origin: string;
  readonly close: () => Promise<void>;
}> {
  const fixture = await readFile(fixturePath);
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(fixture);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function prepareExtension(origin: string): Promise<string> {
  const extensionDir = await mkdtemp(path.resolve(".cache/stress-extension-"));
  await cp("dist/extension", extensionDir, { recursive: true });
  const manifestPath = path.join(extensionDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    host_permissions?: string[];
  };
  // This isolated copy models a pre-granted fixture origin. It does not claim
  // that Chrome's native optional-host-permission prompt was exercised.
  manifest.host_permissions = [`${origin}/*`];
  await writeFile(manifestPath, JSON.stringify(manifest));
  return extensionDir;
}

async function startBrowser(
  extensionDir: string,
  origin: string,
): Promise<RunningBrowser> {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(origin);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForLoadState();
  return { context, page, popup };
}

async function sendPopupMessage<T>(popup: Page, message: unknown): Promise<T> {
  return popup.evaluate(
    (value) => chrome.runtime.sendMessage(value),
    message,
  ) as Promise<T>;
}

async function enableSite(popup: Page, origin: string): Promise<void> {
  await expect(
    await sendPopupMessage<{ ok?: boolean; code?: string }>(popup, {
      type: "set-site-enabled",
      origin,
      enabled: true,
    }),
  ).toMatchObject({ ok: true });
}

async function waitForMark(page: Page): Promise<void> {
  await expect(page.locator(".kotoba-guard-mark")).toContainText(["移行"], {
    timeout: 90_000,
  });
}

async function waitForNoMarks(page: Page): Promise<void> {
  await expect
    .poll(() => page.locator(".kotoba-guard-mark").count(), {
      timeout: 30_000,
    })
    .toBe(0);
}

async function getFixtureTabId(popup: Page, origin: string): Promise<number> {
  return popup.evaluate(async (fixtureOrigin) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) =>
      candidate.url?.startsWith(fixtureOrigin),
    );
    if (tab?.id === undefined) throw new Error("fixture tab was not found");
    return tab.id;
  }, origin);
}

async function getStatus(
  popup: Page,
  tabId: number,
): Promise<{
  readonly globalEnabled: boolean;
  readonly siteEnabled: boolean;
  readonly modelReady: boolean;
  readonly detectionCount: number;
  readonly backend: string;
  readonly lastError?: string;
}> {
  return sendPopupMessage(popup, { type: "get-status", tabId });
}

test("real: repeated edits, IME races, SPA detach and disable remain correct", async () => {
  test.setTimeout(Math.max(180_000, soakDurationMs + 180_000));
  const outputPath = artifactPath;
  try {
    await stat(outputPath);
    throw new Error(`stress artifact already exists: ${outputPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const fixture = await createFixtureServer();
  const extensionDir = await prepareExtension(fixture.origin);
  let running: RunningBrowser | undefined;
  let reportWritten = false;
  try {
    running = await startBrowser(extensionDir, fixture.origin);
    const traffic = watchTraffic(running.context, fixture.origin);
    const errors: string[] = [];
    running.context.on("weberror", (error) =>
      errors.push(error.error().message),
    );
    await enableSite(running.popup, fixture.origin);
    await running.context.setOffline(true);
    const fixtureTabId = await getFixtureTabId(running.popup, fixture.origin);

    const editor = running.page.locator("#text");
    const statusSnapshots: Array<{
      readonly modelReady: boolean;
      readonly detectionCount: number;
      readonly backend: string;
    }> = [];

    const editStartedAt = performance.now();
    let editCycles = 0;
    do {
      await editor.fill(typo);
      const selectionBefore = await editor.evaluate((element) => {
        const field = element as HTMLTextAreaElement;
        field.focus();
        field.setSelectionRange(3, 8);
        return {
          valueLength: field.value.length,
          start: field.selectionStart,
          end: field.selectionEnd,
        };
      });
      expect(selectionBefore).toEqual({
        valueLength: typo.length,
        start: 3,
        end: 8,
      });
      await waitForMark(running.page);
      await expect(editor).toHaveValue(typo);
      const selectionAfter = await editor.evaluate((element) => {
        const field = element as HTMLTextAreaElement;
        return {
          valueLength: field.value.length,
          start: field.selectionStart,
          end: field.selectionEnd,
        };
      });
      expect(selectionAfter).toEqual(selectionBefore);
      const status = await getStatus(running.popup, fixtureTabId);
      expect(status.modelReady).toBe(true);
      expect(status.lastError).toBeUndefined();
      expect(status.detectionCount).toBeGreaterThan(0);
      statusSnapshots.push(status);

      await editor.fill(clean);
      await waitForNoMarks(running.page);
      await expect
        .poll(() => getStatus(running!.popup, fixtureTabId))
        .toMatchObject({ detectionCount: 0 });
      await expect(editor).toHaveValue(clean);
      editCycles += 1;
    } while (
      editCycles < 24 ||
      performance.now() - editStartedAt < soakDurationMs
    );
    const elapsedEditingMs = performance.now() - editStartedAt;
    expect(elapsedEditingMs).toBeGreaterThanOrEqual(soakDurationMs);
    expect(editCycles).toBeGreaterThanOrEqual(24);

    for (let cycle = 0; cycle < 4; cycle += 1) {
      await editor.fill(clean);
      await waitForNoMarks(running.page);
      await editor.evaluate((element, text) => {
        const field = element as HTMLTextAreaElement;
        field.focus();
        field.value = text;
        field.dispatchEvent(new InputEvent("input", { bubbles: true }));
        field.dispatchEvent(
          new CompositionEvent("compositionstart", { bubbles: true }),
        );
        field.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            isComposing: true,
            inputType: "insertCompositionText",
          }),
        );
      }, typo);
      await running.page.waitForTimeout(debounceMs);
      await expect(running.page.locator(".kotoba-guard-mark")).toHaveCount(0);
      await editor.evaluate((element) => {
        element.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true }),
        );
        element.dispatchEvent(new InputEvent("input", { bubbles: true }));
      });
      await waitForMark(running.page);
      await editor.fill(clean);
      await waitForNoMarks(running.page);
    }

    for (let cycle = 0; cycle < 4; cycle += 1) {
      const detachedId = await running.page.evaluate((text) => {
        const field = document.createElement("textarea");
        field.id = `spa-detached-${crypto.randomUUID()}`;
        field.value = text;
        document.body.append(field);
        field.dispatchEvent(new InputEvent("input", { bubbles: true }));
        return field.id;
      }, typo);
      if (cycle % 2 === 0) {
        await waitForMark(running.page);
        await running.page.locator(`#${detachedId}`).evaluate((element) => {
          element.remove();
        });
      } else {
        await running.page.locator(`#${detachedId}`).evaluate((element) => {
          element.remove();
        });
      }
      await running.page.waitForTimeout(debounceMs);
      await waitForNoMarks(running.page);
    }

    await editor.fill(typo);
    await waitForMark(running.page);
    expect(
      await sendPopupMessage<{ ok: boolean }>(running.popup, {
        type: "set-global-enabled",
        enabled: false,
      }),
    ).toEqual({ ok: true });
    const disabledGlobalStatus = await getStatus(running.popup, fixtureTabId);
    expect(disabledGlobalStatus.globalEnabled).toBe(false);
    await waitForNoMarks(running.page);
    await editor.fill(typo);
    await running.page.waitForTimeout(debounceMs);
    await waitForNoMarks(running.page);

    expect(
      await sendPopupMessage<{ ok: boolean }>(running.popup, {
        type: "set-global-enabled",
        enabled: true,
      }),
    ).toEqual({ ok: true });
    await waitForMark(running.page);
    const siteDisabled = await sendPopupMessage<{
      ok?: boolean;
      code?: string;
    }>(running.popup, {
      type: "set-site-enabled",
      origin: fixture.origin,
      enabled: false,
    });
    expect(
      siteDisabled.ok === true ||
        siteDisabled.code === "permission-remove-failed",
    ).toBe(true);
    const disabledSiteStatus = await getStatus(running.popup, fixtureTabId);
    expect(disabledSiteStatus.siteEnabled).toBe(false);
    await waitForNoMarks(running.page);
    await editor.fill(typo);
    await running.page.waitForTimeout(debounceMs);
    await waitForNoMarks(running.page);

    const storage = await running.popup.evaluate(() =>
      chrome.storage.local.get(null),
    );
    const storageText = JSON.stringify(storage);
    expect(storageText).not.toContain("移行");
    expect(storageText).not.toContain("明日の予定");
    expect(traffic.unexpected).toEqual([]);
    expect(errors).toEqual([]);
    expect(statusSnapshots).toHaveLength(editCycles);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      JSON.stringify(
        {
          status: "passed",
          browser: running.context.browser()?.version(),
          runtimeSourceCommit,
          testSourceCommit,
          testSource: "tests/e2e/stress.real.spec.ts",
          editCycles,
          activeCompletedCycles: editCycles,
          elapsedEditingMs: Math.round(elapsedEditingMs),
          requestedDurationMs: soakDurationMs,
          imeCycles: 4,
          detachCycles: 4,
          disableTransitions: 2,
          statusSnapshots: statusSnapshots.map(
            ({ modelReady, detectionCount, backend }) => ({
              modelReady,
              detectionCount,
              backend,
            }),
          ),
          permissionRemovalStatus: {
            ok: siteDisabled.ok === true,
            code: siteDisabled.code ?? null,
          },
          unexpectedRequestCount: traffic.unexpected.length,
          fixtureNavigations: traffic.navigation.length,
          errorCount: errors.length,
          storageKeys: Object.keys(storage),
        },
        null,
        2,
      ),
      { encoding: "utf8", flag: "wx" },
    );
    reportWritten = true;
  } catch (error) {
    if (!reportWritten) {
      try {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(
          outputPath,
          JSON.stringify(
            {
              status: "failed",
              stage: "runtime-stress",
              testSourceCommit,
              runtimeSourceCommit,
              requestedDurationMs: soakDurationMs,
              errorCount: 1,
            },
            null,
            2,
          ),
          { encoding: "utf8", flag: "wx" },
        );
      } catch {
        // Preserve the original test failure if the failure receipt cannot be written.
      }
    }
    throw error;
  } finally {
    await running?.context.close();
    await fixture.close();
  }
});
