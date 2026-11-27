export type NativeHighlightRangeSnapshot = {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly visible: boolean;
};

export type NativeHighlightSnapshot = {
  readonly ranges: readonly NativeHighlightRangeSnapshot[];
  readonly visible: boolean;
};

/**
 * Read the browser's CSS Highlight registry without relying on overlay marks.
 * The function is intentionally self-contained so it can be passed directly
 * to Locator.evaluate in a real browser.
 */
export function snapshotNativeHighlights(
  editor: Element,
): NativeHighlightSnapshot {
  type HighlightRangeLike = {
    readonly startContainer: Node;
    readonly startOffset: number;
    readonly endContainer: Node;
    readonly endOffset: number;
    readonly getClientRects?: () => DOMRectList | readonly DOMRect[];
    readonly toString: () => string;
  };
  type HighlightRegistryLike = {
    get: (name: string) => Iterable<HighlightRangeLike> | undefined;
  };
  type CssWithHighlights = { highlights?: HighlightRegistryLike };

  const css = (globalThis as unknown as { CSS?: CssWithHighlights }).CSS;
  const highlight = css?.highlights?.get("kotoba-guard-errors");
  if (highlight === undefined) return { ranges: [], visible: false };

  const offsetWithinEditor = (
    container: Node,
    offset: number,
  ): number | undefined => {
    if (container !== editor && !editor.contains(container)) return undefined;
    const prefix = document.createRange();
    try {
      prefix.selectNodeContents(editor);
      prefix.setEnd(container, offset);
      return prefix.toString().length;
    } catch {
      return undefined;
    }
  };

  const isVisible = (range: HighlightRangeLike): boolean => {
    if (typeof range.getClientRects !== "function") return false;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    return Array.from(range.getClientRects()).some(
      (rect) =>
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < viewportWidth &&
        rect.top < viewportHeight,
    );
  };

  const ranges: NativeHighlightRangeSnapshot[] = [];
  for (const range of highlight) {
    const start = offsetWithinEditor(range.startContainer, range.startOffset);
    const end = offsetWithinEditor(range.endContainer, range.endOffset);
    if (start === undefined || end === undefined || end < start) continue;
    ranges.push({
      text: range.toString(),
      start,
      end,
      visible: isVisible(range),
    });
  }
  return {
    ranges,
    visible: ranges.some((range) => range.visible),
  };
}
