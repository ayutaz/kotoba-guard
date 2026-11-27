import { AutoTokenizer } from "@huggingface/transformers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTransformersTokenizer,
  expandByteFallback,
} from "../src/tokenizer.js";

type FakeTokenizer = ((
  text: string,
  options: { add_special_tokens?: boolean },
) => Promise<{ input_ids: number[] }>) & {
  tokenize: (
    text: string,
    options?: { add_special_tokens?: boolean },
  ) => string[];
  convert_tokens_to_ids: (
    tokens: readonly string[],
  ) => Array<number | undefined>;
  unk_token_id: number;
  model_max_length: number;
};

function fakeTokenizer(modelMaxLength = 8192): FakeTokenizer {
  const bytes = new Map<string, number>([
    ["<0xF0>", 255],
    ["<0x9F>", 174],
    ["<0x98>", 167],
    ["<0x80>", 143],
  ]);
  const tokenizer = (async (text, options) => {
    const ordinary = text === "😀" ? [0] : [11];
    return {
      input_ids:
        options.add_special_tokens === false ? ordinary : [1, ...ordinary, 2],
    };
  }) as FakeTokenizer;
  tokenizer.tokenize = (text) => (text === "😀" ? ["😀"] : ["a"]);
  tokenizer.convert_tokens_to_ids = (tokens) =>
    tokens.map((token) => bytes.get(token));
  tokenizer.unk_token_id = 0;
  tokenizer.model_max_length = modelMaxLength;
  return tokenizer;
}

afterEach(() => vi.restoreAllMocks());

describe("Transformers tokenizer adapter", () => {
  it("creates strict local encodings with special masks and max length", async () => {
    vi.spyOn(AutoTokenizer, "from_pretrained").mockResolvedValue(
      fakeTokenizer() as never,
    );
    const tokenizer = await createTransformersTokenizer("local-model");
    const result = await tokenizer.encode("a");
    expect(result.inputIds).toEqual([1, 11, 2]);
    expect(result.offsets).toEqual([
      [0, 0],
      [0, 1],
      [0, 0],
    ]);
    expect(result.attentionMask).toEqual([1, 1, 1]);
    expect(result.specialTokensMask).toEqual([1, 0, 1]);
    expect(tokenizer.modelMaxLength).toBe(8192);
  });

  it("expands unknown emoji IDs to byte fallback in the adapter", async () => {
    vi.spyOn(AutoTokenizer, "from_pretrained").mockResolvedValue(
      fakeTokenizer() as never,
    );
    const tokenizer = await createTransformersTokenizer("local-model");
    const result = await tokenizer.encode("😀", { addSpecialTokens: false });
    expect(result.inputIds).toEqual([255, 174, 167, 143]);
    expect(result.offsets).toEqual([
      [0, 2],
      [0, 2],
      [0, 2],
      [0, 2],
    ]);
  });

  it("ignores the Transformers sentinel model length", async () => {
    vi.spyOn(AutoTokenizer, "from_pretrained").mockResolvedValue(
      fakeTokenizer(1e30) as never,
    );
    const tokenizer = await createTransformersTokenizer("local-model");
    expect(tokenizer.modelMaxLength).toBeUndefined();
  });

  it("fails closed when the local tokenizer omits input IDs", async () => {
    const broken = (async () => ({})) as unknown as FakeTokenizer;
    broken.tokenize = () => ["a"];
    broken.convert_tokens_to_ids = () => [];
    broken.unk_token_id = 0;
    broken.model_max_length = 8192;
    vi.spyOn(AutoTokenizer, "from_pretrained").mockResolvedValue(
      broken as never,
    );
    const tokenizer = await createTransformersTokenizer("local-model");
    await expect(tokenizer.encode("a")).rejects.toThrow(/input_ids/);
  });

  it("keeps an unknown span when byte IDs are unavailable", () => {
    expect(
      expandByteFallback("😀", [0], [[0, 2]], {
        convert_tokens_to_ids: () => [
          undefined,
          undefined,
          undefined,
          undefined,
        ],
      }),
    ).toEqual({ inputIds: [0], offsets: [[0, 2]] });
  });
});
