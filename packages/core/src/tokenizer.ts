import { AutoTokenizer, env } from "@huggingface/transformers";
import type {
  TokenizerAdapter,
  TokenizerEncoding,
  TokenOffset,
} from "./types.js";

const MAX_OPERATIONAL_MODEL_LENGTH = 1_000_000;

type TransformersEncoding = {
  input_ids?:
    { data?: ArrayLike<number | bigint> } | ArrayLike<number | bigint>;
  attention_mask?:
    { data?: ArrayLike<number | bigint> } | ArrayLike<number | bigint>;
  token_type_ids?:
    { data?: ArrayLike<number | bigint> } | ArrayLike<number | bigint>;
  offset_mapping?:
    | { data?: ArrayLike<number | bigint>; dims?: readonly number[] }
    | ArrayLike<number | bigint>;
  special_tokens_mask?:
    { data?: ArrayLike<number | bigint> } | ArrayLike<number | bigint>;
};

function tensorData(value: unknown): ArrayLike<number | bigint> | undefined {
  if (value && typeof value === "object" && "data" in value) {
    return (value as { data?: ArrayLike<number | bigint> }).data;
  }
  return value as ArrayLike<number | bigint> | undefined;
}

function ids(value: unknown): number[] {
  const data = tensorData(value);
  if (!data) throw new Error("Tokenizer did not return input_ids");
  return Array.from(data, (id) => Number(id));
}

interface TokenizerIdConverter {
  convert_tokens_to_ids(tokens: readonly string[]): Array<number | undefined>;
  unk_token_id?: number;
}

interface ExpandedEncoding {
  inputIds: number[];
  offsets: TokenOffset[];
}

/**
 * Transformers.js' Unigram implementation currently emits one `<unk>` for a
 * byte-fallback span. The Python/Rust tokenizer emits the corresponding
 * `<0xHH>` vocabulary entries instead. Expand only an actual unknown ID, and
 * only when every byte entry exists, so normal model IDs are left untouched.
 */
export function expandByteFallback(
  text: string,
  inputIds: readonly number[],
  offsets: readonly TokenOffset[],
  converter: TokenizerIdConverter,
  tokenPieces?: readonly string[],
): ExpandedEncoding {
  const unknownId = converter.unk_token_id ?? 0;
  const outputIds: number[] = [];
  const outputOffsets: TokenOffset[] = [];
  const encoder = new TextEncoder();
  for (let index = 0; index < inputIds.length; index += 1) {
    const id = inputIds[index];
    const offset = offsets[index];
    if (id === undefined || !offset)
      throw new Error("Tokenizer returned mismatched IDs and offsets");
    const [start, end] = offset;
    // A literal `<unk>` in user text is a valid vocabulary token. It must
    // remain ID 0; only an unknown token produced for a non-vocabulary span
    // is eligible for UTF-8 byte-fallback expansion.
    if (id !== unknownId || end <= start || tokenPieces?.[index] === "<unk>") {
      outputIds.push(id);
      outputOffsets.push(offset);
      continue;
    }
    const bytes = encoder.encode(text.slice(start, end));
    const byteTokens = Array.from(
      bytes,
      (value) => `<0x${value.toString(16).toUpperCase().padStart(2, "0")}>`,
    );
    const byteIds = converter.convert_tokens_to_ids(byteTokens);
    if (
      byteIds.length !== byteTokens.length ||
      byteIds.some((value) => value === undefined || value === unknownId)
    ) {
      outputIds.push(id);
      outputOffsets.push(offset);
      continue;
    }
    for (const byteId of byteIds) {
      if (byteId === undefined)
        throw new Error("Tokenizer returned an undefined byte fallback ID");
      outputIds.push(byteId);
      // Rust offsets point each byte fallback token at the original span.
      outputOffsets.push(offset);
    }
  }
  return { inputIds: outputIds, offsets: outputOffsets };
}

/**
 * Build offsets from the tokenizer's ordered token pieces. This is a cursor
 * alignment, never a search for a matching substring: every piece must consume
 * the next source characters exactly. It therefore fails closed for a
 * tokenizer that normalizes or rewrites text without exposing an alignment map.
 * ModernBERT-ja's tokenizer has no normalizer and uses the `▁` Metaspace marker.
 */
