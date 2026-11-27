import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotNativeHighlights } from "../e2e/native-highlights";

type Registry = {
  get: (name: string) => Iterable<Range> | undefined;
};

let previousCss: unknown;

function installRegistry(ranges: Iterable<Range> | undefined): void {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value:
      ranges === undefined
        ? { highlights: undefined }
        : {
            highlights: {
              get: (name: string) =>
                name === "kotoba-guard-errors" ? ranges : undefined,
            } satisfies Registry,
          },
  });
}

function rangeFor(
  editor: Element,
  start: number,
  end: number,
  rect: Partial<DOMRect>,
): Range {
  const text = editor.firstChild;
  if (!(text instanceof Text)) throw new Error("fixture text node missing");
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  Object.defineProperty(range, "getClientRects", {
    configurable: true,
    value: () => [
      {
        left: 10,
        top: 10,
        right: 80,
        bottom: 30,
        width: 70,
        height: 20,
        ...rect,
      },
    ],
  });
  return range;
}

beforeEach(() => {
  previousCss = (globalThis as unknown as { CSS?: unknown }).CSS;
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: 800 },
    innerHeight: { configurable: true, value: 600 },
  });
});

afterEach(() => {
  if (previousCss === undefined) delete (globalThis as { CSS?: unknown }).CSS;
  else
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: previousCss,
    });
  document.body.innerHTML = "";
});

describe("snapshotNativeHighlights", () => {
  it("reads a scoped native range with UTF-16 offsets without requiring a mark span", () => {
    document.body.innerHTML =
      '<div id="editor" contenteditable="true">明日の予定については、来週移行にご連絡します。</div>';
    const editor = document.querySelector("#editor")!;
    const text = editor.textContent!;
    const start = text.indexOf("移行");
    installRegistry([rangeFor(editor, start, start + 2, {})]);

    expect(snapshotNativeHighlights(editor)).toEqual({
      ranges: [{ text: "移行", start, end: start + 2, visible: true }],
      visible: true,
    });
    expect(editor.querySelector(".kotoba-guard-mark")).toBeNull();
  });

  it("filters ranges belonging to another editor", () => {
    document.body.innerHTML =
      '<div id="editor" contenteditable="true">移行</div><div id="other">移行</div>';
    const editor = document.querySelector("#editor")!;
    const other = document.querySelector("#other")!;
    installRegistry([rangeFor(editor, 0, 2, {}), rangeFor(other, 0, 2, {})]);

    expect(snapshotNativeHighlights(editor).ranges).toHaveLength(1);
  });

  it("counts surrogate pairs across nested text without changing DOM or selection", () => {
    document.body.innerHTML =
      '<div id="editor" contenteditable="true">😀<b>移</b><i>行</i>に連絡</div>';
    const editor = document.querySelector("#editor")!;
    const first = editor.querySelector("b")!.firstChild!;
    const second = editor.querySelector("i")!.firstChild!;
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(second, 1);
    Object.defineProperty(range, "getClientRects", {
      value: () => [new DOMRect(10, 10, 20, 20)],
    });
    installRegistry([range]);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range.cloneRange());
    const before = { html: editor.innerHTML, selected: selection.toString() };

    expect(snapshotNativeHighlights(editor)).toEqual({
      ranges: [{ text: "移行", start: 2, end: 4, visible: true }],
      visible: true,
    });
    expect({ html: editor.innerHTML, selected: selection.toString() }).toEqual(
      before,
    );
  });

  it("reports missing registry and non-visible ranges as not visible", () => {
    document.body.innerHTML = '<div id="editor">移行</div>';
    const editor = document.querySelector("#editor")!;
    installRegistry(undefined);
    expect(snapshotNativeHighlights(editor)).toEqual({
      ranges: [],
      visible: false,
    });

    installRegistry([
      rangeFor(editor, 0, 2, { width: 0, height: 0 }),
      rangeFor(editor, 0, 2, { top: 700, bottom: 720 }),
    ]);
    expect(snapshotNativeHighlights(editor)).toMatchObject({ visible: false });
    expect(
      snapshotNativeHighlights(editor).ranges.every((range) => !range.visible),
    ).toBe(true);
  });
});
