import { test, expect, chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { watchTraffic } from "./traffic";
import { readSourceIdentity } from "./source-identity";

const outputDir = process.env.KOTOBA_GUARD_E2E_OUTPUT_DIR ?? "artifacts";
const extensionDir = path.resolve(
  process.env.KOTOBA_GUARD_EXTENSION_DIR ?? "dist/extension",
);

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function pngDimensions(png: Buffer): {
  readonly width: number;
  readonly height: number;
} {
  expect(png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(
    true,
  );
  expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

test("real: manual check uses bundled WASM offline without external traffic", async () => {
  if (process.env.KOTOBA_GUARD_E2E_OUTPUT_DIR) {
    await mkdir(outputDir);
  }
  if (process.env.KOTOBA_GUARD_EXTENSION_DIR) {
    const expected = process.env.KOTOBA_GUARD_EXPECTED_MODEL_SHA256;
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(
      createHash("sha256")
        .update(
          await readFile(
            path.join(extensionDir, "models/onnx/model_quantized.onnx"),
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
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      "--enable-unsafe-extension-debugging",
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });
  const traffic = watchTraffic(context, origin);
  const errors: string[] = [];
  context.on("weberror", (error) => errors.push(error.error().message));
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(origin);
    await page
      .locator("#text")
      .fill("本日は晴天なので、公園に行って散歩をしよう思います。");
    await expect(page.locator(".kotoba-guard-overlay")).toHaveCount(0);
    const browserCdp = await context.browser()!.newBrowserCDPSession();
    const { targetInfos } = await browserCdp.send("Target.getTargets", {
      filter: [{ type: "tab", exclude: false }],
    });
    const targetInfo = targetInfos.find((target) =>
      target.url.startsWith(origin),
    );
    expect(targetInfo, JSON.stringify(targetInfos)).toBeDefined();
    // Headless Chrome exposes the toolbar popup as a non-page target. Exercise
    // the same bundled UI in an inactive tab after the real action grants activeTab.
    const popup = await context.newPage();
    await page.bringToFront();
    await browserCdp.send("Extensions.triggerAction", {
      id: extensionId,
      targetId: targetInfo!.targetId,
    });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForLoadState();
    await expect(popup.locator("body")).toHaveCSS("width", "330px");
    await expect(popup.locator("#site-name")).toContainText("127.0.0.1");
    await mkdir(path.join(outputDir, "screenshots"), { recursive: true });
    await popup
      .locator("body")
      .screenshot({ path: path.join(outputDir, "screenshots/popup.png") });
    await context.setOffline(true);
    const started = performance.now();
    await popup.locator("#manual-check").click();
    await expect(popup.locator("#status")).toContainText("開始");
    await expect
      .poll(
        () =>
          popup.evaluate(() =>
            chrome.runtime.sendMessage({ type: "get-status" }),
          ),
        { timeout: 30_000 },
      )
      .toMatchObject({ modelReady: true });
    await popup.close();
    await expect(page.locator(".kotoba-guard-mark").first()).toBeVisible({
      timeout: 90_000,
    });
    const coldMs = performance.now() - started;
    await expect(page.locator("#text")).toHaveValue(
      "本日は晴天なので、公園に行って散歩をしよう思います。",
    );
    const textarea = page.locator("#text");
    const textareaBeforeUi = await textarea.evaluate((element) => {
      const field = element as HTMLTextAreaElement;
      field.focus();
      field.setSelectionRange(3, 8);
      return {
        value: field.value,
        start: field.selectionStart,
        end: field.selectionEnd,
      };
    });
    const textareaSummary = page.locator(".kotoba-guard-summary").first();
    const textareaTrigger = textareaSummary.locator(
      ".kotoba-guard-summary-trigger",
    );
    const textareaDetails = textareaSummary.locator(
      ".kotoba-guard-summary-details",
    );
    await expect(textareaTrigger).toHaveText(/^検出 \d+件$/u);
    await expect(textareaDetails).toBeHidden();
    await expect(textareaTrigger).toHaveAttribute("aria-expanded", "false");
    await textareaTrigger.focus();
    await textareaTrigger.press("Enter");
    await expect(textareaDetails).toBeVisible();
    await expect(textareaTrigger).toHaveAttribute("aria-expanded", "true");
    await textareaTrigger.press("Escape");
    await expect(textareaDetails).toBeHidden();
    await expect(textareaTrigger).toHaveAttribute("aria-expanded", "false");
    await expect
      .poll(() =>
        textarea.evaluate((element) => {
          const field = element as HTMLTextAreaElement;
          return {
            value: field.value,
            start: field.selectionStart,
            end: field.selectionEnd,
          };
        }),
      )
      .toEqual(textareaBeforeUi);
    const storage = await worker.evaluate(() => chrome.storage.local.get(null));
    expect(JSON.stringify(storage)).not.toContain("晴天");
    expect(traffic.unexpected).toEqual([]);
    const originalViewport = page.viewportSize();
    await page.setViewportSize({ width: 1280, height: 800 });
    const storeEditorScreenshot = await page.screenshot({
      path: path.join(outputDir, "screenshots/store-editor.png"),
      fullPage: false,
    });
    expect(pngDimensions(storeEditorScreenshot)).toEqual({
      width: 1280,
      height: 800,
    });
    await page.setViewportSize(
      originalViewport ?? { width: 1280, height: 720 },
    );
    await mkdir(outputDir, { recursive: true });
    await page.screenshot({
      path: path.join(outputDir, "textarea-real.png"),
      fullPage: true,
    });
    const editable = page.locator("#editable");
    const sample = "明日の予定については、来週移行にご連絡します。";
    await editable.fill(sample);
    await editable.focus();
    const secondPopup = await context.newPage();
    await page.bringToFront();
    await browserCdp.send("Extensions.triggerAction", {
      id: extensionId,
      targetId: targetInfo!.targetId,
    });
    await secondPopup.goto(`chrome-extension://${extensionId}/popup.html`);
    await secondPopup.locator("#manual-check").click();
    await expect(secondPopup.locator("#status")).toContainText("開始");
    await secondPopup.close();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const highlight = CSS.highlights.get("kotoba-guard-errors");
            return highlight
              ? Array.from(highlight).map((range) => range.toString())
              : [];
          }),
        { timeout: 30_000 },
      )
      .toContain("移行");
    const editableBeforeUi = await editable.evaluate((element) => {
      const field = element as HTMLElement;
      const textNode = field.firstChild;
      const text = textNode?.textContent ?? "";
      const start = text.indexOf("移行");
      if (!textNode || start < 0) throw new Error("editable text not found");
      const selection = window.getSelection();
      if (!selection) throw new Error("selection unavailable");
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + "移行".length);
      selection.removeAllRanges();
      selection.addRange(range);
      return { html: field.innerHTML, text, selected: selection.toString() };
    });
    const summaries = page.locator(".kotoba-guard-summary");
    await expect(summaries).toHaveCount(2);
    const editableSummary = summaries.nth(1);
    const editableTrigger = editableSummary.locator(
      ".kotoba-guard-summary-trigger",
    );
    const editableDetails = editableSummary.locator(
      ".kotoba-guard-summary-details",
    );
    await expect(editableDetails).toBeHidden();
    await editableTrigger.focus();
    await editableTrigger.press("Enter");
    await expect(editableDetails).toBeVisible();
    await editableTrigger.press("Escape");
    await expect(editableDetails).toBeHidden();
    await expect
      .poll(() =>
        editable.evaluate((element) => {
          const field = element as HTMLElement;
          return {
            html: field.innerHTML,
            text: field.textContent ?? "",
            selected: window.getSelection()?.toString() ?? "",
          };
        }),
      )
      .toEqual(editableBeforeUi);
    await expect(editable).toHaveText(sample);
    await expect(editable.locator("span")).toHaveCount(0);
    await page.screenshot({
      path: path.join(outputDir, "contenteditable-real.png"),
      fullPage: true,
    });
    // A manual-only check is a snapshot. Editing must invalidate its old marks.
    await editable.fill("文章を変更しました。");
    await expect
      .poll(() =>
        page.evaluate(
          () => CSS.highlights.get("kotoba-guard-errors")?.size ?? 0,
        ),
      )
      .toBe(0);
    expect(traffic.unexpected).toEqual([]);
    await writeFile(
      path.join(outputDir, "browser-real.json"),
      JSON.stringify(
        {
          ...readSourceIdentity(),
          browser: context.browser()?.version(),
          coldEndToEndMs: coldMs,
          unexpectedRequests: traffic.unexpected,
          fixtureNavigations: traffic.navigation,
          errors,
          storageKeys: Object.keys(storage),
        },
        null,
        2,
      ),
      {
        encoding: "utf8",
        flag: process.env.KOTOBA_GUARD_E2E_OUTPUT_DIR ? "wx" : "w",
      },
    );
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