export function offsetsFromTokenPieces(
  text: string,
  pieces: readonly string[],
): TokenOffset[] {
  const result: TokenOffset[] = [];
  let cursor = 0;
  for (const piece of pieces) {
    // A literal U+2581 in the input is distinct from SentencePiece's
    // Metaspace marker. Prefer the exact source spelling; fall back to the
    // marker's whitespace interpretation only when the exact spelling does
    // not occur at the cursor.
    const sourcePiece = text.startsWith(piece, cursor)
      ? piece
      : piece.replaceAll("▁", " ");
    if (sourcePiece.length === 0) {
      result.push([cursor, cursor]);
      continue;
    }
    if (!text.startsWith(sourcePiece, cursor)) {
      throw new Error(
        `Tokenizer piece cannot be aligned without normalization at token ${result.length} (UTF-16 offset ${cursor})`,
      );
    }
    const end = cursor + sourcePiece.length;
    result.push([cursor, end]);
    cursor = end;
  }
  if (cursor !== text.length) {
    throw new Error(
      `Tokenizer pieces consumed ${cursor} of ${text.length} UTF-16 code units`,
    );
  }
  return result;
}

/**
 * Create an adapter around Transformers.js' local tokenizer. Transformers.js
 * currently does not expose Rust offset mappings, so this adapter performs a
 * strict cursor alignment of its ordered pieces and fails closed if normalization
 * changes the source text.
 */
export async function createTransformersTokenizer(
  modelPath: string,
): Promise<TokenizerAdapter> {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  const tokenizer = await AutoTokenizer.from_pretrained(modelPath);
  const adapter: TokenizerAdapter = {
    async encode(text, options = {}) {
      const output = (await tokenizer(text, {
        add_special_tokens: options.addSpecialTokens ?? true,
        truncation: false,
        return_token_type_ids: true,
      })) as unknown as TransformersEncoding;
      const inputIds = ids(output.input_ids);
      const tokenPieces = (
        tokenizer as unknown as {
          tokenize: (
            value: string,
            options?: { add_special_tokens?: boolean },
          ) => string[];
        }
      ).tokenize(text, { add_special_tokens: false });
      const tokenOffsets = offsetsFromTokenPieces(text, tokenPieces);
      const specialCount = inputIds.length - tokenOffsets.length;
      if (specialCount < 0 || specialCount > 2) {
        throw new Error(
          `Tokenizer returned ${inputIds.length} IDs for ${tokenOffsets.length} token pieces`,
        );
      }
      const mappedOffsets: TokenOffset[] =
        specialCount === 0
          ? tokenOffsets
          : [
              [0, 0],
              ...tokenOffsets,
              ...(specialCount === 2 ? ([[0, 0]] as const) : []),
            ];
      if (mappedOffsets.length !== inputIds.length)
        throw new Error("Unable to map special token offsets");
      const converter = tokenizer as unknown as TokenizerIdConverter;
      const ordinaryStart = specialCount > 0 ? 1 : 0;
      const ordinaryEnd =
        specialCount > 0 ? inputIds.length - 1 : inputIds.length;
      const expanded = expandByteFallback(
        text,
        inputIds.slice(ordinaryStart, ordinaryEnd),
        tokenOffsets,
        converter,
        tokenPieces,
      );
      const expandedInputIds =
        specialCount > 0
          ? [
              inputIds[0]!,
              ...expanded.inputIds,
              ...(specialCount === 2 ? [inputIds[inputIds.length - 1]!] : []),
            ]
          : expanded.inputIds;
      const expandedOffsets =
        specialCount > 0
          ? [
              [0, 0] as TokenOffset,
              ...expanded.offsets,
              ...(specialCount === 2 ? [[0, 0] as TokenOffset] : []),
            ]
          : expanded.offsets;
      const result: TokenizerEncoding = {
        inputIds: expandedInputIds,
        attentionMask: expandedInputIds.map(() => 1),
        offsets: expandedOffsets,
        offsetUnit: "utf16",
      };
      if (specialCount > 0)
        result.specialTokensMask = expandedInputIds.map((_, index) =>
          index === 0 ||
          (specialCount === 2 && index === expandedInputIds.length - 1)
            ? 1
            : 0,
        );
      if (result.offsets.length !== result.inputIds.length) {
        throw new Error(
          "Tokenizer offset_mapping length does not match input_ids",
        );
      }
      return result;
    },
  };
  const modelMaxLength = Number(
    (tokenizer as unknown as { model_max_length?: number }).model_max_length,
  );
  if (
    Number.isSafeInteger(modelMaxLength) &&
    modelMaxLength >= 3 &&
    modelMaxLength <= MAX_OPERATIONAL_MODEL_LENGTH
  )
    adapter.modelMaxLength = modelMaxLength;
  return adapter;
}
