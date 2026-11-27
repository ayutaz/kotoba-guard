import { describe, expect, it } from "vitest";
import { inputLength, makeTokenChunks } from "../src/index.js";
import type { TokenizerAdapter } from "../src/index.js";

function fakeTokenizer(): TokenizerAdapter {
  return {
    encode(text, options = {}) {
      const ids = Array.from(text, (_, index) => index + 1);
      const offsets = ids.map(
        (_, index) => [index, index + 1] as [number, number],
      );
      if (options.addSpecialTokens === false)
        return { inputIds: ids, offsets, offsetUnit: "utf16" };
      return {
        inputIds: [101, ...ids, 102],
        attentionMask: [1, ...ids.map(() => 1), 1],
        specialTokensMask: [1, ...ids.map(() => 0), 1],
        offsets: [[0, 0], ...offsets, [0, 0]],
        offsetUnit: "utf16",
      };
    },
  };
}

describe("token chunks", () => {
  it("bounds long input and preserves UTF-16 boundaries", async () => {
    const chunks = await makeTokenChunks("abcdef", fakeTokenizer(), 5, 1);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["abc", "cde", "ef"]);
    expect(chunks.map((chunk) => [chunk.start, chunk.end])).toEqual([
      [0, 3],
      [2, 5],
      [4, 6],
    ]);
  });

  it("does not tokenize empty input", async () => {
    expect(await makeTokenChunks("", fakeTokenizer(), 8, 1)).toEqual([]);
  });

  it("rejects mismatched IDs even when the tokenizer returns no offsets", async () => {
    const tokenizer: TokenizerAdapter = {
      encode: () => ({ inputIds: [1], offsets: [] }),
    };
    await expect(makeTokenChunks("a", tokenizer, 8, 0)).rejects.toThrow(
      /offsets and input IDs/,
    );
  });

  it("rejects a short encoding that expands beyond the configured limit", async () => {
    const tokenizer: TokenizerAdapter = {
      encode(text, options = {}) {
        if (options.addSpecialTokens === false)
          return {
            inputIds: [1, 2],
            offsets: [
              [0, 1],
              [1, 2],
            ],
          };
        return {
          inputIds: [101, 1, 2, 3, 102],
          offsets: [
            [0, 0],
            [0, 1],
            [1, 2],
            [1, 2],
            [0, 0],
          ],
        };
      },
    };
    await expect(makeTokenChunks("ab", tokenizer, 4, 0)).rejects.toThrow(
      /maxTokens/,
    );
  });

  it("keeps byte fallback spans together and stays within the model limit", async () => {
    const tokenizer: TokenizerAdapter = {
      encode(text, options = {}) {
        const ids: number[] = [];
        const offsets: [number, number][] = [];
        for (let index = 0; index < text.length;) {
          const isEmoji = text.startsWith("😀", index);
          const width = isEmoji ? 2 : 1;
          const bytes = isEmoji ? 4 : 1;
          for (let byte = 0; byte < bytes; byte += 1) {
            ids.push(index * 10 + byte + 1);
            offsets.push([index, index + width]);
          }
          index += width;
        }
        if (options.addSpecialTokens === false)
          return { inputIds: ids, offsets };
        return {
          inputIds: [101, ...ids, 102],
          attentionMask: [1, ...ids.map(() => 1), 1],
          specialTokensMask: [1, ...ids.map(() => 0), 1],
          offsets: [[0, 0], ...offsets, [0, 0]],
        };
      },
    };
    const chunks = await makeTokenChunks("A😀BCDE", tokenizer, 8, 1);
    expect(chunks.every((chunk) => inputLength(chunk.encoding) <= 8)).toBe(
      true,
    );
    expect(chunks[0]?.start).toBe(0);
    expect(chunks.at(-1)?.end).toBe("A😀BCDE".length);
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index]?.start).toBeLessThanOrEqual(
        chunks[index - 1]?.end ?? 0,
      );
    }
  });

  it("rejects a byte fallback span that cannot fit in one model window", async () => {
    const tokenizer: TokenizerAdapter = {
      encode(text, options = {}) {
        const ids = [11, 12, 13, 14];
        const offsets = ids.map(() => [0, text.length] as [number, number]);
        if (options.addSpecialTokens === false)
          return { inputIds: ids, offsets };
        return {
          inputIds: [101, ...ids, 102],
          offsets: [[0, 0], ...offsets, [0, 0]],
        };
      },
    };
    await expect(makeTokenChunks("😀", tokenizer, 5, 0)).rejects.toThrow(
      RangeError,
    );
  });

  it("shrinks re-tokenized slices without exceeding the limit or skipping text", async () => {
    const tokenizer: TokenizerAdapter = {
      encode(text, options = {}) {
        const ids: number[] = [];
        const offsets: [number, number][] = [];
        for (let index = 0; index < text.length; index += 1) {
          const copies =
            text[index] === "b" && options.addSpecialTokens !== false ? 2 : 1;
          for (let copy = 0; copy < copies; copy += 1) {
            ids.push(index * 10 + copy + 1);
            offsets.push([index, index + 1]);
          }
        }
        if (options.addSpecialTokens === false) {
          return { inputIds: ids, offsets };
        }
        return {
          inputIds: [101, ...ids, 102],
          offsets: [[0, 0], ...offsets, [0, 0]],
        };
      },
    };
    const text = "abcd";
    const chunks = await makeTokenChunks(text, tokenizer, 5, 1);
    expect(chunks.every((chunk) => inputLength(chunk.encoding) <= 5)).toBe(
      true,
    );
    expect(chunks[0]?.start).toBe(0);
    expect(chunks.at(-1)?.end).toBe(text.length);
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index]?.start).toBeLessThanOrEqual(
        chunks[index - 1]?.end ?? 0,
      );
    }
  });
});
