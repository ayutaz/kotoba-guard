import {
  isAcceptedOffscreenSender,
  isOffscreenInstanceId,
} from "../shared/security";
import { MAX_INPUT_LENGTH, isRecord } from "../shared/types";
import { WorkerBroker } from "./broker";

export type OffscreenRuntimeOptions = {
  readonly retainWorkerMs?: number;
};

const MAX_PENDING = 2;
const MAX_RETAIN_WORKER_MS = 60_000;
const INSTALL_MARKER = Symbol.for("kotoba-guard.offscreen.runtime");

type RuntimeWithInstallMarker = typeof chrome.runtime & {
  [INSTALL_MARKER]?: true;
};

function validateOptions(options: unknown): number {
  if (options === undefined) return 0;
  if (!isRecord(options)) throw new Error("offscreen-retain-worker-invalid");
  const value = options.retainWorkerMs ?? 0;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_RETAIN_WORKER_MS
  )
    throw new Error("offscreen-retain-worker-invalid");
  return value;
}

async function boundedControl<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("offscreen-identity-timeout")),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Install the one offscreen runtime for the current document. */
export function installOffscreenRuntime(
  options: OffscreenRuntimeOptions = {},
): void {
  const retainWorkerMs = validateOptions(options);
  const runtime = chrome.runtime as RuntimeWithInstallMarker;
  if (runtime[INSTALL_MARKER] === true)
    throw new Error("offscreen-runtime-already-installed");
  runtime[INSTALL_MARKER] = true;

  let retiring = false;
  const instanceId = crypto.randomUUID();
  if (!isOffscreenInstanceId(instanceId))
    throw new Error("offscreen-instance-unavailable");

  const currentDocumentId = async (): Promise<string | undefined> => {
    const response: unknown = await boundedControl(
      chrome.runtime.sendMessage({ type: "offscreen-identify", instanceId }),
    );
    if (!isRecord(response) || response.ok !== true) return undefined;
    const documentId = response.documentId;
    return typeof documentId === "string" &&
      documentId.length > 0 &&
      documentId.length <= 128
      ? documentId
      : undefined;
  };
  const notifyIdle = async (): Promise<void> => {
    const documentId = await currentDocumentId();
    if (!documentId) return;
    const response: unknown = await boundedControl(
      chrome.runtime.sendMessage({
        type: "offscreen-idle",
        documentId,
        instanceId,
        releases: broker.releaseCounts,
      }),
    );
    if (
      isRecord(response) &&
      response.ok === true &&
      response.closed === false &&
      (await currentDocumentId()) === documentId
    )
      retiring = false;
  };

  const broker = new WorkerBroker(
    () => new Worker(chrome.runtime.getURL("worker.js"), { type: "module" }),
    60_000,
    60_000,
    () => {
      retiring = true;
      void notifyIdle().catch(() => {
        /* Unknown identity/close outcome: remain fail-closed until document destruction. */
      });
    },
    retainWorkerMs,
  );

  chrome.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse) => {
      if (!isAcceptedOffscreenSender(sender, chrome.runtime.id)) return false;
      if (!message || typeof message !== "object") return false;
      const value = message as { type?: unknown; text?: unknown };
      if (value.type === "offscreen-instance") {
        if (Object.keys(value).length !== 1) return false;
        sendResponse({ instanceId });
        return false;
      }
      if (value.type === "offscreen-status") {
        sendResponse({
          ready: !retiring && broker.ready,
          instanceId,
          retiring,
          releases: broker.releaseCounts,
        });
        return false;
      }
      if (
        value.type !== "offscreen-detect" ||
        typeof value.text !== "string" ||
        value.text.length > MAX_INPUT_LENGTH
      )
        return false;
      if (retiring || broker.size >= MAX_PENDING) {
        sendResponse({ ok: false, code: "busy" });
        return false;
      }
      broker
        .request(value.text)
        .then((response) => sendResponse(response))
        .catch(() => sendResponse({ ok: false, code: "worker-failed" }));
      return true;
    },
  );
}
