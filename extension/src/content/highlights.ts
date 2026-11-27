import type { Detection } from "../shared/types";

const HIGHLIGHT_PREFIX = "kotoba-guard-";
const OVERLAY_CLASS = "kotoba-guard-overlay";
const STYLE_ID = "kotoba-guard-highlight-style";

function typeLabel(type: string): string {
  const normalized = type.trim().toLowerCase();
  if (/(?:deletion|omission|missing|脱字)/u.test(normalized)) return "脱字";
  if (/(?:insertion|extra|redundant|余分)/u.test(normalized))
    return "余分な文字";
  if (/(?:duplication|duplicate|repeat|重複)/u.test(normalized)) return "重複";
  if (/(?:substitution|replacement|replace|置換)/u.test(normalized))
    return "置換";
  if (/(?:transposition|reorder|order|順序)/u.test(normalized))
    return "順序誤り";
  if (/kanji[-_ ]?conversion|漢字変換/u.test(normalized)) return "漢字変換";
  if (/(?:typo|misspelling|spelling|誤字)/u.test(normalized)) return "誤字";
  return "誤り";
}

type TextPoint = { readonly node: Text; readonly offset: number };

function pointAt(root: Node, offset: number): TextPoint | undefined {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cursor = 0;
  let current = walker.nextNode();
  while (current) {
    const text = current.textContent ?? "";
    if (offset <= cursor + text.length)
      return { node: current as Text, offset: Math.max(0, offset - cursor) };
    cursor += text.length;
    current = walker.nextNode();
  }
  return undefined;
}

function appendTextParts(
  parent: HTMLElement,
  text: string,
  detections: readonly Detection[],
): void {
  let cursor = 0;
  for (const detection of detections) {
    const start = Math.max(cursor, detection.start);
    const end = Math.min(text.length, Math.max(start, detection.end));
    if (start > cursor)
      parent.append(document.createTextNode(text.slice(cursor, start)));
    if (end > start) {
      const mark = document.createElement("span");
      mark.className = "kotoba-guard-mark";
      mark.textContent = text.slice(start, end);
      mark.title = `検出: ${typeLabel(detection.type)} (${Math.round(detection.confidence * 100)}%)`;
      parent.append(mark);
    }
    cursor = end;
  }
  if (cursor < text.length)
    parent.append(document.createTextNode(text.slice(cursor)));
}

export class HighlightManager {
  private summaryId = 0;
  private readonly nativeRanges = new Map<Element, readonly Range[]>();
  private readonly overlays = new Map<Element, HTMLElement>();
  private readonly summaries = new Map<Element, HTMLElement>();
  private readonly reposition = (): void => {
    for (const [element, overlay] of this.overlays)
      this.positionOverlay(element, overlay);
    for (const [element, summary] of this.summaries)
      this.positionSummary(element, summary);
  };

