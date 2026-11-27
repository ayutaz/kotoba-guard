import { describe, expect, it } from "vitest";
import {
  codePointOffsetToUtf16,
  normalizeOffset,
  overlaps,
  shiftOffset,
} from "../src/index.js";
import {
  expandByteFallback,
  offsetsFromTokenPieces,
} from "../src/tokenizer.js";

describe("offset conversion", () => {
  it("converts code-point offsets for astral emoji", () => {
    const text = "A😀B";
    expect(codePointOffsetToUtf16(text, 1)).toBe(1);
    expect(codePointOffsetToUtf16(text, 2)).toBe(3);
    expect(normalizeOffset(text, [1, 2], "codepoint")).toEqual([1, 3]);
    expect(text.slice(...normalizeOffset(text, [1, 2], "codepoint"))).toBe(
      "😀",
    );
  });

  it("rejects offsets beyond the input", () => {
    expect(() => normalizeOffset("abc", [0, 4])).toThrow(RangeError);
    expect(() => codePointOffsetToUtf16("abc", 4)).toThrow(RangeError);
    expect(() => codePointOffsetToUtf16("abc", -1)).toThrow(RangeError);
    expect(() => normalizeOffset("abc", [2, 1])).toThrow(RangeError);
  });

  it("shifts and compares half-open UTF-16 spans", () => {
    expect(shiftOffset([1, 3], 2)).toEqual([3, 5]);
    expect(() => shiftOffset([1, 3], -1)).toThrow(RangeError);
    expect(overlaps([1, 3], [2, 4])).toBe(true);
    expect(overlaps([1, 3], [3, 4])).toBe(false);
  });

  it("aligns ordered Metaspace pieces without global substring search", () => {
    const text = "こんにちは 世界😀";
    const offsets = offsetsFromTokenPieces(text, [
      "こんにちは",
      "▁",
      "世界",
      "😀",
    ]);
    expect(offsets.map(([start, end]) => text.slice(start, end))).toEqual([
      "こんにちは",
      " ",
      "世界",
      "😀",
    ]);
  });

  it("represents empty tokenizer pieces without losing cursor validation", () => {
    expect(offsetsFromTokenPieces("", [""])).toEqual([[0, 0]]);
    expect(() => offsetsFromTokenPieces("a", [""])).toThrow(/consumed/);
  });

  it("fails closed when tokenizer normalization changes text", () => {
    expect(() => offsetsFromTokenPieces("Ａ", ["A"])).toThrow(/normalization/);
  });

  it("expands unknown UTF-8 spans into official byte fallback IDs", () => {
    const ids = new Map([
      ["<0xF0>", 255],
      ["<0x9F>", 174],
      ["<0x98>", 167],
      ["<0x80>", 143],
    ]);
    const result = expandByteFallback("😀", [0], [[0, 2]], {
      unk_token_id: 0,
      convert_tokens_to_ids: (tokens) => tokens.map((token) => ids.get(token)),
    });
    expect(result.inputIds).toEqual([255, 174, 167, 143]);
    expect(result.offsets).toEqual([
      [0, 2],
      [0, 2],
      [0, 2],
      [0, 2],
    ]);
  });
});
