/** The execution provider selected for the current inference. */
export type InferenceBackend = "wasm" | "webgpu";

export type OffsetUnit = "utf16" | "codepoint";

export type TokenOffset = readonly [start: number, end: number];

export interface TokenizerEncoding {
  inputIds: readonly number[] | ArrayLike<number | bigint>;
  attentionMask?: readonly number[] | ArrayLike<number | bigint>;
  tokenTypeIds?: readonly number[] | ArrayLike<number | bigint>;
  offsets: readonly TokenOffset[];
  specialTokensMask?: readonly number[] | ArrayLike<number | bigint>;
  /** Tokenizer offsets are normally JS UTF-16 offsets, but adapters must state this. */
  offsetUnit?: OffsetUnit;
}

export interface TokenizerAdapter {
  encode(
    text: string,
    options?: { addSpecialTokens?: boolean; maxLength?: number },
  ): Promise<TokenizerEncoding> | TokenizerEncoding;
  /** Optional model maximum. When absent, detectorOptions.maxTokens is required. */
  modelMaxLength?: number | undefined;
}

export interface LogitsTensorLike {
  data: ArrayLike<number>;
  dims: readonly number[];
}

export interface InferenceSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, LogitsTensorLike>>;
  release?(): Promise<void> | void;
}

export interface ModelLabels {
  id2label: Readonly<Record<string, string>>;
  label2id?: Readonly<Record<string, number>>;
}

export interface ModelConfig {
  id2label?: Readonly<Record<string, string>>;
  label2id?: Readonly<Record<string, number>>;
  max_position_embeddings?: number;
  max_seq_len?: number;
  model_max_length?: number;
  [key: string]: unknown;
}

export interface Detection {
  /** UTF-16 offsets suitable for String.prototype.slice and DOM Range APIs. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly type: string;
  readonly labelId: number;
  readonly confidence: number;
}

export interface DetectionResult {
  readonly detections: readonly Detection[];
  readonly inferenceMs: number;
  readonly backend: InferenceBackend;
  readonly modelVersion: string;
}

export interface TypoDetector {
  initialize(): Promise<void>;
  detect(text: string, options?: DetectOptions): Promise<DetectionResult>;
  dispose(): Promise<void>;
}

export interface DetectOptions {
  signal?: AbortSignal;
}

export interface TypoDetectorOptions {
  tokenizer: TokenizerAdapter;
  sessionFactory: SessionFactory;
  labels: ModelLabels;
  modelVersion: string;
  /** Maximum number of model input tokens, including special tokens. */
  maxTokens?: number;
  /** Number of ordinary tokens repeated between adjacent chunks. */
  overlapTokens?: number;
  confidenceThreshold?: number;
  backend?: InferenceBackend;
}

export type SessionFactory = (
  backend: InferenceBackend,
) => Promise<InferenceSessionLike>;

export class InferenceCancelledError extends DOMException {
  constructor(message = "The inference request was cancelled") {
    super(message, "AbortError");
  }
}
