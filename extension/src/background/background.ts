import { ExtensionState, CONTENT_SCRIPT_ID, originFromUrl } from "./state";
import type {
  BackgroundMessage,
  CheckResponse,
  DetectionResult,
  RuntimeStatus,
} from "../shared/types";
import { isCheckMessage, isRecord } from "../shared/types";
import { BoundedQueue } from "./queue";
import { dispatchManualCheck } from "./manual";
import { OffscreenLifecycle } from "./offscreen-lifecycle";
import {
  canAcceptCheck,
  isPrivilegedPopupSender,
  isTrustedExtensionSender,
  isValidBackgroundMessage,
  shouldDropQueuedCheck,
  isOffscreenIdleNotice,
  isOffscreenDocumentSender,
  isOffscreenInstanceId,
} from "../shared/security";

const state = new ExtensionState();
const MAX_QUEUE = 2;
type Pending = {
  readonly text: string;
  readonly requestId: number;
  readonly origin: string;
  readonly manual: boolean;
  readonly siteWasEnabled: boolean;
  readonly generation: number;
  readonly sender: chrome.runtime.MessageSender;
  readonly respond: (response: CheckResponse) => void;
};
const queue = new BoundedQueue<Pending>(MAX_QUEUE);
type ManualGrant = { readonly origin: string; readonly expiresAt: number };
const manualGrants = new Map<number, ManualGrant>();
let inFlight = false;
let modelReady = false;
let modelVersion = "unavailable";
let lastError: string | undefined;
let stateGeneration = 0;
let readinessQuery: Promise<boolean> | undefined;
const detectionCounts = new Map<
  number,
  { readonly origin: string; readonly count: number }
>();
const offscreen = new OffscreenLifecycle(
  {
    getContexts: () =>
      chrome.runtime.getContexts
        ? chrome.runtime.getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT"],
            documentUrls: [
              `chrome-extension://${chrome.runtime.id}/offscreen.html`,
            ],
          })
        : Promise.resolve([]),
    getInstanceId: async () => {
      const response: unknown = await chrome.runtime.sendMessage({
        type: "offscreen-instance",
      });
      if (
        !isRecord(response) ||
        Object.keys(response).length !== 1 ||
        !isOffscreenInstanceId(response.instanceId)
      )
        throw new Error("invalid-offscreen-instance");
      return response.instanceId;
    },
    create: () =>
      chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS"],
        justification:
          "Run local model inference off the service worker event loop.",
      }),
    close: () => chrome.offscreen.closeDocument(),
    isRetiring: async () => {
      const response: unknown = await chrome.runtime.sendMessage({
        type: "offscreen-status",
      });
      if (!isRecord(response) || typeof response.retiring !== "boolean")
        throw new Error("invalid-offscreen-status");
      return response.retiring;
    },
  },
  () => inFlight || queue.length > 0,
);

function clearDetectionCountsForOrigin(origin: string): void {
  for (const [tabId, value] of detectionCounts)
    if (value.origin === origin) detectionCounts.delete(tabId);
}

async function ensureState(): Promise<void> {
  await state.load();
}

async function hasHostPermission(origin: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [`${origin}/*`] });
}

async function reconcilePermissions(): Promise<boolean> {
  let changed = false;
  for (const origin of state.settings.enabledSites) {
    if (await hasHostPermission(origin)) continue;
    await state.setSiteEnabled(origin, false);
    changed = true;
    stateGeneration += 1;
    clearDetectionCountsForOrigin(origin);
    for (const [tabId, grant] of manualGrants)
      if (grant.origin === origin) manualGrants.delete(tabId);
  }
  if (changed) {
    await refreshContentRegistration();
    await broadcastState();
  }
  return changed;
}

async function refreshContentRegistration(): Promise<void> {
  try {
    await chrome.scripting.unregisterContentScripts({
      ids: [CONTENT_SCRIPT_ID],
    });
  } catch {
    /* first registration */
  }
  const matches = state.patterns();
  if (matches.length === 0) return;
  await chrome.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID,
      matches,
      js: ["content.js"],
      runAt: "document_idle",
      persistAcrossSessions: true,
    },
  ]);
}

