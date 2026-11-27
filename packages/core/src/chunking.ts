import { normalizeOffset } from "./offsets.js";
import type {
  TokenOffset,
  TokenizerAdapter,
  TokenizerEncoding,
} from "./types.js";

export interface TokenChunk {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly encoding: TokenizerEncoding;
}

function ordinaryOffsets(
  text: string,
  encoding: TokenizerEncoding,
): TokenOffset[] {
  const unit = encoding.offsetUnit ?? "utf16";
  return encoding.offsets.map((offset) => normalizeOffset(text, offset, unit));
}

function sameSpan(left: TokenOffset, right: TokenOffset): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

/** Keep a byte-fallback group together when a token window reaches its edge. */
function alignBoundary(
  offsets: readonly TokenOffset[],
  first: number,
  last: number,
): [number, number] {
  let alignedFirst = first;
  while (alignedFirst > 0) {
    const current = offsets[alignedFirst];
    const previous = offsets[alignedFirst - 1];
    if (!current || !previous || !sameSpan(current, previous)) break;
    alignedFirst -= 1;
  }
  const endSpan = offsets[last - 1];
  if (!endSpan) throw new Error("Tokenizer produced an invalid chunk boundary");
  let endGroupStart = last - 1;
  while (
    endGroupStart > alignedFirst &&
    offsets[endGroupStart - 1] &&
    sameSpan(offsets[endGroupStart - 1]!, endSpan)
  ) {
    endGroupStart -= 1;
  }
  let endGroupEnd = last;
  while (
    endGroupEnd < offsets.length &&
    offsets[endGroupEnd] &&
    sameSpan(offsets[endGroupEnd]!, endSpan)
  ) {
    endGroupEnd += 1;
  }
  const alignedLast = endGroupEnd > last ? endGroupStart : last;
  if (alignedLast === alignedFirst) {
    throw new RangeError(
      "A single source span expands beyond the configured token chunk capacity",
    );
  }
  return [alignedFirst, alignedLast];
}

/**
 * Tokenize once to select stable boundaries, then re-tokenize each bounded slice
 * with special tokens. No substring search is used for alignment.
 */
export async function makeTokenChunks(
  text: string,
  tokenizer: TokenizerAdapter,
  maxTokens: number,
  overlapTokens: number,
): Promise<TokenChunk[]> {
  if (!Number.isInteger(maxTokens) || maxTokens < 3)
    throw new RangeError("maxTokens must be at least 3");
  if (
    !Number.isInteger(overlapTokens) ||
    overlapTokens < 0 ||
    overlapTokens >= maxTokens - 2
  ) {
    throw new RangeError("overlapTokens must be less than maxTokens - 2");
  }
  if (text.length === 0) return [];

  const all = await tokenizer.encode(text, { addSpecialTokens: false });
  const offsets = ordinaryOffsets(text, all);
  if (offsets.length !== inputLength(all)) {
    throw new Error(
      "Tokenizer returned a different number of offsets and input IDs",
    );
  }
  if (offsets.length === 0) return [];
  const capacity = maxTokens - 2;
  if (offsets.length <= capacity) {
    const encoding = await tokenizer.encode(text, {
      addSpecialTokens: true,
      maxLength: maxTokens,
    });
    validateEncoding(text, encoding, maxTokens);
    return [{ text, start: 0, end: text.length, encoding }];
  }

  const chunks: TokenChunk[] = [];
  let first = 0;
  while (first < offsets.length) {
    let candidateLast = Math.min(first + capacity, offsets.length);
    let alignedFirst: number;
    let last: number;
    let relative: TokenizerEncoding;
    while (true) {
      [alignedFirst, last] = alignBoundary(offsets, first, candidateLast);
      const candidateFirstOffset = offsets[alignedFirst];
      const candidateLastOffset = offsets[last - 1];
      if (!candidateFirstOffset || !candidateLastOffset)
        throw new Error("Tokenizer produced an invalid chunk boundary");
      const candidateSlice = text.slice(
        candidateFirstOffset[0],
        candidateLastOffset[1],
      );
      relative = await tokenizer.encode(candidateSlice, {
        addSpecialTokens: true,
        maxLength: maxTokens,
      });
      validateEncoding(candidateSlice, relative, maxTokens, false);
      if (inputLength(relative) <= maxTokens) break;

      // The initial tokenization can undercount a byte-fallback or otherwise
      // expanded span. Move the source boundary back by one complete span and
      // retry; the next chunk starts from the actual accepted token boundary,
      // so no source characters are skipped.
      const endSpan = offsets[last - 1];
      if (!endSpan)
        throw new Error("Tokenizer produced an invalid chunk boundary");
      let reducedLast = last - 1;
      while (
        reducedLast > alignedFirst &&
        offsets[reducedLast - 1] &&
        sameSpan(offsets[reducedLast - 1]!, endSpan)
      ) {
        reducedLast -= 1;
      }
      if (reducedLast <= alignedFirst) {
        throw new RangeError(
          "A re-tokenized source span expands beyond the configured token chunk capacity",
        );
      }
      candidateLast = reducedLast;
    }
    const firstOffset = offsets[alignedFirst];
    const lastOffset = offsets[last - 1];
    if (!firstOffset || !lastOffset)
      throw new Error("Tokenizer produced an invalid chunk boundary");
    const start = firstOffset[0];
    const end = lastOffset[1];
    if (end <= start) throw new Error("Tokenizer produced an empty chunk span");
    const slice = text.slice(start, end);
    chunks.push({ text: slice, start, end, encoding: relative });
    if (last === offsets.length) break;
    first = Math.max(last - overlapTokens, first + 1);
  }
  return chunks;
}

export function inputLength(encoding: TokenizerEncoding): number {
  return Array.from(encoding.inputIds as ArrayLike<number | bigint>).length;
}

function validateEncoding(
  text: string,
  encoding: TokenizerEncoding,
  maxTokens: number,
  enforceLimit = true,
): void {
  const length = inputLength(encoding);
  if (encoding.offsets.length !== length)
    throw new Error("Tokenizer offsets do not match input IDs");
  if (enforceLimit && length > maxTokens)
    throw new RangeError("Tokenizer encoding exceeds maxTokens");
  for (const offset of encoding.offsets) {
    if (!offset) throw new Error("Tokenizer returned a missing token offset");
    normalizeOffset(text, offset, encoding.offsetUnit ?? "utf16");
  }
}
