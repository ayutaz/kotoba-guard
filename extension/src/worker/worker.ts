import { MAX_INPUT_LENGTH, type DetectionResult } from "../shared/types";
import {
  LocalTypoDetector,
  createOrtSessionFactory,
  createTransformersTokenizer,
} from "@kotoba-guard/core";

type DetectRequest = {
  readonly id: number;
  readonly type: "detect";
  readonly text: string;
};
type ReleaseSessionRequest = {
  readonly type: "release-session";
  readonly releaseId: number;
};
type WorkerRequest =
  { readonly type: "dispose" } | ReleaseSessionRequest | DetectRequest;
type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly result: DetectionResult }
  | { readonly id: number; readonly ok: false; readonly code: string };
type Detector = {
  initialize?: () => Promise<void>;
  detect: (text: string) => Promise<DetectionResult>;
  dispose?: () => Promise<void>;
};

let detector: Detector | undefined;
let detectorPromise: Promise<Detector> | undefined;
let retiring = false;
let releasingSession = false;
let sessionReleasePromise: Promise<boolean> | undefined;
let lastReleaseId = -1;
const DETECTOR_TIMEOUT_MS = 60_000;
const MAX_DETECT_REQUESTS = 2;
let pendingDetections = 0;
let detectionTail = Promise.resolve();
let detectorGeneration = 0;

const workerBusy = Symbol("worker-busy");

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("detector-timeout")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function createBundledDetector(): Promise<Detector> {
  const modelRoot = new URL("./models/", self.location.href).toString();
  const manifestResponse = await fetch(`${modelRoot}manifest.json`);
  const manifest = (await manifestResponse.json()) as { revision?: unknown };
  const configResponse = await fetch(`${modelRoot}config.json`);
  const config = (await configResponse.json()) as {
    id2label?: unknown;
    model_max_length?: unknown;
    max_position_embeddings?: unknown;
  };
  if (!config.id2label || typeof config.id2label !== "object")
    throw new Error("model labels are unavailable");
  const tokenizer = await createTransformersTokenizer(modelRoot);
  const modelUrl = `${modelRoot}onnx/model_quantized.onnx`;
  return new LocalTypoDetector({
    tokenizer,
    sessionFactory: createOrtSessionFactory(modelUrl, {
      wasmThreads: 1,
      wasmPath: new URL("./wasm/", self.location.href).toString(),
    }),
    labels: { id2label: config.id2label as Record<string, string> },
    modelVersion:
      typeof manifest.revision === "string" ? manifest.revision : "unknown",
    maxTokens: 256,
    overlapTokens: 32,
    backend: "wasm",
  });
}

async function getDetector(): Promise<Detector> {
  if (detector) return detector;
  if (!detectorPromise) {
    detectorPromise = createBundledDetector()
      .then(async (value) => {
        if (value.initialize) await value.initialize();
        detector = value;
        return value;
      })
      .catch((error: unknown) => {
        detectorPromise = undefined;
        throw error;
      });
  }
  return detectorPromise;
}

function isReleaseSessionRequest(
  value: unknown,
): value is ReleaseSessionRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return (
    Object.keys(request).length === 2 &&
    request.type === "release-session" &&
    typeof request.releaseId === "number" &&
    Number.isSafeInteger(request.releaseId) &&
    request.releaseId >= 0
  );
}

function isDetectRequest(value: unknown): value is DetectRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return (
    request.type === "detect" &&
    typeof request.id === "number" &&
    typeof request.text === "string" &&
    request.text.length <= MAX_INPUT_LENGTH
  );
}

function releaseSession(): Promise<boolean> {
  if (sessionReleasePromise) return sessionReleasePromise;
  detectorGeneration += 1;
  releasingSession = true;
  const operation = (async (): Promise<boolean> => {
    try {
      // Initialization may have created a session that is not yet assigned.
      // The SDK itself waits for active runs before releasing that session.
      const current = detector ?? (await detectorPromise);
      await current?.dispose?.();
      return true;
    } catch {
      // A failed release cannot safely be reused. Keep this worker retired and
      // do not expose the SDK error or any input text in the acknowledgement.
      retiring = true;
      return false;
    } finally {
      detector = undefined;
      detectorPromise = undefined;
      releasingSession = false;
    }
  })();
  sessionReleasePromise = operation;
  void operation.then(() => {
    if (sessionReleasePromise === operation) sessionReleasePromise = undefined;
  });
  return operation;
}

function disposePermanently(): void {
  retiring = true;
  void releaseSession().then((ok) => {
    self.postMessage({ type: "disposed", ok });
  });
}

async function detect(
  request: DetectRequest,
  generation: number,
): Promise<void> {
  let inference: Promise<DetectionResult> | undefined;
  try {
    if (retiring || releasingSession || generation !== detectorGeneration)
      throw workerBusy;
    const current = await getDetector();
    if (retiring || releasingSession || generation !== detectorGeneration)
      throw workerBusy;
    inference = current.detect(request.text);
    const result = await withTimeout(inference, DETECTOR_TIMEOUT_MS);
    if (retiring || releasingSession) throw workerBusy;
    self.postMessage({
      id: request.id,
      ok: true,
      result,
    } satisfies WorkerResponse);
  } catch (error: unknown) {
    self.postMessage({
      id: request.id,
      ok: false,
      code: error === workerBusy ? "worker-busy" : "inference-failed",
    } satisfies WorkerResponse);
  } finally {
    // A response timeout cannot cancel ORT. Keep the execution slot occupied
    // until the native run settles or the owning Broker terminates the Worker.
    await inference?.catch(() => undefined);
  }
}

function enqueueDetect(request: DetectRequest): void {
  if (pendingDetections >= MAX_DETECT_REQUESTS) {
    self.postMessage({ id: request.id, ok: false, code: "worker-busy" });
    return;
  }
  pendingDetections += 1;
  const generation = detectorGeneration;
  const operation = detectionTail.then(() => detect(request, generation));
  detectionTail = operation
    .catch(() => undefined)
    .finally(() => {
      pendingDetections -= 1;
    });
}

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const request = event.data;
  if (request?.type === "dispose") {
    if (!retiring) disposePermanently();
    return;
  }
  if (isReleaseSessionRequest(request)) {
    if (retiring) return;
    // Replays of an already accepted release are intentionally ignored. A
    // duplicate false acknowledgement could make the broker retire a worker
    // even though the original release is still completing successfully.
    if (request.releaseId <= lastReleaseId) return;
    if (releasingSession) {
      self.postMessage({
        type: "session-released",
        releaseId: request.releaseId,
        ok: false,
      });
      return;
    }
    lastReleaseId = request.releaseId;
    void releaseSession().then((ok) => {
      self.postMessage({
        type: "session-released",
        releaseId: request.releaseId,
        ok,
      });
    });
    return;
  }
  if (!isDetectRequest(request) || retiring) return;
  if (releasingSession) {
    self.postMessage({
      id: request.id,
      ok: false,
      code: "worker-busy",
    } satisfies WorkerResponse);
    return;
  }
  enqueueDetect(request);
};

export function disposeDetectorForTests(): void {
  void detector?.dispose?.();
  detector = undefined;
  detectorPromise = undefined;
}
