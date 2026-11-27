import type { OffsetUnit, TokenOffset } from "./types.js";

/** Convert a code-point offset (the unit used by Rust tokenizers) to a JS offset. */
export function codePointOffsetToUtf16(text: string, offset: number): number {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(`Invalid code-point offset: ${offset}`);
  }
  let index = 0;
  let codePoints = 0;
  for (const character of text) {
    if (codePoints >= offset) return index;
    index += character.length;
    codePoints += 1;
  }
  if (codePoints === offset) return index;
  throw new RangeError(`Offset ${offset} exceeds text length in code points`);
}

export function normalizeOffset(
  text: string,
  offset: TokenOffset,
  unit: OffsetUnit = "utf16",
): TokenOffset {
  const [start, end] = offset;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start
  ) {
    throw new RangeError(`Invalid token offset [${start}, ${end}]`);
  }
  if (unit === "codepoint") {
    return [
      codePointOffsetToUtf16(text, start),
      codePointOffsetToUtf16(text, end),
    ];
  }
  if (end > text.length)
    throw new RangeError(`UTF-16 offset ${end} exceeds text length`);
  return [start, end];
}

export function shiftOffset(offset: TokenOffset, shift: number): TokenOffset {
  if (!Number.isInteger(shift) || shift < 0)
    throw new RangeError("Offset shift must be non-negative");
  return [offset[0] + shift, offset[1] + shift];
}

export function overlaps(a: TokenOffset, b: TokenOffset): boolean {
  return a[0] < b[1] && b[0] < a[1];
}
