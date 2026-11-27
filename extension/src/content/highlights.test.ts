import { describe, expect, it } from "vitest";
import { HighlightManager } from "./highlights";

describe("HighlightManager", () => {
  it("renders textarea highlights in an external safe overlay without changing editor text", () => {
    document.body.innerHTML = '<textarea id="editor"></textarea>';
    const editor = document.querySelector("textarea")!;
    editor.value = "<script>安全</script>";
    const manager = new HighlightManager();
    manager.show(editor, [
      { start: 0, end: 8, text: "<script>", type: "typo", confidence: 0.9 },
    ]);
    expect(editor.value).toBe("<script>安全</script>");
    expect(
      document.querySelector(".kotoba-guard-overlay")?.innerHTML,
    ).not.toContain("<script>");
    expect(document.querySelector(".kotoba-guard-mark")?.textContent).toBe(
      "<script>",
    );
    expect(
      document.querySelector(".kotoba-guard-summary-status")?.textContent,
    ).toBe("誤字の可能性 (90%)");
    expect(
      document.querySelector("#kotoba-guard-highlight-style")?.textContent,
    ).toContain("kotoba-guard-mark");
    expect(
      document.querySelector("#kotoba-guard-highlight-style")?.textContent,
    ).not.toContain(".kotoba-guard-overlay { text-decoration");
    manager.clear(editor);
    expect(document.querySelector(".kotoba-guard-overlay")).toBeNull();
    expect(document.querySelector(".kotoba-guard-summary")).toBeNull();
  });

  it("repositions the external UI on viewport and editor scrolling", () => {
    document.body.innerHTML = '<textarea id="editor"></textarea>';
    const editor = document.querySelector("textarea")!;
    Object.defineProperty(editor, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 110,
        bottom: 40,
        width: 100,
        height: 20,
      }),
    });
    const manager = new HighlightManager();
    manager.show(editor, [
      { start: 0, end: 1, text: "x", type: "typo", confidence: 1 },
    ]);
    Object.defineProperty(editor, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 30,
        top: 40,
        right: 130,
        bottom: 60,
        width: 100,
        height: 20,
      }),
    });
    editor.dispatchEvent(new Event("scroll"));
    expect(
      document.querySelector<HTMLElement>(".kotoba-guard-summary")?.style.left,
    ).toBe("58px");
    window.dispatchEvent(new Event("resize"));
    expect(
      document.querySelector<HTMLElement>(".kotoba-guard-overlay")?.style.left,
    ).toBe("30px");
    manager.clear();
  });

  it("does not erase another contenteditable highlight when one is cleared", () => {
    document.body.innerHTML =
      '<div id="one" contenteditable="true">一つ</div><div id="two" contenteditable="true">二つ</div>';
    const one = document.querySelector<HTMLElement>("#one")!;
    const two = document.querySelector<HTMLElement>("#two")!;
    const manager = new HighlightManager();
    const css = CSS as typeof CSS & { highlights?: HighlightRegistry };
    const original = css.highlights;
    const entries = new Map<string, Highlight>();
    Object.defineProperty(css, "highlights", {
      configurable: true,
      value: {
        set: (name: string, value: Highlight) => entries.set(name, value),
        delete: (name: string) => entries.delete(name),
      },
    });
    Object.defineProperty(globalThis, "Highlight", {
      configurable: true,
      value: class {
        readonly ranges: readonly Range[];
        constructor(...ranges: Range[]) {
          this.ranges = ranges;
        }
      },
    });
    manager.show(one, [
      { start: 0, end: 1, text: "一", type: "誤字", confidence: 0.9 },
    ]);
    manager.show(two, [
      { start: 0, end: 1, text: "二", type: "脱字", confidence: 0.8 },
    ]);
    manager.clear(one);
    expect(
      (
        entries.get("kotoba-guard-errors") as unknown as {
          ranges: readonly Range[];
        }
      )?.ranges,
    ).toHaveLength(1);
    manager.clear();
    Object.defineProperty(css, "highlights", {
      configurable: true,
      value: original,
    });
  });

  it("offsets textarea content for internal scroll and copies box typography", () => {
    document.body.innerHTML = '<textarea id="editor"></textarea>';
    const editor = document.querySelector<HTMLTextAreaElement>("#editor")!;
    editor.value = "長い文章の内容";
    editor.style.cssText =
      "box-sizing: border-box; border: 4px solid red; padding: 8px 10px; font: 16px serif; letter-spacing: 2px; text-indent: 3px;";
    Object.defineProperties(editor, {
      scrollLeft: { configurable: true, value: 17 },
      scrollTop: { configurable: true, value: 23 },
      scrollWidth: { configurable: true, value: 640 },
      scrollHeight: { configurable: true, value: 480 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          left: 20,
          top: 30,
          right: 220,
          bottom: 130,
          width: 200,
          height: 100,
        }),
      },
    });
    editor.setSelectionRange(2, 4);
    const before = {
      value: editor.value,
      start: editor.selectionStart,
      end: editor.selectionEnd,
    };
    const manager = new HighlightManager();
    manager.show(editor, [
      { start: 2, end: 4, text: "文章", type: "typo", confidence: 0.9 },
    ]);
    const overlay = document.querySelector<HTMLElement>(
      ".kotoba-guard-overlay",
    )!;
    const content = overlay.firstElementChild as HTMLElement;
    expect(overlay.style.left).toBe("24px");
    expect(overlay.style.top).toBe("34px");
    expect(content.style.transform).toBe("translate(-17px, -23px)");
    expect(content.style.letterSpacing).toBe("2px");
    expect(content.style.textIndent).toBe("3px");
    expect(content.style.boxSizing).toBe("border-box");
    expect({
      value: editor.value,
      start: editor.selectionStart,
      end: editor.selectionEnd,
    }).toEqual(before);
    manager.clear();
  });

  it("shows the shared Japanese label for kanji conversion errors", () => {
    document.body.innerHTML = '<textarea id="editor"></textarea>';
    const editor = document.querySelector<HTMLTextAreaElement>("#editor")!;
    editor.value = "漢字";
    const manager = new HighlightManager();
    manager.show(editor, [
      {
        start: 0,
        end: 1,
        text: "漢",
        type: "kanji-conversion_a",
        confidence: 0.9,
      },
    ]);
    expect(
      document.querySelector<HTMLElement>(".kotoba-guard-mark")?.title,
    ).toBe("検出: 漢字変換 (90%)");
    expect(
      document.querySelector<HTMLElement>(".kotoba-guard-summary-status")
        ?.textContent,
    ).toBe("漢字変換の可能性 (90%)");
    manager.clear();
  });

  it("keeps details collapsed until requested and supports Escape dismissal", () => {
    document.body.innerHTML = '<textarea id="editor"></textarea>';
    const editor = document.querySelector<HTMLTextAreaElement>("#editor")!;
    editor.value = "誤字";
    Object.defineProperty(editor, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 20,
        top: 100,
        right: 220,
        bottom: 130,
        width: 200,
        height: 30,
      }),
    });
    const manager = new HighlightManager();
    manager.show(editor, [
      { start: 0, end: 1, text: "誤", type: "typo", confidence: 0.9 },
    ]);
    const summary = document.querySelector<HTMLElement>(
      ".kotoba-guard-summary",
    )!;
    const trigger = summary.querySelector<HTMLButtonElement>(
      ".kotoba-guard-summary-trigger",
    )!;
    const details = summary.querySelector<HTMLElement>(
      ".kotoba-guard-summary-details",
    )!;
    expect(trigger.textContent).toBe("検出 1件");
    expect(summary.style.left).toBe("148px");
    expect(summary.style.top).toBe("70px");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(details.hidden).toBe(true);
    expect(
      summary.querySelector(".kotoba-guard-summary-status")?.textContent,
    ).toBe("誤字の可能性 (90%)");
    trigger.click();
    expect(details.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(details.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    manager.clear();
  });

  it("keeps detail IDs unique when an editor is cleared and shown again", () => {
    document.body.innerHTML =
      '<textarea id="one"></textarea><textarea id="two"></textarea>';
    const one = document.querySelector<HTMLTextAreaElement>("#one")!;
    const two = document.querySelector<HTMLTextAreaElement>("#two")!;
    const manager = new HighlightManager();
    const detection = [
      { start: 0, end: 1, text: "誤", type: "typo", confidence: 0.9 },
    ];
    manager.show(one, detection);
    const firstId = document.querySelector<HTMLElement>(
      ".kotoba-guard-summary-details",
    )!.id;
    manager.show(two, detection);
    manager.clear(one);
    manager.show(one, detection);
    const details = [
      ...document.querySelectorAll<HTMLElement>(
        ".kotoba-guard-summary-details",
      ),
    ];
    const ids = details.map((detail) => detail.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain(firstId);
    expect(
      details.every(
        (detail) =>
          detail.previousElementSibling?.getAttribute("aria-controls") ===
          detail.id,
      ),
    ).toBe(true);
    manager.clear();
  });
});
