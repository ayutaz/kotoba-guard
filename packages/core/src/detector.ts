import { makeTokenChunks } from "./chunking.js";
import { normalizeOffset } from "./offsets.js";
import { createTensor, readLogits } from "./inference.js";
import {
  InferenceCancelledError,
  type Detection,
  type DetectOptions,
  type InferenceBackend,
  type InferenceSessionLike,
  type ModelLabels,
  type TokenizerEncoding,
  type TokenOffset,
  type TypoDetector,
  type TypoDetectorOptions,
} from "./types.js";

const DEFAULT_MAX_TOKENS = 8192;

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new InferenceCancelledError();
}

function softmax(values: ArrayLike<number>): number[] {
  let max = -Infinity;
  for (const value of Array.from(values)) if (value > max) max = value;
  const exps = Array.from(values, (value) => Math.exp(value - max));
  const sum = exps.reduce((total, value) => total + value, 0);
  return exps.map((value) => value / sum);
}

function labelsFromConfig(labels: ModelLabels): Map<number, string> {
  const result = new Map<number, string>();
  for (const [id, label] of Object.entries(labels.id2label)) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || !label)
      throw new Error(`Invalid model label mapping: ${id}=${label}`);
    result.set(numericId, label);
  }
  if (result.size === 0)
    throw new Error("Model config contains no id2label mapping");
  if (labels.label2id) {
    for (const [id, label] of result) {
      if (labels.label2id[label] !== id)
        throw new Error(`Inconsistent model label mapping for ${label}`);
    }
    for (const [label, id] of Object.entries(labels.label2id)) {
      if (result.get(id) !== label)
        throw new Error(`Inconsistent model label mapping for ${label}`);
    }
  }
  return result;
}

function labelIdFor(scores: ArrayLike<number>): {
  id: number;
  confidence: number;
} {
  const probabilities = softmax(scores);
  let id = 0;
  for (let index = 1; index < probabilities.length; index += 1) {
    const candidate = probabilities[index];
    const current = probabilities[id];
    if (candidate !== undefined && current !== undefined && candidate > current)
      id = index;
  }
  const confidence = probabilities[id];
  if (confidence === undefined)
    throw new Error("Model returned no class scores");
  return { id, confidence };
}

function isIgnored(label: string): boolean {
  return label.toUpperCase() === "OK";
}

function encodingOffsets(
  text: string,
  encoding: TokenizerEncoding,
): TokenOffset[] {
  return encoding.offsets.map((offset) =>
    normalizeOffset(text, offset, encoding.offsetUnit ?? "utf16"),
  );
}

export class LocalTypoDetector implements TypoDetector {
  private readonly labelsById: Map<number, string>;
  private readonly maxTokens: number;
  private readonly overlapTokens: number;
  private readonly threshold: number;
  private readonly preferredBackend: InferenceBackend;
  private session: InferenceSessionLike | undefined;
  private activeBackend: InferenceBackend;
  private initialization: Promise<void> | undefined;
  private readonly activeRuns = new Set<Promise<Detection[]>>();
  private disposal: Promise<void> | undefined;
  private disposed = false;
  private generation = 0;
  private activeAbort: AbortController | undefined;

  public constructor(private readonly options: TypoDetectorOptions) {
    this.labelsById = labelsFromConfig(options.labels);
    const tokenizerMax = options.tokenizer.modelMaxLength;
    const safeTokenizerMax =
      tokenizerMax !== undefined &&
      Number.isSafeInteger(tokenizerMax) &&
      tokenizerMax >= 3
        ? Math.min(tokenizerMax, DEFAULT_MAX_TOKENS)
        : DEFAULT_MAX_TOKENS;
    if (options.maxTokens !== undefined && options.maxTokens > safeTokenizerMax)
      throw new RangeError("maxTokens exceeds the safe model limit");
    this.maxTokens = options.maxTokens ?? safeTokenizerMax;
    this.overlapTokens =
      options.overlapTokens ?? Math.min(32, this.maxTokens - 3);
    this.threshold = options.confidenceThreshold ?? 0.5;
    this.preferredBackend = options.backend ?? "wasm";
    this.activeBackend = this.preferredBackend;
    if (!Number.isSafeInteger(this.maxTokens) || this.maxTokens < 3)
      throw new RangeError("maxTokens must be at least 3");
    if (
      !Number.isSafeInteger(this.overlapTokens) ||
      this.overlapTokens < 0 ||
      this.overlapTokens >= this.maxTokens - 2
    )
      throw new RangeError("overlapTokens is too large");
    if (
      !Number.isFinite(this.threshold) ||
      this.threshold < 0 ||
      this.threshold > 1
    )
      throw new RangeError("confidenceThreshold must be between 0 and 1");
  }

