import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { createServer } from "node:http";
import { readFile, cp, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";

type RunningBrowser = {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly popup: Page;
  readonly extensionId: string;
};

const fixturePath = "tests/fixtures/editors.html";
const typo = "明日の予定については、来週移行にご連絡します。";

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

async function startBrowser(
  extensionDir: string,
  userDataDir: string,
  origin: string,
): Promise<RunningBrowser> {
  const context = await chromium.launchPersistentContext(userDataDir, {
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
  return { context, page, popup, extensionId };
}

async function prepareExtension(origin: string): Promise<string> {
  const extensionDir = await mkdtemp(
    path.resolve(".cache/lifecycle-extension-"),
  );
  await cp("dist/extension", extensionDir, { recursive: true });
  const manifestPath = path.join(extensionDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    host_permissions?: string[];
  };
  // This isolated copy models an already granted automatic-check origin. It
  // does not exercise Chrome's native optional-host-permission prompt.
  manifest.host_permissions = [`${origin}/*`];
  await writeFile(manifestPath, JSON.stringify(manifest));
  return extensionDir;
}

async function sendPopupMessage<T>(popup: Page, message: unknown): Promise<T> {
  return popup.evaluate(
    (value) => chrome.runtime.sendMessage(value),
    message,
  ) as Promise<T>;
}

async function enableSite(popup: Page, origin: string): Promise<void> {
  await expect
    .poll(() =>
      sendPopupMessage<{ ok?: boolean; code?: string }>(popup, {
        type: "set-site-enabled",
        origin,
        enabled: true,
      }),
    )
    .toMatchObject({ ok: true });
}

async function waitForDetection(page: Page): Promise<void> {
  await expect(page.locator(".kotoba-guard-mark")).toContainText(["移行"]);
}

test("real: settings survive browser restart and disabled state blocks reads", async () => {
  const fixture = await createFixtureServer();
  const extensionDir = await prepareExtension(fixture.origin);
  const userDataDir = await mkdtemp(path.resolve(".cache/lifecycle-profile-"));
  let first: RunningBrowser | undefined;
  let second: RunningBrowser | undefined;
  try {
    first = await startBrowser(extensionDir, userDataDir, fixture.origin);
    await enableSite(first.popup, fixture.origin);
    expect(
      await sendPopupMessage<{ ok: boolean }>(first.popup, {
        type: "set-global-enabled",
        enabled: false,
      }),
    ).toEqual({ ok: true });
    await expect
      .poll(() => first!.popup.evaluate(() => chrome.storage.local.get(null)))
      .toMatchObject({ globalEnabled: false });
    await first.context.close();
    first = undefined;

    second = await startBrowser(extensionDir, userDataDir, fixture.origin);
    const persisted = await second.popup.evaluate(() =>
      chrome.storage.local.get(null),
    );
    expect(persisted).toMatchObject({
      globalEnabled: false,
      enabledSites: [fixture.origin],
    });
    // Re-enable once to inject the persisted site's content script into the
    // tab created after restart, then immediately restore the persisted off
    // state before asserting that the editor is not read.
    expect(
      await sendPopupMessage<{ ok: boolean }>(second.popup, {
        type: "set-global-enabled",
        enabled: true,
      }),
    ).toEqual({ ok: true });
    expect(
      await sendPopupMessage<{ ok: boolean }>(second.popup, {
        type: "set-global-enabled",
        enabled: false,
      }),
    ).toEqual({ ok: true });
    await second.context.setOffline(true);
    await second.page.locator("#text").fill(typo);
    await second.page.waitForTimeout(800);
    expect(await second.page.locator(".kotoba-guard-mark").count()).toBe(0);

    expect(
      await sendPopupMessage<{ ok: boolean }>(second.popup, {
        type: "set-global-enabled",
        enabled: true,
      }),
    ).toEqual({ ok: true });
    await waitForDetection(second.page);
    const storage = await second.popup.evaluate(() =>
      chrome.storage.local.get(null),
    );
    expect(JSON.stringify(storage)).not.toContain(typo);
  } finally {
    await second?.context.close();
    await first?.context.close();
    await fixture.close();
  }
});

test("real: global and site cancellation clear existing marks and stop new checks", async () => {
  const fixture = await createFixtureServer();
  const extensionDir = await prepareExtension(fixture.origin);
  const userDataDir = await mkdtemp(path.resolve(".cache/lifecycle-cancel-"));
  let running: RunningBrowser | undefined;
  try {
    running = await startBrowser(extensionDir, userDataDir, fixture.origin);
    await enableSite(running.popup, fixture.origin);
    await running.context.setOffline(true);
    await running.page.locator("#text").fill(typo);
    await waitForDetection(running.page);

    expect(
      await sendPopupMessage<{ ok: boolean }>(running.popup, {
        type: "set-global-enabled",
        enabled: false,
      }),
    ).toEqual({ ok: true });
    await expect(running.page.locator(".kotoba-guard-mark")).toHaveCount(0);
    await running.page.locator("#text").fill(typo + "追加入力");
    await running.page.waitForTimeout(800);
    await expect(running.page.locator(".kotoba-guard-mark")).toHaveCount(0);

    expect(
      await sendPopupMessage<{ ok?: boolean; code?: string }>(running.popup, {
        type: "set-global-enabled",
        enabled: true,
      }),
    ).toEqual({ ok: true });
    await running.page.locator("#text").fill(typo);
    await waitForDetection(running.page);
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
    await expect(running.page.locator(".kotoba-guard-mark")).toHaveCount(0);
    await running.page.locator("#text").fill(typo + "停止後");
    await running.page.waitForTimeout(800);
    await expect(running.page.locator(".kotoba-guard-mark")).toHaveCount(0);
  } finally {
    await running?.context.close();
    await fixture.close();
  }
});

test("real: paste, undo/redo and a long chunk boundary preserve editor state", async () => {
  const fixture = await createFixtureServer();
  const extensionDir = await prepareExtension(fixture.origin);
  const userDataDir = await mkdtemp(path.resolve(".cache/lifecycle-editing-"));
  let running: RunningBrowser | undefined;
  try {
    running = await startBrowser(extensionDir, userDataDir, fixture.origin);
    await enableSite(running.popup, fixture.origin);
    await running.context.setOffline(true);
    const editor = running.page.locator("#text");
    await editor.evaluate((element, text) => {
      const field = element as HTMLTextAreaElement;
      field.focus();
      field.value = text;
      field.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertFromPaste",
          data: text,
        }),
      );
    }, typo);
    await waitForDetection(running.page);
    await expect(editor).toHaveValue(typo);
    await editor.fill("");
    await expect(editor).toHaveValue("");
    await expect(running.page.locator(".kotoba-guard-mark")).toHaveCount(0);

    // Chromium keeps a script-assigned paste and a following fill in the
    // same undo history. Use the independent input editor for a native
    // keyboard history check so this assertion covers actual Undo/Redo
    // semantics rather than relying on a synthetic history boundary.
    const undoEditor = running.page.locator("#input");
    await undoEditor.click();
    await running.page.keyboard.insertText(typo);
    await expect(undoEditor).toHaveValue(typo);
    await running.page.keyboard.press(
      process.platform === "darwin" ? "Meta+z" : "Control+z",
    );
    await expect(undoEditor).toHaveValue("");
    await expect(running.page.locator(".kotoba-guard-mark")).toHaveCount(0);
    await running.page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+z" : "Control+y",
    );
    await expect(undoEditor).toHaveValue(typo);
    await waitForDetection(running.page);

    const longText = `${"これは境界検証用の正常な文章です。".repeat(80)}${typo}`;
    await editor.fill(longText);
    await expect(editor).toHaveValue(longText);
    await waitForDetection(running.page);
    const selection = await editor.evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      field.setSelectionRange(12, 12);
      return {
        value: field.value,
        start: field.selectionStart,
        end: field.selectionEnd,
      };
    });
    expect(selection).toEqual({ value: longText, start: 12, end: 12 });
  } finally {
    await running?.context.close();
    await fixture.close();
  }
});
