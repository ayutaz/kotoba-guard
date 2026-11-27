import { test, expect, chromium } from "@playwright/test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  readFile,
  mkdir,
  cp,
  mkdtemp,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { watchTraffic } from "./traffic";
import { createChromiumLaunchOptions } from "./browser-options";
import { cleanupFixtureResources } from "./fixture-resources";
import { snapshotNativeHighlights } from "./native-highlights";
import { readSourceIdentity } from "./source-identity";

const automaticOutput =
  process.env.KOTOBA_AUTOMATIC_OUTPUT ?? "artifacts/automatic-real.json";
const hasExclusiveOutput = process.env.KOTOBA_AUTOMATIC_OUTPUT !== undefined;

async function prepareExclusiveOutput(): Promise<void> {
  if (!hasExclusiveOutput) return;
  await mkdir(path.dirname(automaticOutput), { recursive: true });
  try {
    await stat(automaticOutput);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Automatic test output already exists: ${automaticOutput}`);
}

test("real: fixture-granted origin supports offline automatic checks and IME", async () => {
  await prepareExclusiveOutput();
  if (process.env.KOTOBA_GUARD_EXTENSION_DIR) {
    const expected = process.env.KOTOBA_GUARD_EXPECTED_MODEL_SHA256;
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(
      createHash("sha256")
        .update(
          await readFile(
            path.join(
              process.env.KOTOBA_GUARD_EXTENSION_DIR,
              "models/onnx/model_quantized.onnx",
            ),
          ),
        )
        .digest("hex"),
    ).toBe(expected);
  }
  const fixture = await readFile("tests/fixtures/editors.html");
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(fixture);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let context:
    Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await mkdir(".cache", { recursive: true });
    const extension = await mkdtemp(path.resolve(".cache/fixture-extension-"));
    await cp(
      process.env.KOTOBA_GUARD_EXTENSION_DIR ?? "dist/extension",
      extension,
      { recursive: true },
    );
    const manifest = JSON.parse(
      await readFile(path.join(extension, "manifest.json"), "utf8"),
    );
    // Only this isolated test copy is pre-granted the fixture origin. Production
    // optional permission confirmation is a separate, unverified browser UI gate.
    manifest.host_permissions = [`${origin}/*`];
    await writeFile(
      path.join(extension, "manifest.json"),
      JSON.stringify(manifest),
    );
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
    const traffic = watchTraffic(context, origin);
    const errors: string[] = [];
    context.on("weberror", (error) => errors.push(error.error().message));
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const enabled = await popup.evaluate(
      (origin) =>
        chrome.runtime.sendMessage({
          type: "set-site-enabled",
          origin,
          enabled: true,
        }),
      origin,
    );
    expect(enabled).toEqual({ ok: true });
    const page = await context.newPage();
    const secondPage = await context.newPage();
    await page.goto(origin);
    await secondPage.goto(origin);
    await context.setOffline(true);
    const sample = "明日の予定については、来週移行にご連絡します。";
    await page.locator("#text").evaluate((element, text) => {
      const input = element as HTMLTextAreaElement;
      input.focus();
      input.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      input.value = text;
      input.dispatchEvent(
        new InputEvent("input", { bubbles: true, isComposing: true }),
      );
    }, sample);
    await page.waitForTimeout(650);
    expect(
      await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: "get-status" }),
      ),
    ).toMatchObject({ modelReady: false });
    await page.locator("#text").evaluate((element) => {
      element.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      );
      element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await expect(page.locator(".kotoba-guard-mark")).toContainText(["移行"]);
    await expect(page.locator(".kotoba-guard-mark").first()).toBeVisible();
    await expect(page.locator("#text")).toHaveValue(sample);
    await secondPage.locator("#input").fill(sample);
    await expect(secondPage.locator(".kotoba-guard-mark")).toContainText([
      "移行",
    ]);
    await expect(
      secondPage.locator(".kotoba-guard-mark").first(),
    ).toBeVisible();
    await secondPage.locator("#input").fill("");
    await expect(secondPage.locator(".kotoba-guard-mark")).toHaveCount(0);
    await secondPage.locator("#editable").fill(sample);
    await expect
      .poll(
        () =>
          secondPage.locator("#editable").evaluate(snapshotNativeHighlights),
        { timeout: 30_000 },
      )
      .toEqual({
        ranges: [
          {
            text: "移行",
            start: sample.indexOf("移行"),
            end: sample.indexOf("移行") + "移行".length,
            visible: true,
          },
        ],
        visible: true,
      });
    await expect(secondPage.locator(".kotoba-guard-summary")).toHaveCount(1);
    await expect(
      secondPage.locator(".kotoba-guard-summary-trigger"),
    ).toBeVisible();
    await expect(
      secondPage.locator(".kotoba-guard-summary-trigger"),
    ).toHaveText("検出 1件");
    await expect(secondPage.locator("#editable")).toHaveText(sample);
    // Sensitive editors remain excluded even on an explicitly permitted origin.
    await page.locator("#text").fill("");
    await expect(page.locator(".kotoba-guard-mark")).toHaveCount(0);
    await page.locator("#password").fill(sample);
    await page.locator("#otp").fill(sample);
    await page.locator("#card").fill(sample);
    await page.waitForTimeout(650);
    await expect(page.locator(".kotoba-guard-mark")).toHaveCount(0);
    expect(
      await popup.evaluate(() =>
        chrome.runtime.sendMessage({
          type: "set-global-enabled",
          enabled: false,
        }),
      ),
    ).toEqual({ ok: true });
    await expect(secondPage.locator(".kotoba-guard-mark")).toHaveCount(0);
    await expect
      .poll(
        () =>
          secondPage.locator("#editable").evaluate(snapshotNativeHighlights),
        { timeout: 30_000 },
      )
      .toEqual({ ranges: [], visible: false });
    await secondPage.locator("#editable").fill(sample + "😀");
    await expect
      .poll(
        () =>
          secondPage.locator("#editable").evaluate(snapshotNativeHighlights),
        { timeout: 30_000 },
      )
      .toEqual({ ranges: [], visible: false });
    await secondPage.locator("#input").fill(sample + "😀");
    await page.waitForTimeout(650);
    await expect(secondPage.locator(".kotoba-guard-mark")).toHaveCount(0);
    await expect
      .poll(() =>
        secondPage.locator("#editable").evaluate(snapshotNativeHighlights),
      )
      .toEqual({ ranges: [], visible: false });
    const storage = await worker.evaluate(() => chrome.storage.local.get(null));
    expect(JSON.stringify(storage)).not.toContain("移行");
    expect(traffic.unexpected).toEqual([]);
    expect(errors).toEqual([]);
    await writeFile(
      automaticOutput,
      JSON.stringify(
        {
          browser: context.browser()?.version(),
          ...readSourceIdentity(),
          permission:
            "fixture-only manifest grant; native optional permission UI unverified",
          tabs: 2,
          unexpectedRequests: traffic.unexpected,
          fixtureNavigations: traffic.navigation,
          errors,
          storageKeys: Object.keys(storage),
        },
        null,
        2,
      ),
      hasExclusiveOutput ? { encoding: "utf8", flag: "wx" } : undefined,
    );
  } finally {
    await cleanupFixtureResources(
      context,
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
  }
});