  public async initialize(): Promise<void> {
    if (this.disposed) throw new Error("TypoDetector has been disposed");
    if (!this.initialization) {
      this.initialization = this.initializeSession().catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    }
    await this.initialization;
  }

  private async initializeSession(): Promise<void> {
    try {
      const session = await this.options.sessionFactory(this.preferredBackend);
      if (this.disposed) {
        // Let finishDispose own this session so release errors remain visible
        // to every concurrent dispose caller.
        this.session = session;
        throw new Error("TypoDetector has been disposed");
      }
      this.session = session;
      this.activeBackend = this.preferredBackend;
    } catch (error) {
      if (this.preferredBackend !== "webgpu" || this.disposed) throw error;
      const session = await this.options.sessionFactory("wasm");
      if (this.disposed) {
        this.session = session;
        throw new Error("TypoDetector has been disposed", { cause: error });
      }
      this.session = session;
      this.activeBackend = "wasm";
    }
  }

  public async detect(
    text: string,
    detectOptions: DetectOptions = {},
  ): Promise<import("./types.js").DetectionResult> {
    if (this.disposed) throw new Error("TypoDetector has been disposed");
    throwIfCancelled(detectOptions.signal);
    if (text.length === 0) {
      this.generation += 1;
      this.activeAbort?.abort();
      this.activeAbort = undefined;
      return {
        detections: [],
        inferenceMs: 0,
        backend: this.activeBackend,
        modelVersion: this.options.modelVersion,
      };
    }
    const generation = ++this.generation;
    this.activeAbort?.abort();
    const controller = new AbortController();
    this.activeAbort = controller;
    const combined = combineSignals(controller.signal, detectOptions.signal);
    const signal = combined.signal;
    try {
      await this.initialize();
      throwIfCancelled(signal);
      const started = performance.now();
      const chunks = await makeTokenChunks(
        text,
        this.options.tokenizer,
        this.maxTokens,
        this.overlapTokens,
      );
      const detections: Detection[] = [];
      for (const chunk of chunks) {
        throwIfCancelled(signal);
        if (generation !== this.generation) throw new InferenceCancelledError();
        const inference = this.inferChunk(chunk.text, chunk.encoding, signal);
        this.activeRuns.add(inference);
        let chunkDetections: Detection[];
        try {
          chunkDetections = await inference;
        } finally {
          this.activeRuns.delete(inference);
        }
        for (const detection of chunkDetections) {
          detections.push({
            ...detection,
            start: detection.start + chunk.start,
            end: detection.end + chunk.start,
            text: text.slice(
              detection.start + chunk.start,
              detection.end + chunk.start,
            ),
          });
        }
      }
      throwIfCancelled(signal);
      if (generation !== this.generation) throw new InferenceCancelledError();
      return {
        detections: deduplicateDetections(detections, this.threshold),
        inferenceMs: performance.now() - started,
        backend: this.activeBackend,
        modelVersion: this.options.modelVersion,
      };
    } finally {
      combined.cleanup();
      if (this.activeAbort === controller) this.activeAbort = undefined;
    }
  }