async function detect(text: string): Promise<DetectionResult> {
  return offscreen.withDocument(async () => {
    const response = (await chrome.runtime.sendMessage({
      type: "offscreen-detect",
      text,
    })) as { ok?: unknown; result?: unknown; code?: unknown } | undefined;
    if (!response || response.ok !== true || !isRecord(response.result))
      throw new Error(
        typeof response?.code === "string" ? response.code : "inference-failed",
      );
    return response.result as DetectionResult;
  });
}

async function readOffscreenReadiness(): Promise<boolean> {
  if (offscreen.closing) return false;
  if (readinessQuery) return readinessQuery;
  const generation = offscreen.generation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const query = (async () => {
    try {
      const runtimeWithContexts = chrome.runtime as unknown as {
        getContexts?: (filter: {
          contextTypes: string[];
        }) => Promise<unknown[]>;
      };
      const contexts = runtimeWithContexts.getContexts
        ? await runtimeWithContexts.getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT"],
          })
        : [];
      if (contexts.length === 0) {
        return false;
      }
      const response: unknown = await chrome.runtime.sendMessage({
        type: "offscreen-status",
      });
      return (
        generation === offscreen.generation &&
        !offscreen.closing &&
        isRecord(response) &&
        response.ready === true
      );
    } catch {
      return false;
    }
  })();
  const bounded = Promise.race([
    query,
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 1_000);
    }),
  ]);
  readinessQuery = bounded;
  // A timed-out Chrome message cannot be cancelled. Retain its bounded result
  // until the underlying operation settles, rather than accumulating messages.
  void query.then(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (readinessQuery === bounded) readinessQuery = undefined;
  });
  return bounded;
}

async function drainQueue(): Promise<void> {
  if (inFlight || queue.length === 0) return;
  inFlight = true;
  const entry = queue.shift();
  if (!entry) {
    inFlight = false;
    return;
  }
  const tab =
    entry.sender.tab?.id === undefined
      ? undefined
      : await chrome.tabs.get(entry.sender.tab.id).catch(() => undefined);
  const current = state.forUrl(tab?.url);
  if (shouldDropQueuedCheck(current, entry, stateGeneration)) {
    entry.respond({
      type: "check-error",
      requestId: entry.requestId,
      code: "disabled",
    });
    inFlight = false;
    void drainQueue();
    return;
  }
  try {
    const result = await detect(entry.text);
    const latestTab =
      entry.sender.tab?.id === undefined
        ? undefined
        : await chrome.tabs.get(entry.sender.tab.id).catch(() => undefined);
    const latest = state.forUrl(latestTab?.url);
    if (shouldDropQueuedCheck(latest, entry, stateGeneration)) {
      entry.respond({
        type: "check-error",
        requestId: entry.requestId,
        code: "disabled",
      });
      return;
    }
    modelReady = true;
    modelVersion = result.modelVersion;
    lastError = undefined;
    if (entry.sender.tab?.id !== undefined)
      detectionCounts.set(entry.sender.tab.id, {
        origin: entry.origin,
        count: result.detections.length,
      });
    entry.respond({ type: "check-result", requestId: entry.requestId, result });
  } catch {
    lastError = "inference-failed";
    entry.respond({
      type: "check-error",
      requestId: entry.requestId,
      code: lastError,
    });
  } finally {
    inFlight = false;
    void drainQueue();
  }
}

function trusted(sender: chrome.runtime.MessageSender): boolean {
  const runtimeId = chrome.runtime.id;
  return isTrustedExtensionSender(sender, runtimeId);
}

function privilegedSender(sender: chrome.runtime.MessageSender): boolean {
  return isPrivilegedPopupSender(sender, chrome.runtime.id);
}

function consumeManualGrant(
  sender: chrome.runtime.MessageSender,
  origin: string,
): boolean {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return false;
  const grant = manualGrants.get(tabId);
  manualGrants.delete(tabId);
  return Boolean(
    grant && grant.expiresAt >= Date.now() && grant.origin === origin,
  );
}

function stateForSender(
  sender: chrome.runtime.MessageSender,
): ReturnType<ExtensionState["forUrl"]> {
  return state.forUrl(sender.tab?.url);
}

async function broadcastState(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs.flatMap((tab) => {
      if (tab.id === undefined) return [];
      const current = state.forUrl(tab.url);
      if (!current) return [];
      return [
        chrome.tabs
          .sendMessage(tab.id, { type: "set-state", state: current })
          .catch(() => undefined),
      ];
    }),
  );
}

