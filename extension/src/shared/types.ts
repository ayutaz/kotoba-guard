/** Data crossing the extension boundaries. Text is intentionally never persisted. */
export const MAX_INPUT_LENGTH = 20_000;

export type Detection = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly type: string;
  readonly confidence: number;
  readonly suggestions?: readonly string[];
};

export type DetectionResult = {
  readonly detections: readonly Detection[];
  readonly inferenceMs: number;
  readonly backend: "wasm" | "webgpu";
  readonly modelVersion: string;
};

export type CheckRequest = {
  readonly type: "check";
  readonly requestId: number;
  readonly text: string;
  readonly manual?: boolean;
};

export type CheckResponse =
  | {
      readonly type: "check-result";
      readonly requestId: number;
      readonly result: DetectionResult;
    }
  | {
      readonly type: "check-error";
      readonly requestId: number;
      readonly code: string;
    };

export type ContentMessage =
  | { readonly type: "content-ready" }
  | { readonly type: "get-content-state" }
  | {
      readonly type: "check";
      readonly requestId: number;
      readonly text: string;
    }
  | { readonly type: "manual-check" }
  | { readonly type: "set-state"; readonly enabled: boolean };

export type BackgroundMessage =
  | { readonly type: "content-ready" }
  | { readonly type: "get-content-state" }
  | CheckRequest
  | { readonly type: "get-state" }
  | { readonly type: "get-status"; readonly tabId?: number }
  | { readonly type: "manual-check"; readonly tabId?: number }
  | { readonly type: "set-global-enabled"; readonly enabled: boolean }
  | {
      readonly type: "set-site-enabled";
      readonly origin: string;
      readonly enabled: boolean;
    };

export type RuntimeState = {
  readonly globalEnabled: boolean;
  readonly siteEnabled: boolean;
  readonly origin: string;
};

export type RuntimeStatus = RuntimeState & {
  readonly modelReady: boolean;
  readonly modelVersion: string;
  readonly backend: "wasm" | "webgpu" | "unknown";
  readonly detectionCount: number;
  readonly lastError?: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isCheckMessage(value: unknown): value is CheckRequest {
  if (!isRecord(value)) return false;
  return (
    value.type === "check" &&
    typeof value.requestId === "number" &&
    Number.isSafeInteger(value.requestId) &&
    typeof value.text === "string" &&
    value.text.length <= MAX_INPUT_LENGTH
  );
}