  private ensureStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${OVERLAY_CLASS} { }
      .kotoba-guard-mark {
        background: rgba(238, 76, 76, .22);
        color: transparent;
        text-decoration: underline wavy #d22;
        text-decoration-thickness: 2px;
      }
      .kotoba-guard-summary {
        position: fixed;
        z-index: 2147483647;
        pointer-events: auto;
        color: CanvasText;
        font: 12px sans-serif;
      }
      .kotoba-guard-summary-trigger {
        min-width: 3.5rem;
        min-height: 1.5rem;
        padding: 2px 6px;
        border: 1px solid #d22;
        border-radius: 4px;
        background: Canvas;
        color: CanvasText;
        font: inherit;
        cursor: pointer;
      }
      .kotoba-guard-summary-trigger:focus-visible {
        outline: 2px solid Highlight;
        outline-offset: 2px;
      }
      .kotoba-guard-summary-details {
        position: absolute;
        top: calc(100% + 2px);
        right: 0;
        width: max-content;
        max-width: min(28rem, 90vw);
        max-height: min(12rem, 40vh);
        overflow: auto;
        padding: 4px 6px;
        border: 1px solid #d22;
        border-radius: 4px;
        background: Canvas;
        color: CanvasText;
        white-space: normal;
      }
      .kotoba-guard-summary-status {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
      }
      ::highlight(${HIGHLIGHT_PREFIX}errors) {
        background-color: rgba(238, 76, 76, .22);
        text-decoration: underline wavy #d22;
        text-decoration-thickness: 2px;
      }
    `;
    document.head?.append(style);
  }

  private positionOverlay(element: Element, overlay: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    const borderLeft = Number.parseFloat(computed.borderLeftWidth) || 0;
    const borderRight = Number.parseFloat(computed.borderRightWidth) || 0;
    const borderTop = Number.parseFloat(computed.borderTopWidth) || 0;
    const borderBottom = Number.parseFloat(computed.borderBottomWidth) || 0;
    const scrollable = element as HTMLElement;
    const fallbackWidth = Math.max(0, rect.width - borderLeft - borderRight);
    const fallbackHeight = Math.max(0, rect.height - borderTop - borderBottom);
    const viewportWidth = scrollable.clientWidth || fallbackWidth;
    const viewportHeight = scrollable.clientHeight || fallbackHeight;
    Object.assign(overlay.style, {
      left: `${rect.left + borderLeft}px`,
      top: `${rect.top + borderTop}px`,
      width: `${viewportWidth}px`,
      height: `${viewportHeight}px`,
    });
    const content = overlay.firstElementChild as HTMLElement | null;
    if (!content) return;
    Object.assign(content.style, {
      left: "0px",
      top: "0px",
      transform: `translate(${-scrollable.scrollLeft}px, ${-scrollable.scrollTop}px)`,
      width: `${Math.max(scrollable.scrollWidth, viewportWidth)}px`,
      minHeight: `${Math.max(scrollable.scrollHeight, viewportHeight)}px`,
      font: computed.font,
      lineHeight: computed.lineHeight,
      letterSpacing: computed.letterSpacing,
      textIndent: computed.textIndent,
      wordSpacing: computed.wordSpacing,
      textTransform: computed.textTransform,
      whiteSpace:
        element instanceof HTMLInputElement ? "pre" : computed.whiteSpace,
      wordBreak:
        element instanceof HTMLInputElement ? "normal" : computed.wordBreak,
      overflowWrap:
        element instanceof HTMLInputElement ? "normal" : computed.overflowWrap,
      padding: computed.padding,
      boxSizing: "border-box",
    });
  }

  private positionSummary(element: Element, summary: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    const compactHeight = 26;
    const gap = 4;
    const preferredTop = rect.top - compactHeight - gap;
    const fallbackTop = Math.min(
      Math.max(gap, rect.bottom + gap),
      Math.max(gap, window.innerHeight - compactHeight - gap),
    );
    const compactWidth = summary.getBoundingClientRect().width || 72;
    const maxLeft = Math.max(gap, window.innerWidth - compactWidth - gap);
    const rightAlignedLeft = rect.right - compactWidth;
    Object.assign(summary.style, {
      left: `${Math.min(Math.max(gap, rightAlignedLeft), maxLeft)}px`,
      top: `${preferredTop >= gap ? preferredTop : fallbackTop}px`,
    });
  }

  clear(element?: Element): void {
    const elements = element
      ? [element]
      : [
          ...new Set([
            ...this.nativeRanges.keys(),
            ...this.overlays.keys(),
            ...this.summaries.keys(),
          ]),
        ];
    for (const target of elements) {
      this.nativeRanges.delete(target);
      this.overlays.get(target)?.remove();
      target.removeEventListener("scroll", this.reposition, true);
      this.overlays.delete(target);
      this.summaries.get(target)?.remove();
      this.summaries.delete(target);
    }
    this.rebuildNativeHighlights();
    if (this.overlays.size === 0 && this.summaries.size === 0) {
      window.removeEventListener("scroll", this.reposition, true);
      window.removeEventListener("resize", this.reposition);
    }
  }

  private rebuildNativeHighlights(): void {
    if (typeof CSS === "undefined" || !("highlights" in CSS) || !CSS.highlights)
      return;
    CSS.highlights.delete(`${HIGHLIGHT_PREFIX}errors`);
    const ranges = [...this.nativeRanges.values()].flatMap((value) => value);
    if (ranges.length > 0)
      CSS.highlights.set(`${HIGHLIGHT_PREFIX}errors`, new Highlight(...ranges));
  }

  show(
    element: HTMLTextAreaElement | HTMLInputElement | HTMLElement,
    detections: readonly Detection[],
  ): void {
    this.clear(element);
    if (detections.length === 0 || !document.body) return;
    this.ensureStyles();
    const summary = document.createElement("div");
    summary.className = "kotoba-guard-summary";
    const detailsText = detections
      .map(
        (detection) =>
          `${typeLabel(detection.type)}の可能性 (${Math.round(detection.confidence * 100)}%)`,
      )
      .join("、");
    const details = document.createElement("div");
    details.className = "kotoba-guard-summary-details";
    details.hidden = true;
    details.textContent = detailsText;
    const detailsId = `kotoba-guard-summary-details-${++this.summaryId}`;
    details.id = detailsId;
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "kotoba-guard-summary-trigger";
    trigger.textContent = `検出 ${detections.length}件`;
    trigger.title = "検出の詳細を表示";
    trigger.setAttribute("aria-label", detailsText);
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", detailsId);
    const status = document.createElement("span");
    status.className = "kotoba-guard-summary-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = detailsText;
    const setExpanded = (expanded: boolean): void => {
      details.hidden = !expanded;
      trigger.setAttribute("aria-expanded", String(expanded));
    };
    trigger.addEventListener("click", () =>
      setExpanded(Boolean(details.hidden)),
    );
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !details.hidden) {
        event.preventDefault();
        setExpanded(false);
      }
    });
    summary.append(trigger, details, status);
    document.body.append(summary);
    this.summaries.set(element, summary);
    this.positionSummary(element, summary);
    element.addEventListener("scroll", this.reposition, true);
    window.addEventListener("scroll", this.reposition, true);
    window.addEventListener("resize", this.reposition);
    const contentEditable =
      element instanceof HTMLElement &&
      (element.isContentEditable ||
        element.getAttribute("contenteditable") === "true" ||
        element.getAttribute("contenteditable") === "plaintext-only" ||
        element.getAttribute("contenteditable") === "");
    if (
      contentEditable &&
      typeof CSS !== "undefined" &&
      "highlights" in CSS &&
      Boolean(CSS.highlights) &&
      typeof Highlight !== "undefined"
    ) {
      const ranges: Range[] = [];
      const contentLength = (element.textContent ?? "").length;
      for (const detection of detections) {
        const start = Math.max(0, Math.min(contentLength, detection.start));
        const end = Math.max(start, Math.min(contentLength, detection.end));
        const from = pointAt(element, start);
        const to = pointAt(element, end);
        if (!from || !to || end <= start) continue;
        const range = new Range();
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
        ranges.push(range);
      }
      if (ranges.length > 0) {
        this.nativeRanges.set(element, ranges);
        this.rebuildNativeHighlights();
      }
      return;
    }
    const overlay = document.createElement("div");
    overlay.className = OVERLAY_CLASS;
    overlay.setAttribute("aria-hidden", "true");
    Object.assign(overlay.style, {
      position: "fixed",
      overflow: "hidden",
      pointerEvents: "none",
      zIndex: "2147483646",
      color: "transparent",
      background: "transparent",
      border: "0",
    });
    const content = document.createElement("div");
    content.style.position = "absolute";
    const text =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
        ? element.value
        : (element.textContent ?? "");
    appendTextParts(content, text, detections);
    overlay.append(content);
    document.body.append(overlay);
    this.overlays.set(element, overlay);
    this.positionOverlay(element, overlay);
  }
}