/** Inject newly enabled content scripts into already open matching tabs. */
async function injectEnabledTabs(origin?: string): Promise<void> {
  if (!state.settings.globalEnabled) return;
  const origins = origin ? [origin] : [...state.settings.enabledSites];
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs.flatMap((tab) => {
      if (tab.id === undefined) return [];
      const tabOrigin = originFromUrl(tab.url);
      if (!tabOrigin || !origins.includes(tabOrigin)) return [];
      const current = state.forUrl(tab.url);
      if (!current?.siteEnabled) return [];
      const tabId = tab.id;
      return [
        (async () => {
          try {
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ["content.js"],
            });
          } catch {
            // Restricted pages and closed tabs are isolated from other tabs.
            return;
          }
          await chrome.tabs
            .sendMessage(tabId, { type: "set-state", state: current })
            .catch(() => undefined);
        })(),
      ];
    }),
  );
}

async function enqueueCheck(
  message: Extract<BackgroundMessage, { readonly type: "check" }>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: CheckResponse) => void,
): Promise<void> {
  if (!isCheckMessage(message) || sender.tab?.id === undefined) return;
  const runtimeState = state.forUrl(sender.tab.url);
  if (!runtimeState?.globalEnabled) return;
  const manualAuthorized =
    !runtimeState.siteEnabled &&
    message.manual === true &&
    consumeManualGrant(sender, runtimeState.origin);
  if (!canAcceptCheck(runtimeState, message, manualAuthorized)) return;
  if (!manualAuthorized && !(await hasHostPermission(runtimeState.origin))) {
    sendResponse({
      type: "check-error",
      requestId: message.requestId,
      code: "disabled",
    });
    return;
  }
  if (queue.length + (inFlight ? 1 : 0) >= MAX_QUEUE || queue.full) {
    sendResponse({
      type: "check-error",
      requestId: message.requestId,
      code: "busy",
    } satisfies CheckResponse);
    return;
  }
  queue.enqueue({
    text: message.text,
    requestId: message.requestId,
    origin: runtimeState.origin,
    manual: manualAuthorized,
    siteWasEnabled: runtimeState.siteEnabled,
    generation: stateGeneration,
    sender,
    respond: sendResponse,
  });
  void drainQueue();
}

async function manualCheck(
  tabId: number | undefined,
): Promise<{ ok: boolean; code?: string }> {
  if (tabId === undefined) return { ok: false, code: "no-tab" };
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const origin = state.forUrl(tab?.url)?.origin;
  if (!origin || !state.settings.globalEnabled)
    return { ok: false, code: "disabled" };
  manualGrants.set(tabId, { origin, expiresAt: Date.now() + 10_000 });
  const sendManualCheck = (): Promise<void> =>
    dispatchManualCheck(
      async () => {
        const current = await chrome.tabs.get(tabId).catch(() => undefined);
        return state.forUrl(current?.url);
      },
      origin,
      (message) => chrome.tabs.sendMessage(tabId, message),
    );
  try {
    await sendManualCheck();
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      await sendManualCheck();
    } catch {
      manualGrants.delete(tabId);
      return { ok: false, code: "cannot-inject" };
    }
  }
  return { ok: true };
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureState().then(refreshContentRegistration);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  manualGrants.delete(tabId);
  detectionCounts.delete(tabId);
});

