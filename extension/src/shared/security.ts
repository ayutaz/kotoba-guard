import type { CheckRequest, RuntimeState } from "./types";
import { isRecord, MAX_INPUT_LENGTH } from "./types";

export function isTrustedExtensionSender(
  sender: Pick<chrome.runtime.MessageSender, "id">,
  runtimeId: string | undefined,
): boolean {
  return Boolean(runtimeId && sender.id === runtimeId);
}

export function isPrivilegedPopupSender(
  sender: Pick<chrome.runtime.MessageSender, "id" | "url">,
  runtimeId: string | undefined,
): boolean {
  if (!isTrustedExtensionSender(sender, runtimeId) || !sender.url || !runtimeId)
    return false;
  try {
    const url = new URL(sender.url);
    return (
      url.protocol === "chrome-extension:" &&
      url.hostname === runtimeId &&
      (url.pathname === "/popup.html" || url.pathname === "/options.html")
    );
  } catch {
    return false;
  }
}

export function isAcceptedOffscreenSender(
  sender: Pick<chrome.runtime.MessageSender, "id" | "url" | "tab">,
  runtimeId: string | undefined,
): boolean {
  return (
    isTrustedExtensionSender(sender, runtimeId) &&
    sender.tab === undefined &&
    (sender.url === undefined ||
      sender.url === `chrome-extension://${runtimeId}/background.js`)
  );
}

export function isOffscreenDocumentSender(
  sender: chrome.runtime.MessageSender,
  runtimeId: string | undefined,
): boolean {
  return (
    isTrustedExtensionSender(sender, runtimeId) &&
    sender.tab === undefined &&
    sender.url === `chrome-extension://${runtimeId}/offscreen.html`
  );
}

export function isOffscreenInstanceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

export function isOffscreenIdleNotice(
  value: unknown,
  sender: chrome.runtime.MessageSender,
  runtimeId: string | undefined,
): boolean {
  if (
    !isOffscreenDocumentSender(sender, runtimeId) ||
    !isRecord(value) ||
    value.type !== "offscreen-idle" ||
    Object.keys(value).length !== 4 ||
    !isOffscreenInstanceId(value.instanceId) ||
    typeof value.documentId !== "string" ||
    value.documentId.length === 0 ||
    value.documentId.length > 128 ||
    (sender.documentId != null && sender.documentId !== value.documentId) ||
    !isRecord(value.releases)
  )
    return false;
  const counts = value.releases;
  const keys = ["completed", "failed", "timedOut", "sendFailed"];
  if (
    Object.keys(counts).length !== keys.length ||
    !keys.every(
      (key) =>
        Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 0,
    )
  )
    return false;
  const total = keys.reduce((sum, key) => sum + (counts[key] as number), 0);
  return Number.isSafeInteger(total) && total > 0;
}

export function isValidBackgroundMessage(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "content-ready":
    case "get-content-state":
    case "get-state":
      return true;
    case "check":
      return (
        typeof value.requestId === "number" &&
        Number.isSafeInteger(value.requestId) &&
        typeof value.text === "string" &&
        value.text.length <= MAX_INPUT_LENGTH &&
        (value.manual === undefined || typeof value.manual === "boolean")
      );
    case "get-status":
    case "manual-check":
      return (
        value.tabId === undefined ||
        (typeof value.tabId === "number" && Number.isSafeInteger(value.tabId))
      );
    case "set-global-enabled":
      return typeof value.enabled === "boolean";
    case "set-site-enabled":
      return (
        typeof value.origin === "string" &&
        isHttpOrigin(value.origin) &&
        typeof value.enabled === "boolean"
      );
    default:
      return false;
  }
}

export function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value &&
      url.pathname === "/" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function canAcceptCheck(
  state: RuntimeState | undefined,
  request: CheckRequest,
  manualGrant: boolean,
): boolean {
  if (!state?.globalEnabled) return false;
  return state.siteEnabled || (request.manual === true && manualGrant);
}

export function shouldDropQueuedCheck(
  current: RuntimeState | undefined,
  entry: {
    readonly origin: string;
    readonly siteWasEnabled: boolean;
    readonly manual: boolean;
    readonly generation?: number;
  },
  currentGeneration?: number,
): boolean {
  return (
    !current ||
    current.origin !== entry.origin ||
    (currentGeneration !== undefined &&
      entry.generation !== undefined &&
      currentGeneration !== entry.generation) ||
    !current.globalEnabled ||
    (!current.siteEnabled && (entry.siteWasEnabled || !entry.manual))
  );
}
