import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { build } from "vite";
import { readFile } from "node:fs/promises";
import path from "node:path";

let context: BrowserContext;
let page: Page;
test.beforeAll(async () => {
  await build({
    configFile: false,
    publicDir: false,
    build: {
      outDir: ".cache/mock-browser",
      emptyOutDir: true,
      minify: false,
      lib: {
        entry: "extension/src/content/controller.ts",
        name: "KotobaGuardTest",
        formats: ["iife"],
        fileName: () => "controller.js",
      },
    },
  });
});
test.beforeEach(async () => {
  const browser = await chromium.launch();
  context = await browser.newContext();
  page = await context.newPage();
  await page.setContent(await readFile("tests/fixtures/editors.html", "utf8"));
  await page.addScriptTag({
    path: path.resolve(".cache/mock-browser/controller.js"),
  });
  await page.evaluate(() => {
    const w = window as unknown as {
      KotobaGuardTest: {
        ContentController: new (options: unknown) => {
          start(): void;
          setState(state: boolean): void;
        };
      };
      requests: { type: string; text?: string; requestId?: number }[];
      controller: { start(): void; setState(state: boolean): void };
    };
    w.requests = [];
    w.controller = new w.KotobaGuardTest.ContentController({
      debounceMs: 30,
      sendMessage: async (message: {
        type: string;
        text?: string;
        requestId?: number;
      }) => {
        w.requests.push(message);
        if (message.type === "content-ready")
          return {
            state: {
              globalEnabled: true,
              siteEnabled: true,
              origin: "fixture",
            },
          };
        return {
          type: "check-result",
          requestId: message.requestId,
          result: {
            backend: "wasm",
            modelVersion: "MOCK",
            inferenceMs: 0,
            detections: [
              {
                start: 0,
                end: 2,
                text: message.text?.slice(0, 2),
                type: "deletion",
                confidence: 0.9,
              },
            ],
          },
        };
      },
    });
    w.controller.start();
  });
});
test.afterEach(async () => {
  const browser = context.browser();
  await context.close();
  await browser?.close();
});

test("mock: IME composition waits for commit and preserves the editor", async () => {
  await page.locator("#text").evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    field.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    field.value = "にほんご";
    field.dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing: true }),
    );
  });
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { requests: { type: string }[] }).requests.filter(
          (x) => x.type === "check",
        ).length,
    ),
  ).toBe(0);
  await page.locator("#text").evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    field.value = "日本語の文章";
    field.setSelectionRange(3, 3);
    field.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  await expect(page.locator(".kotoba-guard-mark")).toHaveCount(1);
  expect(await page.locator("#text").inputValue()).toBe("日本語の文章");
  expect(
    await page
      .locator("#text")
      .evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
  ).toBe(3);
});

test("mock: sensitive fields never enter inference and disabling clears marks", async () => {
  for (const id of ["password", "otp", "card"])
    await page.locator(`#${id}`).fill("秘密の情報");
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { requests: { type: string }[] }).requests.filter(
          (x) => x.type === "check",
        ).length,
    ),
  ).toBe(0);
  await page.locator("#text").fill("公開テスト");
  await expect(page.locator(".kotoba-guard-mark")).toHaveCount(1);
  await page.evaluate(() =>
    (
      window as unknown as { controller: { setState(state: boolean): void } }
    ).controller.setState(false),
  );
  await expect(page.locator(".kotoba-guard-overlay")).toHaveCount(0);
});

test("mock: textarea overlay follows internal scroll and preserves selection", async () => {
  const longText = Array.from(
    { length: 80 },
    (_, index) => `行${index} ${"日本語の長い文章".repeat(30)}`,
  ).join("\n");
  await page.locator("#text").evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    field.style.whiteSpace = "pre";
    field.style.overflowWrap = "normal";
  });
  await page.locator("#text").fill(longText);
  await expect(page.locator(".kotoba-guard-mark")).toHaveCount(1);
  const state = await page.locator("#text").evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    field.style.cssText +=
      "border: 4px solid red; box-sizing: border-box; letter-spacing: 2px; text-indent: 3px;";
    field.setSelectionRange(8, 12);
    field.scrollTop = 0;
    field.scrollLeft = 0;
    field.dispatchEvent(new Event("scroll", { bubbles: true }));
    const mark = document.querySelector<HTMLElement>(".kotoba-guard-mark");
    const markTopBeforeScroll = mark?.getBoundingClientRect().top ?? null;
    field.scrollTop = 40;
    field.scrollLeft = 6;
    field.dispatchEvent(new Event("scroll", { bubbles: true }));
    const markTopAfterScroll = mark?.getBoundingClientRect().top ?? null;
    const overlay = document.querySelector<HTMLElement>(
      ".kotoba-guard-overlay",
    );
    const content = overlay?.firstElementChild as HTMLElement | null;
    return {
      value: field.value,
      start: field.selectionStart,
      end: field.selectionEnd,
      transform: content?.style.transform,
      letterSpacing: content?.style.letterSpacing,
      textIndent: content?.style.textIndent,
      boxSizing: content?.style.boxSizing,
      scrollLeft: field.scrollLeft,
      scrollTop: field.scrollTop,
      markDeltaY:
        markTopBeforeScroll !== null && markTopAfterScroll !== null
          ? markTopAfterScroll - markTopBeforeScroll
          : null,
    };
  });
  expect(state.value).toBe(longText);
  expect(state.start).toBe(8);
  expect(state.end).toBe(12);
  expect(state.transform).toContain("-40px");
  expect(state.transform).toContain("-6px");
  expect(state.scrollLeft).toBeGreaterThan(0);
  expect(state.scrollTop).toBeGreaterThan(0);
  expect(state.markDeltaY).toBeCloseTo(-40, 0);
  expect(state.letterSpacing).toBe("2px");
  expect(state.textIndent).toBe("3px");
  expect(state.boxSizing).toBe("border-box");
});

test("mock: contenteditable rendering does not execute input HTML or alter DOM", async () => {
  const payload = '<img src=x onerror="window.__xss=true">日本語';
  await page.locator("#editable").fill(payload);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { requests: { type: string }[] }
          ).requests.filter((x) => x.type === "check").length,
      ),
    )
    .toBe(1);
  await expect(page.locator("#editable")).toHaveText(payload);
  expect(await page.locator("#editable img").count()).toBe(0);
  expect(await page.evaluate(() => "__xss" in window)).toBe(false);
});