  private async inferChunk(
    text: string,
    encoding: TokenizerEncoding,
    signal: AbortSignal,
  ): Promise<Detection[]> {
    const session = this.session;
    if (!session) throw new Error("TypoDetector is not initialized");
    throwIfCancelled(signal);
    const ids = Array.from(
      encoding.inputIds as ArrayLike<number | bigint>,
      Number,
    );
    if (encoding.offsets.length !== ids.length)
      throw new Error("Tokenizer offsets do not match input IDs");
    const attention = encoding.attentionMask
      ? Array.from(encoding.attentionMask as ArrayLike<number | bigint>, Number)
      : ids.map(() => 1);
    const feeds: Record<string, unknown> = {};
    let outputs: Record<string, unknown> | undefined;
    try {
      const inputNames = session.inputNames;
      const idName = inputNames.includes("input_ids")
        ? "input_ids"
        : inputNames[0];
      if (!idName) throw new Error("ONNX model declares no inputs");
      feeds[idName] = createTensor("int64", ids, [1, ids.length]);
      if (inputNames.includes("attention_mask"))
        feeds.attention_mask = createTensor("int64", attention, [
          1,
          attention.length,
        ]);
      if (inputNames.includes("token_type_ids") && encoding.tokenTypeIds) {
        feeds.token_type_ids = createTensor("int64", encoding.tokenTypeIds, [
          1,
          ids.length,
        ]);
      }
      outputs = (await session.run(feeds)) as Record<string, unknown>;
      throwIfCancelled(signal);
      const logits = readLogits(
        outputs as Record<string, import("./types.js").LogitsTensorLike>,
        session.outputNames,
      );
      const dims = logits.dims;
      const classCount = dims[2];
      if (
        dims.length !== 3 ||
        dims[0] !== 1 ||
        dims[1] !== ids.length ||
        classCount === undefined
      )
        throw new Error(`Unexpected logits shape: [${dims.join(", ")}]`);
      const data = logits.data;
      const offsets = encodingOffsets(text, encoding);
      const special = encoding.specialTokensMask
        ? Array.from(
            encoding.specialTokensMask as ArrayLike<number | bigint>,
            Number,
          )
        : undefined;
      const detections: Detection[] = [];
      for (let tokenIndex = 0; tokenIndex < ids.length; tokenIndex += 1) {
        const tokenOffset = offsets[tokenIndex];
        if (!tokenOffset)
          throw new Error("Tokenizer returned a missing token offset");
        const [start, end] = tokenOffset;
        if (end <= start || special?.[tokenIndex]) continue;
        const selected = labelIdFor(
          Array.prototype.slice.call(
            data,
            tokenIndex * classCount,
            (tokenIndex + 1) * classCount,
          ),
        );
        const type = this.labelsById.get(selected.id);
        if (!type || isIgnored(type) || selected.confidence < this.threshold)
          continue;
        detections.push({
          start,
          end,
          text: text.slice(start, end),
          type,
          labelId: selected.id,
          confidence: selected.confidence,
        });
      }
      return detections;
    } finally {
      disposeRecord(feeds);
      disposeRecord(outputs);
    }
  }

  public dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.generation += 1;
    this.activeAbort?.abort();
    this.disposal = this.finishDispose();
    return this.disposal;
  }

  private async finishDispose(): Promise<void> {
    // Initialization rejects after it observes disposed; disposal still waits
    // for that race so a just-created session can release itself safely.
    await this.initialization?.catch(() => undefined);
    await Promise.allSettled([...this.activeRuns]);
    const session = this.session;
    this.session = undefined;
    this.initialization = undefined;
    await session?.release?.();
  }
}

function disposeRecord(record: Record<string, unknown> | undefined): void {
  if (!record) return;
  const disposed = new Set<unknown>();
  for (const value of Object.values(record)) {
    if (disposed.has(value)) continue;
    disposed.add(value);
    disposeResource(value);
  }
}

function disposeResource(value: unknown): void {
  if (!value || (typeof value !== "object" && typeof value !== "function"))
    return;
  const dispose = (value as { dispose?: unknown }).dispose;
  if (typeof dispose !== "function") return;
  try {
    dispose.call(value);
  } catch {
    // Preserve the inference error/result; resource cleanup is best effort.
  }
}

interface CombinedSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

function combineSignals(
  primary: AbortSignal,
  secondary?: AbortSignal,
): CombinedSignal {
  if (!secondary) return { signal: primary, cleanup: () => undefined };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (primary.aborted || secondary.aborted) controller.abort();
  primary.addEventListener("abort", abort, { once: true });
  secondary.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      primary.removeEventListener("abort", abort);
      secondary.removeEventListener("abort", abort);
    },
  };
}

function deduplicateDetections(
  detections: Detection[],
  threshold: number,
): Detection[] {
  const sorted = [...detections].sort(
    (a, b) =>
      b.confidence - a.confidence || b.end - b.start - (a.end - a.start),
  );
  const result: Detection[] = [];
  for (const detection of sorted) {
    if (detection.confidence < threshold) continue;
    if (
      result.some(
        (existing) =>
          existing.start === detection.start &&
          existing.end === detection.end &&
          existing.type === detection.type,
      )
    )
      continue;
    result.push(detection);
  }
  return result.sort((a, b) => a.start - b.start || a.end - b.end);
}