chrome.permissions.onRemoved.addListener(({ origins }) => {
  if (!origins || origins.length === 0) return;
  void reconcilePermissions();
});

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (!trusted(sender) || !isRecord(raw) || typeof raw.type !== "string")
    return false;
  if (raw.type === "offscreen-identify") {
    if (
      !isOffscreenDocumentSender(sender, chrome.runtime.id) ||
      Object.keys(raw).length !== 2 ||
      !isOffscreenInstanceId(raw.instanceId)
    )
      return false;
    void offscreen.identify(raw.instanceId).then(
      (documentId) => {
        sendResponse(
          documentId &&
            (sender.documentId == null || sender.documentId === documentId)
            ? { ok: true, documentId }
            : { ok: false, code: "offscreen-identity-unavailable" },
        );
      },
      () => sendResponse({ ok: false, code: "offscreen-identity-unavailable" }),
    );
    return true;
  }
  if (raw.type === "offscreen-idle") {
    if (!isOffscreenIdleNotice(raw, sender, chrome.runtime.id)) return false;
    void offscreen
      .closeIfIdle(raw.documentId as string, raw.instanceId as string)
      .then(
        (closed) => sendResponse({ ok: true, closed }),
        () => sendResponse({ ok: false, code: "offscreen-close-failed" }),
      );
    return true;
  }
  if (
    raw.type === "offscreen-detect" ||
    raw.type === "offscreen-status" ||
    raw.type === "offscreen-instance"
  )
    return false;
  if (!isValidBackgroundMessage(raw)) {
    sendResponse({ ok: false, code: "invalid-message" });
    return false;
  }
  const message = raw as
    | BackgroundMessage
    | { readonly type: "offscreen-detect"; readonly text?: unknown };
  if (
    (message.type === "manual-check" ||
      message.type === "set-global-enabled" ||
      message.type === "set-site-enabled" ||
      message.type === "get-status") &&
    !privilegedSender(sender)
  )
    return false;
  if (
    message.type === "content-ready" ||
    message.type === "get-content-state"
  ) {
    void ensureState().then(() =>
      sendResponse({ state: stateForSender(sender) }),
    );
    return true;
  }
  if (message.type === "check") {
    if (!isCheckMessage(message) || sender.tab?.id === undefined) return false;
    void enqueueCheck(message, sender, sendResponse);
    return true;
  }
  void (async (): Promise<void> => {
    await ensureState();
    switch (message.type) {
      case "get-state":
        sendResponse({ state: state.forUrl(sender.tab?.url) });
        break;
      case "get-status": {
        modelReady = await readOffscreenReadiness();
        const statusTab =
          message.tabId === undefined
            ? sender.tab
            : await chrome.tabs.get(message.tabId).catch(() => undefined);
        const current = state.forUrl(statusTab?.url);
        const statusTabId = statusTab?.id ?? message.tabId;
        const countEntry =
          statusTabId === undefined
            ? undefined
            : detectionCounts.get(statusTabId);
        const detectionCount =
          countEntry && current?.origin === countEntry.origin
            ? countEntry.count
            : 0;
        if (statusTabId !== undefined && countEntry && detectionCount === 0)
          detectionCounts.delete(statusTabId);
        const status: RuntimeStatus = {
          ...(current ?? {
            origin: "",
            globalEnabled: state.settings.globalEnabled,
            siteEnabled: false,
          }),
          modelReady,
          modelVersion,
          backend: modelReady ? "wasm" : "unknown",
          detectionCount,
          ...(lastError ? { lastError } : {}),
        };
        sendResponse(status);
        break;
      }
      case "manual-check":
        sendResponse(await manualCheck(message.tabId ?? sender.tab?.id));
        break;
      case "set-global-enabled":
        await state.setGlobalEnabled(message.enabled);
        stateGeneration += 1;
        if (!message.enabled) {
          manualGrants.clear();
          detectionCounts.clear();
        }
        await refreshContentRegistration();
        await broadcastState();
        if (message.enabled) await injectEnabledTabs();
        sendResponse({ ok: true });
        break;
      case "set-site-enabled": {
        if (message.enabled && !(await hasHostPermission(message.origin))) {
          sendResponse({ ok: false, code: "permission-required" });
          break;
        }
        await state.setSiteEnabled(message.origin, message.enabled);
        stateGeneration += 1;
        if (!message.enabled) {
          clearDetectionCountsForOrigin(message.origin);
          for (const [tabId, grant] of manualGrants)
            if (grant.origin === message.origin) manualGrants.delete(tabId);
        }
        let permissionRemoved = true;
        if (!message.enabled) {
          try {
            await chrome.permissions.remove({
              origins: [`${message.origin}/*`],
            });
            permissionRemoved = !(await hasHostPermission(message.origin));
          } catch {
            permissionRemoved = false;
          }
        }
        await refreshContentRegistration();
        await broadcastState();
        if (message.enabled) await injectEnabledTabs(message.origin);
        sendResponse(
          permissionRemoved
            ? { ok: true }
            : { ok: false, code: "permission-remove-failed" },
        );
        break;
      }
    }
  })().catch(() => sendResponse({ ok: false, code: "state-failed" }));
  return true;
});

void ensureState().then(reconcilePermissions).then(refreshContentRegistration);
