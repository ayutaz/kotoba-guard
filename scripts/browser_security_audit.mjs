import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { chromium } from "@playwright/test";

import {
  classifyTargetScope,
  createSerialSampler,
  createAuditLedger,
  platformMemorySupport,
  sumProcessMemory,
  verifyArtifactManifest,
  webSocketAccept,
  isDirectEntrypoint,
} from "./browser_security_audit_helpers.mjs";
import {
  sampleWindowsBrowserMemory,
  sampleLinuxBrowserMemory,
} from "./browser_process_memory.mjs";
import {
  captureSourceIdentity,
  collectDistributionInventory,
  prepareAuditEvidence,
  verifyAuditIdentity,
} from "./browser_audit_evidence.mjs";

const extensionIdPattern = /^[a-p]{32}$/;
const auditPrefix = "kotoba-guard-security-audit-";
const defaultExtensionDir = join(process.cwd(), "dist", "extension");
const cdpTimeoutMs = 5_000;
const processSamplerStopTimeoutMs = 45_000;
const requiredFixtureControls = [
  "page-fetch",
  "dedicated-worker-fetch",
  "fixture-service-worker-fetch",
  "page-websocket",
  "dedicated-worker-websocket",
];

async function auditScriptSha256() {
  return createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex");
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function collectAssetIdentity(extensionDir) {
  const extensionAssets = [
    "manifest.json",
    "core.js",
    "background.js",
    "content.js",
    "offscreen.js",
    "worker.js",
  ];
  const assets = {};
  for (const relative of extensionAssets)
    assets[relative] = await sha256File(join(extensionDir, relative));

  const modelRoot = join(extensionDir, "models");
  const modelManifestRelative = "models/manifest.json";
  const modelManifestPath = join(modelRoot, "manifest.json");
  const modelManifest = JSON.parse(await readFile(modelManifestPath, "utf8"));
  if (
    typeof modelManifest.model_id !== "string" ||
    typeof modelManifest.revision !== "string"
  )
    throw new Error("bundled model identity metadata is missing");
  const declared = modelManifest.files ?? modelManifest.artifacts;
  const declaredEntries = Array.isArray(declared)
    ? declared
    : Object.entries(declared ?? {}).map(([path, value]) => ({
        path,
        ...value,
      }));
  const actualEntries = [];
  for (const entry of declaredEntries) {
    if (!entry || typeof entry.path !== "string") continue;
    const relative = entry.path.replaceAll("\\", "/");
    const path = resolve(modelRoot, relative);
    const outside = relativePath(modelRoot, path);
    if (
      isAbsolute(outside) ||
      outside === ".." ||
      outside.startsWith(`..${separator()}`)
    )
      throw new Error("model manifest contains an invalid path");
    actualEntries.push({ path: relative, ...(await sha256File(path)) });
  }
  const verification = verifyArtifactManifest(modelManifest, actualEntries);
  if (!verification.ok)
    throw new Error("bundled model manifest verification failed");
  if (
    !actualEntries.some((entry) => entry.path === "onnx/model_quantized.onnx")
  )
    throw new Error("bundled quantized model is missing from manifest");
  assets[modelManifestRelative] = await sha256File(modelManifestPath);
  return {
    extension: assets,
    model: {
      manifest: modelManifestRelative,
      modelId: modelManifest.model_id,
      revision: modelManifest.revision,
      files: actualEntries,
      verification,
    },
  };
}

function relativePath(root, target) {
  return relative(resolve(root), resolve(target));
}

function separator() {
  return process.platform === "win32" ? "\\" : "/";
}

function sanitizeAuditDiagnostic(value) {
  return String(value ?? "audit failed")
    .replace(/https?:\/\/[^\s)]+/gi, "<redacted-url>")
    .replace(/wss?:\/\/[^\s)]+/gi, "<redacted-url>")
    .replace(/chrome-extension:\/\/[^\s)]+/gi, "chrome-extension://<redacted>");
}

async function sendCdp(session, method, params = {}, sessionId) {
  let timer;
  try {
    return await Promise.race([
      session.send(method, params, sessionId),
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(
          () => reject(new Error("CDP command timed out: " + method)),
          cdpTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) globalThis.clearTimeout(timer);
  }
}

export async function boundedResult(operation, fallback, timeoutMs = 3_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(operation)
        .catch(() => fallback),
      new Promise((resolve) => {
        timer = globalThis.setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) globalThis.clearTimeout(timer);
  }
}

/**
 * @param {{
 *   monitor?: {stop(): Promise<void>},
 *   cdp?: {close(): Promise<void>},
 *   context?: {pages(): {close(): Promise<void>}[], close(): Promise<void>},
 *   browser?: {close(): Promise<void>},
 *   fixture?: {close(): Promise<void>}
 * }} resources
 * @returns {Promise<Record<string, boolean>>}
 */
export async function cleanupAuditResources(
  { monitor, cdp, context, browser, fixture },
  timeoutMs = 5_000,
) {
  const operations = {};
  // Let the owning Playwright browser finish persistent-browser shutdown before
  // awaiting its context. A raw CDP Browser.close does not settle that owner.
  for (const [name, close] of [
    ...(monitor ? [["monitor", () => monitor.stop()]] : []),
    ...(cdp ? [["cdp", () => cdp.close()]] : []),
    ...(context
      ? [
          [
            "pages",
            () => Promise.all(context.pages().map((page) => page.close())),
          ],
        ]
      : []),
    ...(browser ? [["browser", () => browser.close()]] : []),
    ...(context ? [["context", () => context.close()]] : []),
    ...(fixture ? [["fixture", () => fixture.close()]] : []),
  ]) {
    operations[name] = await boundedResult(
      async () => {
        await close();
        return true;
      },
      false,
      timeoutMs,
    );
  }
  return operations;
}

function parseArgs(argv) {
  const values = {
    extensionDir: process.env.KOTOBA_GUARD_EXTENSION_DIR ?? defaultExtensionDir,
    output: "artifacts/browser-security-audit.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--extension-dir" && argv[index + 1])
      values.extensionDir = argv[++index];
    else if (argv[index] === "--output" && argv[index + 1])
      values.output = argv[++index];
  }
  return values;
}

function safeExtensionId(value) {
  if (!extensionIdPattern.test(value ?? ""))
    throw new Error("Could not determine a valid extension id");
  return value;
}

function fixtureHtml(urls) {
  const encoded = JSON.stringify(urls).replace(/</g, "\\u003c");
  return `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="><title>isolated audit fixture</title>
<textarea aria-label="audit-fixture"></textarea>
<script>
(() => {
  const urls = ${encoded};
  const controls = [];
  window.__kgAuditControls = controls;
  const mark = (name) => {
    controls.push(name);
    const required = ["page-fetch", "dedicated-worker-fetch", "fixture-service-worker-fetch", "page-websocket", "dedicated-worker-websocket"];
    if (required.every((control) => controls.includes(control))) window.__kgAuditReady = true;
  };
  fetch(urls.control).then(() => mark("page-fetch")).catch(() => mark("page-fetch-failed"));
  const workerSource = 'fetch(' + JSON.stringify(urls.control) + ').then(() => postMessage("dedicated-worker-fetch")).catch(() => postMessage("dedicated-worker-failed")); const ws = new WebSocket(' + JSON.stringify(urls.websocket) + '); ws.addEventListener("open", () => { postMessage("dedicated-worker-websocket"); ws.close(); }); ws.addEventListener("error", () => postMessage("dedicated-worker-websocket-failed"));';
  const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" })));
  worker.addEventListener("message", (event) => mark(event.data));
  const swSource = ${JSON.stringify(urls.script)};
  navigator.serviceWorker.register(swSource).then(async (registration) => {
    const active = registration.active || (await navigator.serviceWorker.ready).active;
    active?.postMessage({ control: urls.control });
  }).catch(() => mark("service-worker-failed"));
  const socket = new WebSocket(urls.websocket);
  socket.addEventListener("open", () => { mark("page-websocket"); socket.close(); });
  socket.addEventListener("error", () => mark("page-websocket-failed"));
  navigator.serviceWorker.addEventListener("message", (event) => mark(event.data));
})();
</script>`;
}

function createFixtureServer() {
  const token = randomUUID();
  let port = 0;
  let server;
  const hits = [];
  const sockets = new Set();
  const pathFor = (path, protocol = "http") =>
    `${protocol}://127.0.0.1:${port}${path}?token=${token}`;
  const urls = {
    get root() {
      return pathFor("/");
    },
    get script() {
      return pathFor("/__kg_audit_sw__.js");
    },
    get control() {
      return pathFor("/__kg_audit_control__");
    },
    get websocket() {
      return pathFor("/__kg_audit_ws__", "ws");
    },
  };
  const expectedPaths = new Set([
    "/",
    "/__kg_audit_sw__.js",
    "/__kg_audit_control__",
  ]);
  server = createServer((request, response) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const exact = requestUrl.searchParams.get("token") === token;
    hits.push({ path: requestUrl.pathname, exactToken: exact });
    if (!exact || !expectedPaths.has(requestUrl.pathname)) {
      response.writeHead(404).end();
      return;
    }
    if (requestUrl.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(fixtureHtml(urls));
    } else if (requestUrl.pathname === "/__kg_audit_sw__.js") {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "service-worker-allowed": "/",
      });
      response.end(
        `self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim())); self.addEventListener("message", (event) => { if (event.data && event.data.control) fetch(event.data.control).then(() => event.source?.postMessage("fixture-service-worker-fetch")).catch(() => event.source?.postMessage("fixture-service-worker-failed")); });`,
      );
    } else {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    } catch {
      socket.destroy();
      return;
    }
    if (
      requestUrl.pathname !== "/__kg_audit_ws__" ||
      requestUrl.searchParams.get("token") !== token
    ) {
      socket.destroy();
      return;
    }
    hits.push({ path: requestUrl.pathname, exactToken: true, websocket: true });
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = webSocketAccept(key);
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    globalThis.setTimeout(() => socket.destroy(), 250);
  });
  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      port = server.address().port;
      return urls;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.race([
        new Promise((resolve) => server.close(() => resolve())),
        new Promise((resolve) => globalThis.setTimeout(resolve, 1_000)),
      ]);
    },
    hits,
    urls,
  };
}

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("Could not reserve a browser CDP port");
  return port;
}

async function getBrowserCdpEndpoint(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await globalThis.fetch(
        `http://127.0.0.1:${port}/json/version`,
      );
      if (response.ok) {
        const payload = await response.json();
        if (typeof payload.webSocketDebuggerUrl === "string")
          return payload.webSocketDebuggerUrl;
      }
    } catch {
      /* Chromium has not published the endpoint yet. */
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  }
  throw new Error("Browser CDP websocket endpoint was not discoverable");
}

function createRawCdpClient(endpoint) {
  const socket = new globalThis.WebSocket(endpoint);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    rejectReady = reject;
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error)
        request.reject(
          new Error(message.error.message ?? "CDP protocol error"),
        );
      else request.resolve(message.result ?? {});
      return;
    }
    for (const listener of listeners) listener(message);
  });
  socket.addEventListener("close", () => {
    const error = new Error("Browser CDP websocket closed");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  return {
    async send(method, params = {}, sessionId) {
      await ready;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const message = { id, method, params };
        if (sessionId) message.sessionId = sessionId;
        try {
          socket.send(JSON.stringify(message));
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      try {
        await ready;
      } catch (error) {
        rejectReady?.(error);
      }
      if (socket.readyState === globalThis.WebSocket.OPEN) socket.close();
    },
  };
}

export function createCdpMonitor(session, ledger, extensionIdentity) {
  let stopping = false;
  let stopPromise;
  const attached = new Map();
  const sessions = new Map();
  const targetOwners = new Map();
  const pendingSessions = new Map();
  const pendingTasks = new Set();
  const attaching = new Set();
  const detachedSessions = new Map();
  const sessionOrigins = new Map();
  const waitingForDebugger = new Map();
  const destroyedTargets = new Set();
  const manualAttachTargets = new Set();
  const limitations = [];
  const fatalMonitorErrors = [];
  const sessionDiagnostics = [];
  const monitorableTypes = new Set([
    "page",
    "service_worker",
    "worker",
    "shared_worker",
    "other",
    "background_page",
  ]);
  const extensionId = () =>
    typeof extensionIdentity === "string"
      ? extensionIdentity
      : extensionIdentity?.value;
  const recordFatal = (message) => {
    fatalMonitorErrors.push(message);
    limitations.push(message);
  };

  const sessionMetadata = (sessionId) => ({
    sessionOrigin: sessionOrigins.get(sessionId) ?? "unknown",
    waitingForDebugger: waitingForDebugger.has(sessionId)
      ? waitingForDebugger.get(sessionId)
      : null,
  });

  const recordSessionLifecycle = (entry) => {
    const withMetadata = { observedAt: Date.now(), ...entry };
    const sessionId = entry.childSessionId ?? entry.sessionId;
    if (sessionId) Object.assign(withMetadata, sessionMetadata(sessionId));
    if (entry.primarySessionId) {
      const primary = sessionMetadata(entry.primarySessionId);
      withMetadata.primarySessionOrigin = primary.sessionOrigin;
      withMetadata.primaryWaitingForDebugger = primary.waitingForDebugger;
    }
    if (entry.secondarySessionId) {
      const secondary = sessionMetadata(entry.secondarySessionId);
      withMetadata.secondarySessionOrigin = secondary.sessionOrigin;
      withMetadata.secondaryWaitingForDebugger = secondary.waitingForDebugger;
    }
    sessionDiagnostics.push(withMetadata);
  };

  const trackTask = (task) => {
    pendingTasks.add(task);
    void task.then(
      () => pendingTasks.delete(task),
      () => pendingTasks.delete(task),
    );
    return task;
  };

  const recordSessionDiagnostic = (
    stage,
    childSessionId,
    targetInfo,
    error,
  ) => {
    const message = error instanceof Error ? error.message : "protocol error";
    if (
      !/session with given id not found/i.test(message) &&
      !/timed out/i.test(message)
    )
      return;
    const detached = detachedSessions.get(childSessionId);
    const owner = targetInfo?.targetId
      ? targetOwners.get(targetInfo.targetId)
      : undefined;
    const hasReplacementSession = Boolean(
      targetInfo?.targetId &&
      [...sessions.entries()].some(
        ([sessionId, state]) =>
          sessionId !== childSessionId &&
          state.targetId === targetInfo.targetId &&
          state.networkEnabled,
      ),
    );
    const diagnostic = {
      observedAt: Date.now(),
      kind: /session with given id not found/i.test(message)
        ? "ephemeral-session-not-found"
        : "cdp-session-timeout",
      stage,
      childSessionId,
      targetId: targetInfo?.targetId ?? detached?.targetId ?? null,
      targetType: targetInfo?.type ?? "unknown",
      targetScope: classifyTargetScope(targetInfo, extensionId()),
      knownDetached: Boolean(detached),
      redundantSession: hasReplacementSession,
      detachedAt: detached?.detachedAt ?? null,
      primarySessionId: owner?.sessionId ?? null,
      coveredByPrimary: Boolean(
        owner &&
        owner.sessionId !== childSessionId &&
        sessions.get(owner.sessionId)?.networkEnabled,
      ),
      message,
      ...sessionMetadata(childSessionId),
    };
    if (owner?.sessionId) {
      const primary = sessionMetadata(owner.sessionId);
      diagnostic.primarySessionOrigin = primary.sessionOrigin;
      diagnostic.primaryWaitingForDebugger = primary.waitingForDebugger;
    }
    sessionDiagnostics.push(diagnostic);
  };

  const handleChildEvent = (targetId, method, params = {}) => {
    if (method === "Network.requestWillBeSent" && params.request?.url) {
      ledger.recordNetworkRequest({
        targetId,
        url: params.request.url,
        resourceType: params.type ?? "Other",
        isNavigation: params.type === "Document",
      });
    } else if (method === "Network.webSocketCreated" && params.url) {
      ledger.recordWebSocket({ targetId, url: params.url });
    }
  };

  const configureContainer = async (childSessionId, targetInfo) => {
    const autoAttach = sendCdp(
      session,
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      },
      childSessionId,
    ).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    try {
      await resumePausedSession(childSessionId, targetInfo, "container-resume");
      const result = await autoAttach;
      if (!result.ok) throw result.error;
    } catch (error) {
      recordSessionDiagnostic(
        "container-auto-attach",
        childSessionId,
        targetInfo,
        error,
      );
      recordFatal(
        "CDP container auto-attach failed: " +
          (error instanceof Error ? error.message : "protocol error"),
      );
    }
  };

  const resumePausedSession = async (
    childSessionId,
    targetInfo,
    stage = "child-resume",
  ) => {
    await sendCdp(
      session,
      "Runtime.runIfWaitingForDebugger",
      {},
      childSessionId,
    ).catch((error) => {
      recordSessionDiagnostic(stage, childSessionId, targetInfo, error);
      recordFatal(
        "CDP container auto-attach failed: " +
          (error instanceof Error ? error.message : "protocol error"),
      );
    });
  };

  const instrumentTarget = async (targetId, targetInfo, childSessionId) => {
    if (sessions.has(childSessionId)) {
      await resumePausedSession(childSessionId, targetInfo, "child-resume");
      return sessions.get(childSessionId)?.networkEnabled === true;
    }
    const state = {
      targetId,
      networkEnabled: false,
      scope: classifyTargetScope(targetInfo, extensionId()),
    };
    sessions.set(childSessionId, state);
    if (!attached.has(targetId))
      attached.set(targetId, {
        sessionId: childSessionId,
        scope: state.scope,
      });
    let networkEnabled = false;
    const autoAttach = sendCdp(
      session,
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      },
      childSessionId,
    ).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    const networkEnable = sendCdp(
      session,
      "Network.enable",
      {},
      childSessionId,
    ).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    const runtimeEnable = sendCdp(
      session,
      "Runtime.enable",
      {},
      childSessionId,
    ).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    let resumed = false;
    try {
      await resumePausedSession(childSessionId, targetInfo, "child-resume");
      resumed = true;
      try {
        const result = await autoAttach;
        if (!result.ok) throw result.error;
      } catch (error) {
        recordSessionDiagnostic(
          "child-auto-attach",
          childSessionId,
          targetInfo,
          error,
        );
        recordFatal(
          "CDP child auto-attach failed for " +
            (targetInfo.type ?? "unknown") +
            " target: " +
            (error instanceof Error ? error.message : "protocol error"),
        );
      }
      try {
        const result = await networkEnable;
        if (!result.ok) throw result.error;
        networkEnabled = true;
        state.networkEnabled = true;
      } catch (error) {
        recordFatal(
          "CDP Network.enable failed for " +
            (targetInfo.type ?? "unknown") +
            " target: " +
            (error instanceof Error ? error.message : "protocol error"),
        );
      }
      try {
        const result = await runtimeEnable;
        if (!result.ok) throw result.error;
      } catch (error) {
        limitations.push(
          "CDP Runtime.enable failed for " +
            (targetInfo.type ?? "unknown") +
            " target: " +
            (error instanceof Error ? error.message : "protocol error"),
        );
      }
    } finally {
      if (!resumed)
        await resumePausedSession(childSessionId, targetInfo, "child-resume");
      const currentOwner = targetOwners.get(targetId);
      if (currentOwner?.sessionId === childSessionId) {
        ledger.recordAttached(
          targetId,
          networkEnabled ||
            [...sessions.values()].some(
              (candidate) =>
                candidate.targetId === targetId && candidate.networkEnabled,
            ),
        );
      } else if (!currentOwner) {
        // A detached owner must not leave a stale covered/monitored entry
        // behind while a replacement is still unavailable.
        if (!destroyedTargets.has(targetId)) ledger.recordDetached(targetId);
      }
    }
    return networkEnabled;
  };

  const startPrimaryInstrumentation = (
    targetId,
    targetInfo,
    childSessionId,
  ) => {
    if (!sessionOrigins.has(childSessionId))
      sessionOrigins.set(childSessionId, "auto");
    if (!waitingForDebugger.has(childSessionId))
      waitingForDebugger.set(childSessionId, false);
    const owner = {
      targetId,
      sessionId: childSessionId,
      targetInfo,
      startedAt: Date.now(),
      ready: undefined,
    };
    targetOwners.set(targetId, owner);
    attached.set(targetId, {
      sessionId: childSessionId,
      scope: classifyTargetScope(targetInfo, extensionId()),
    });
    owner.ready = trackTask(
      instrumentTarget(targetId, targetInfo, childSessionId)
        .then((networkEnabled) => {
          owner.completedAt = Date.now();
          owner.networkEnabled = networkEnabled;
          return networkEnabled;
        })
        .catch((error) => {
          owner.completedAt = Date.now();
          owner.networkEnabled = false;
          throw error;
        }),
    );
    return owner;
  };

  const retireSecondarySession = (owner, childSessionId, targetInfo) => {
    const pending = pendingSessions.get(owner.targetId);
    if (!pending?.has(childSessionId)) return;
    trackTask(
      owner.ready
        .then(async (networkEnabled) => {
          const currentOwner = targetOwners.get(owner.targetId);
          if (currentOwner?.sessionId !== owner.sessionId) return;
          pending.delete(childSessionId);
          if (pending.size === 0) pendingSessions.delete(owner.targetId);
          if (networkEnabled && sessions.get(owner.sessionId)?.networkEnabled) {
            await sendCdp(session, "Target.detachFromTarget", {
              sessionId: childSessionId,
            }).catch((error) => {
              limitations.push(
                "CDP duplicate session detach failed: " +
                  (error instanceof Error ? error.message : "protocol error"),
              );
            });
            recordSessionLifecycle({
              kind: "duplicate-session-retired",
              stage: "secondary",
              targetId: owner.targetId,
              targetType: targetInfo?.type ?? "unknown",
              targetScope: classifyTargetScope(targetInfo, extensionId()),
              primarySessionId: owner.sessionId,
              secondarySessionId: childSessionId,
              owner: "primary",
              coveredByPrimary: true,
              primaryStartedAt: owner.startedAt,
              primaryCompletedAt: owner.completedAt ?? null,
            });
            return;
          }
          if (targetOwners.get(owner.targetId)?.sessionId !== owner.sessionId)
            return;
          targetOwners.delete(owner.targetId);
          startPrimaryInstrumentation(
            owner.targetId,
            targetInfo,
            childSessionId,
          );
          recordSessionLifecycle({
            kind: "secondary-promoted",
            stage: "secondary",
            targetId: owner.targetId,
            targetType: targetInfo?.type ?? "unknown",
            targetScope: classifyTargetScope(targetInfo, extensionId()),
            primarySessionId: owner.sessionId,
            secondarySessionId: childSessionId,
            owner: "secondary",
            coveredByPrimary: false,
            primaryStartedAt: owner.startedAt,
            primaryCompletedAt: owner.completedAt ?? null,
          });
        })
        .catch((error) => {
          limitations.push(
            "CDP duplicate session lifecycle failed: " +
              (error instanceof Error ? error.message : "protocol error"),
          );
        }),
    );
  };

  const queueSecondarySession = (owner, targetInfo, childSessionId) => {
    const pending = pendingSessions.get(owner.targetId) ?? new Map();
    pending.set(childSessionId, targetInfo);
    pendingSessions.set(owner.targetId, pending);
    recordSessionLifecycle({
      kind: "duplicate-session-queued",
      stage: "secondary",
      targetId: owner.targetId,
      targetType: targetInfo?.type ?? "unknown",
      targetScope: classifyTargetScope(targetInfo, extensionId()),
      primarySessionId: owner.sessionId,
      secondarySessionId: childSessionId,
      owner: "primary",
      coveredByPrimary: false,
      primaryStartedAt: owner.startedAt,
    });
    // Auto-attached duplicate targets are paused independently. Release a
    // paused secondary immediately so Chromium's debugger barrier can let the
    // primary enable/resume sequence complete. Manual or already-running
    // sessions retain the owner.ready retirement ordering below.
    if (waitingForDebugger.get(childSessionId) === true) {
      trackTask(
        resumePausedSession(childSessionId, targetInfo, "secondary-resume"),
      );
    }
    retireSecondarySession(owner, childSessionId, targetInfo);
  };

  const promotePendingSession = (targetId) => {
    if (targetOwners.has(targetId)) return;
    const pending = pendingSessions.get(targetId);
    const next = pending?.entries().next().value;
    if (!next) return;
    const [childSessionId, targetInfo] = next;
    pending.delete(childSessionId);
    if (pending.size === 0) pendingSessions.delete(targetId);
    startPrimaryInstrumentation(targetId, targetInfo, childSessionId);
  };

  const attachTarget = async (targetInfo) => {
    if (
      !targetInfo?.targetId ||
      attached.has(targetInfo.targetId) ||
      attaching.has(targetInfo.targetId)
    )
      return;
    const targetId = targetInfo.targetId;
    if (!monitorableTypes.has(targetInfo.type)) {
      ledger.recordTargetCreated(targetInfo);
      return;
    }
    attaching.add(targetId);
    ledger.recordTargetCreated(targetInfo);
    manualAttachTargets.add(targetId);
    try {
      const result = await sendCdp(session, "Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const sessionId = result.sessionId;
      if (!sessionId)
        throw new Error("Target.attachToTarget returned no session");
      sessionOrigins.set(sessionId, "manual");
      waitingForDebugger.set(sessionId, false);
      const owner = targetOwners.get(targetId);
      if (owner) {
        if (owner.sessionId !== sessionId)
          queueSecondarySession(owner, targetInfo, sessionId);
        await owner.ready;
      } else {
        await startPrimaryInstrumentation(targetId, targetInfo, sessionId)
          .ready;
      }
    } catch (error) {
      limitations.push(
        `CDP Network.enable failed for ${targetInfo.type ?? "unknown"} target: ${error instanceof Error ? error.message : "protocol error"}`,
      );
      const attachedSessionId = attached.get(targetId)?.sessionId;
      if (attachedSessionId) await resumePausedSession(attachedSessionId);
    } finally {
      manualAttachTargets.delete(targetId);
      attaching.delete(targetId);
    }
  };

  const unsubscribe = session.onEvent(({ method, params = {}, sessionId }) => {
    if (stopping) return;
    if (method === "Target.attachedToTarget") {
      const targetInfo = params.targetInfo;
      const targetId = targetInfo?.targetId;
      const childSessionId = params.sessionId;
      if (targetId && childSessionId) {
        sessionOrigins.set(
          childSessionId,
          manualAttachTargets.has(targetId) ? "manual-pending" : "auto",
        );
        if (typeof params.waitingForDebugger === "boolean")
          waitingForDebugger.set(childSessionId, params.waitingForDebugger);
      }
      if (
        targetId &&
        childSessionId &&
        !monitorableTypes.has(targetInfo?.type)
      ) {
        ledger.recordTargetCreated(targetInfo);
        void trackTask(configureContainer(childSessionId, targetInfo));
        return;
      }
      const owner = targetId ? targetOwners.get(targetId) : undefined;
      if (
        targetId &&
        childSessionId &&
        owner &&
        owner.sessionId !== childSessionId
      ) {
        ledger.recordTargetCreated(targetInfo);
        queueSecondarySession(owner, targetInfo, childSessionId);
        return;
      }
      if (targetId && childSessionId && sessions.has(childSessionId)) {
        // The first event registered this session and owns instrumentation.
        // A duplicate event must not resume it while enable ACKs are pending.
        return;
      } else if (targetId && childSessionId) {
        attaching.add(targetId);
        ledger.recordTargetCreated(targetInfo);
        void (async () => {
          try {
            await startPrimaryInstrumentation(
              targetId,
              targetInfo,
              childSessionId,
            ).ready;
          } catch (error) {
            limitations.push(
              `CDP auto-attached target enable failed for ${targetInfo.type ?? "unknown"} target: ${error instanceof Error ? error.message : "protocol error"}`,
            );
          } finally {
            attaching.delete(targetId);
          }
        })();
      }
    } else if (method === "Target.targetCreated") {
      // Target.setAutoAttach delivers the corresponding attachedToTarget event.
      // Keep this event as ledger metadata only; attaching here races that event
      // and can leave the automatically paused session uninstrumented.
      ledger.recordTargetCreated(params.targetInfo);
    } else if (method === "Target.targetInfoChanged") {
      if (params.targetInfo?.targetId) {
        ledger.recordTargetCreated(params.targetInfo);
        recordSessionLifecycle({
          kind: "target-info-changed",
          stage: "lifecycle",
          targetId: params.targetInfo.targetId,
          targetType: params.targetInfo.type ?? "unknown",
          targetScope: classifyTargetScope(params.targetInfo, extensionId()),
        });
      }
    } else if (method === "Target.targetDestroyed") {
      const targetId = params.targetId;
      if (targetId) {
        destroyedTargets.add(targetId);
        ledger.recordTargetDestroyed(targetId);
        const owner = targetOwners.get(targetId);
        recordSessionLifecycle({
          kind: "target-destroyed",
          stage: "lifecycle",
          targetId,
          targetType: owner?.targetInfo?.type ?? "unknown",
          targetScope: classifyTargetScope(
            owner?.targetInfo ?? {},
            extensionId(),
          ),
          ...(sessionId ? { childSessionId: sessionId } : {}),
        });
        targetOwners.delete(targetId);
        attached.delete(targetId);
        pendingSessions.delete(targetId);
        for (const [childSessionId, state] of sessions) {
          if (state.targetId === targetId) sessions.delete(childSessionId);
        }
      }
    } else if (method === "Target.detachedFromTarget") {
      const detachedSessionId = params.sessionId;
      const detachedState = detachedSessionId
        ? sessions.get(detachedSessionId)
        : undefined;
      const targetId = detachedState?.targetId ?? params.targetId;
      const ownerBeforeDetach = targetId
        ? targetOwners.get(targetId)
        : undefined;
      const ownerDetached =
        Boolean(detachedSessionId) &&
        ownerBeforeDetach?.sessionId === detachedSessionId;
      if (detachedSessionId)
        detachedSessions.set(detachedSessionId, {
          targetId: targetId ?? null,
          detachedAt: Date.now(),
        });
      if (detachedSessionId) sessions.delete(detachedSessionId);
      if (targetId) {
        if (
          !destroyedTargets.has(targetId) &&
          (ownerDetached || !ownerBeforeDetach)
        )
          ledger.recordDetached(targetId);
        if (ownerDetached || !ownerBeforeDetach)
          recordSessionLifecycle({
            kind: "target-detached",
            stage: "lifecycle",
            targetId,
            targetType: ownerBeforeDetach?.targetInfo?.type ?? "unknown",
            targetScope: classifyTargetScope(
              ownerBeforeDetach?.targetInfo ?? {},
              extensionId(),
            ),
            ...(detachedSessionId ? { childSessionId: detachedSessionId } : {}),
          });
        const pending = pendingSessions.get(targetId);
        if (detachedSessionId && pending?.has(detachedSessionId)) {
          pending.delete(detachedSessionId);
          if (pending.size === 0) pendingSessions.delete(targetId);
        }
        const owner = targetOwners.get(targetId);
        if (owner?.sessionId === detachedSessionId)
          targetOwners.delete(targetId);
        const primary = attached.get(targetId);
        if (primary?.sessionId === detachedSessionId) {
          const replacement = [...sessions.entries()].find(
            ([, state]) => state.targetId === targetId,
          );
          if (replacement)
            attached.set(targetId, {
              sessionId: replacement[0],
              scope: replacement[1].scope,
            });
          else attached.delete(targetId);
        }
        if (!detachedSessionId)
          for (const [childSessionId, state] of sessions)
            if (state.targetId === targetId) sessions.delete(childSessionId);
        if (owner?.sessionId === detachedSessionId) {
          promotePendingSession(targetId);
        }
      }
    } else if (sessionId) {
      const state = sessions.get(sessionId);
      if (state) handleChildEvent(state.targetId, method, params);
    }
  });

  const attachExisting = async (targetInfos) => {
    await Promise.all(
      (targetInfos ?? [])
        .filter((targetInfo) => monitorableTypes.has(targetInfo.type))
        .map((targetInfo) => attachTarget(targetInfo)),
    );
  };

  const waitForPendingTasks = async () => {
    const deadline = Date.now() + cdpTimeoutMs;
    while (pendingTasks.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const tasks = [...pendingTasks];
      await Promise.race([
        Promise.allSettled(tasks),
        new Promise((resolve) => globalThis.setTimeout(resolve, remaining)),
      ]);
    }
    return pendingTasks.size === 0;
  };

  return {
    limitations,
    fatalErrors: fatalMonitorErrors,
    sessionDiagnostics,
    attached,
    stop() {
      if (!stopPromise) {
        stopping = true;
        stopPromise = (async () => {
          if (!(await waitForPendingTasks()))
            throw new Error("Monitor tasks remained pending at cleanup");
          const ids = [...sessions.keys()];
          const tolerateEndedSession = async (operation) => {
            try {
              await operation();
            } catch (error) {
              if (
                !/^(?:No session with given id|Session with given id not found)\.?$/.test(
                  error.message,
                )
              )
                throw error;
            }
          };
          // Release child debugger barriers and auto-attach while the transport lives.
          await Promise.all(
            ids.map(async (id) => {
              await tolerateEndedSession(() =>
                sendCdp(session, "Runtime.runIfWaitingForDebugger", {}, id),
              );
              await tolerateEndedSession(() =>
                sendCdp(
                  session,
                  "Target.setAutoAttach",
                  {
                    autoAttach: false,
                    waitForDebuggerOnStart: false,
                    flatten: true,
                  },
                  id,
                ),
              );
            }),
          );
          await sendCdp(session, "Target.setAutoAttach", {
            autoAttach: false,
            waitForDebuggerOnStart: false,
            flatten: true,
          });
          await sendCdp(session, "Target.setDiscoverTargets", {
            discover: false,
          });
          await Promise.all(
            ids.map((id) =>
              tolerateEndedSession(() =>
                sendCdp(session, "Target.detachFromTarget", { sessionId: id }),
              ),
            ),
          );
        })().finally(() => {
          unsubscribe?.();
        });
      }
      return stopPromise;
    },
    async start() {
      await sendCdp(session, "Target.setDiscoverTargets", { discover: true });
      await sendCdp(session, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      const existing = await sendCdp(session, "Target.getTargets");
      for (const targetInfo of existing.targetInfos ?? [])
        ledger.recordTargetCreated(targetInfo);
      await attachExisting(existing.targetInfos);
    },
    async snapshot({ refresh = true, requireExtensionRuntime = false } = {}) {
      if (refresh) {
        const targets = await sendCdp(session, "Target.getTargets");
        for (const targetInfo of targets.targetInfos ?? [])
          ledger.recordTargetCreated(targetInfo);
        await attachExisting(
          (targets.targetInfos ?? []).filter(
            (targetInfo) => !attached.has(targetInfo.targetId),
          ),
        );
      }
      const pendingComplete = await waitForPendingTasks();
      if (!pendingComplete)
        limitations.push(
          "CDP monitor tasks remained pending at snapshot deadline",
        );
      const snapshot = ledger.snapshot({ requireExtensionRuntime });
      return {
        ...snapshot,
        coverageComplete:
          snapshot.coverageComplete &&
          fatalMonitorErrors.length === 0 &&
          pendingComplete,
        fatalMonitorErrors: [...fatalMonitorErrors],
        sessionDiagnostics: [...sessionDiagnostics],
        pendingMonitorTasks: pendingTasks.size,
      };
    },
  };
}
async function sampleProcessMemory(profilePath, cdp) {
  if (process.platform === "linux")
    return sampleLinuxBrowserMemory({
      getProcessInfo: () => sendCdp(cdp, "SystemInfo.getProcessInfo"),
    });
  if (process.platform === "win32")
    return sampleWindowsBrowserMemory({
      powershell: process.env.KOTOBA_GUARD_POWERSHELL,
      getProcessInfo: () => sendCdp(cdp, "SystemInfo.getProcessInfo"),
    });
  return { rows: [], status: "unavailable", reason: "unsupported-platform" };
}

async function measureJsHeap(page) {
  try {
    return await page.evaluate(() => {
      const memory = globalThis.performance?.memory;
      if (!memory) return null;
      return {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
      };
    });
  } catch {
    return null;
  }
}

export async function startProcessSampler(
  profilePath,
  samples,
  cdp,
  { sampleMemory = sampleProcessMemory } = {},
) {
  const sample = async (label) => {
    const started = Date.now();
    const snapshot = await sampleMemory(profilePath, cdp);
    samples.push({
      label,
      timestamp: Date.now(),
      durationMs: Date.now() - started,
      ...snapshot,
    });
  };
  // Capture the baseline before inference even when shell startup is slow.
  await sample("initial");
  const sampler = createSerialSampler(sample);
  const timer = globalThis.setInterval(() => sampler.tick("interval"), 1_000);
  let stopping;
  return () => {
    if (!stopping) {
      globalThis.clearInterval(timer);
      stopping = sampler.stop("final");
    }
    return stopping;
  };
}

function startHeapSampler(page, samples) {
  const sample = async (label) => {
    const value = await measureJsHeap(page);
    if (value) samples.push({ label, timestamp: Date.now(), ...value });
  };
  const sampler = createSerialSampler(sample);
  sampler.tick("initial");
  const timer = globalThis.setInterval(() => sampler.tick("interval"), 250);
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    globalThis.clearInterval(timer);
    await sampler.stop("final");
  };
}

export async function runExtensionInference({
  context,
  page,
  cdp,
  extensionId,
  origin,
  jsHeapSamples,
  cleanupEvidence = {},
}) {
  const { targetInfos } = await sendCdp(cdp, "Target.getTargets", {
    filter: [{ type: "tab", exclude: false }],
  });
  const pageTarget = targetInfos.find((target) =>
    target.url.startsWith(origin),
  );
  if (!pageTarget) throw new Error("Fixture page target was not discoverable");
  await context.setOffline(true);
  await page.bringToFront();
  await sendCdp(cdp, "Extensions.triggerAction", {
    id: extensionId,
    targetId: pageTarget.targetId,
  });
  const popup = await context.newPage();
  let result;
  let failure;
  let closed;
  try {
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const tabId = await popup.evaluate(async (fixtureOrigin) => {
      const tabs = await globalThis.chrome.tabs.query({});
      return tabs.find((tab) => tab.url?.startsWith(fixtureOrigin))?.id;
    }, origin);
    if (typeof tabId !== "number")
      throw new Error("Fixture tab was not available to extension action");
    const check = async (text, expectedMark = "") => {
      await page.locator("textarea").fill(text);
      if ((await page.locator(".kotoba-guard-mark").count()) !== 0)
        throw new Error("Previous marks were not cleared before inference");
      const selectionBefore = await page
        .locator("textarea")
        .evaluate((element) => ({
          value: element.value,
          selectionStart: element.selectionStart,
          selectionEnd: element.selectionEnd,
        }));
      const response = await popup.evaluate(
        (id) =>
          globalThis.chrome.runtime.sendMessage({
            type: "manual-check",
            tabId: id,
          }),
        tabId,
      );
      if (!response?.ok) throw new Error("Extension manual check was rejected");
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const status = await popup.evaluate(
          (id) =>
            globalThis.chrome.runtime.sendMessage({
              type: "get-status",
              tabId: id,
            }),
          tabId,
        );
        if (status?.lastError)
          throw new Error("Extension inference reported an error");
        const mark = page.locator(".kotoba-guard-mark").filter({
          hasText: expectedMark,
        });
        if (
          status?.modelReady &&
          status.backend === "wasm" &&
          expectedMark &&
          (await mark.count()) > 0
        ) {
          const selectionAfter = await page
            .locator("textarea")
            .evaluate((element) => ({
              value: element.value,
              selectionStart: element.selectionStart,
              selectionEnd: element.selectionEnd,
            }));
          if (
            selectionAfter.value !== selectionBefore.value ||
            selectionAfter.selectionStart !== selectionBefore.selectionStart ||
            selectionAfter.selectionEnd !== selectionBefore.selectionEnd
          )
            throw new Error("Inference changed textarea value or selection");
          return;
        }
        await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
      }
      throw new Error("Extension inference did not produce the expected mark");
    };
    await check(
      "明日の予定については、来週移行にご連絡します。 #initial",
      "移行",
    );
    await check(
      "明日の予定については、来週移行にご連絡します。 #second",
      "移行",
    );
    await check(
      `${"これは長文の境界を確認するための正常な文章です。".repeat(180)}明日の予定については、来週移行にご連絡します。`,
      "移行",
    );
    await check("連続入力の一つ目は来週移行です。 #one", "移行");
    await check("連続入力の二つ目は来週移行です。 #two", "移行");
    await check("連続入力の三つ目は来週移行です。 #three", "移行");
    const heap = await measureJsHeap(page);
    if (heap)
      jsHeapSamples.push({
        label: "after-offline-inference",
        timestamp: Date.now(),
        ...heap,
      });
    result = {
      offlineBeforeAction: true,
      completedChecks: 6,
      previousMarksCleared: 6,
      backend: "wasm",
    };
  } catch (error) {
    failure = error;
  } finally {
    closed = await boundedResult(
      async () => {
        await popup.close();
        return true;
      },
      false,
      5_000,
    );
    cleanupEvidence.popup = closed;
  }
  if (failure) throw failure;
  if (!closed) throw new Error("Audit popup cleanup failed");
  return result;
}

async function detectExtensionId(context) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const worker = context
      .serviceWorkers()
      .find((candidate) => candidate.url().startsWith("chrome-extension://"));
    const page = context
      .pages()
      .find((candidate) => candidate.url().startsWith("chrome-extension://"));
    const value = worker?.url() ?? page?.url();
    const match = value?.match(/^chrome-extension:\/\/([^/]+)/);
    if (match?.[1]) return safeExtensionId(match[1]);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  }
  throw new Error("Extension service worker was not discoverable");
}

async function detectExtensionServiceWorkerId(context) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const worker = context
      .serviceWorkers()
      .find((candidate) => candidate.url().startsWith("chrome-extension://"));
    const match = worker?.url().match(/^chrome-extension:\/\/([^/]+)/);
    if (match?.[1]) return safeExtensionId(match[1]);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  }
  throw new Error("Extension background service worker was not discoverable");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  args.extensionDir = resolve(args.extensionDir);
  const evidence = await prepareAuditEvidence({
    output: args.output,
    extensionDir: args.extensionDir,
    sourceOptions: {
      expectedCommit: process.env.SOURCE_COMMIT ?? process.env.GITHUB_SHA,
    },
  });
  let fixture;
  let profilePath;
  const processSamples = [];
  const jsHeapSamples = [];
  let browser;
  let context;
  let cdp;
  let stopProcessSampler;
  let stopHeapSampler;
  let report;
  let stage = "startup";
  const auditLimitations = [];
  let fixtureUrls;
  let fixturePage;
  let ledger;
  let monitor;
  let assetIdentity;
  let postflightBinding;
  const inferenceCleanup = {};
  try {
    stage = "model-preflight";
    assetIdentity = {
      ...(await collectAssetIdentity(args.extensionDir)),
      distribution: evidence.binding.distribution,
    };
    fixture = createFixtureServer();
    const cdpPort = await reservePort();
    profilePath = await mkdtemp(join(tmpdir(), auditPrefix));
    stage = "fixture-listen";
    fixtureUrls = await fixture.listen();
    stage = "chromium-launch";
    context = await chromium.launchPersistentContext(profilePath, {
      headless: true,
      channel: "chromium",
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        "--enable-unsafe-extension-debugging",
        "--enable-precise-memory-info",
        "--disable-background-networking",
        `--remote-debugging-port=${cdpPort}`,
        "--remote-allow-origins=*",
      ],
    });
    browser = context.browser();
    stage = "cdp-connect";
    const cdpEndpoint = await getBrowserCdpEndpoint(cdpPort);
    cdp = createRawCdpClient(cdpEndpoint);
    const browserVersion = await sendCdp(cdp, "Browser.getVersion");
    const scriptSha256 = await auditScriptSha256();
    const extensionIdentity = { value: undefined };
    ledger = createAuditLedger({
      extensionId: "pending-extension-id",
      fixtureUrls,
    });
    monitor = createCdpMonitor(cdp, ledger, extensionIdentity);
    stage = "monitor-start";
    await monitor.start();
    stage = "extension-load";
    const loadResult = await sendCdp(cdp, "Extensions.loadUnpacked", {
      path: args.extensionDir,
    });
    const extensionId = safeExtensionId(
      loadResult.id ?? (await detectExtensionId(context)),
    );
    const loadedWorkerExtensionId =
      await detectExtensionServiceWorkerId(context);
    if (loadedWorkerExtensionId !== extensionId)
      throw new Error(
        "Loaded extension service worker id did not match unpacked extension",
      );
    extensionIdentity.value = extensionId;
    ledger.setExtensionId(extensionId);
    const page = await context.newPage();
    fixturePage = page;
    stopProcessSampler = await startProcessSampler(
      profilePath,
      processSamples,
      cdp,
    );
    stopHeapSampler = startHeapSampler(page, jsHeapSamples);
    stage = "fixture-navigation";
    await page.goto(fixtureUrls.root, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => globalThis.__kgAuditReady === true,
      undefined,
      { timeout: 10_000 },
    );
    await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
    stage = "positive-control-snapshot";
    const positiveControl = await monitor.snapshot();
    stage = "offline-inference";
    const offlineEvidence = await runExtensionInference({
      context,
      page,
      cdp,
      extensionId,
      origin: new URL(fixtureUrls.root).origin,
      jsHeapSamples,
      cleanupEvidence: inferenceCleanup,
    });
    stage = "final-coverage-snapshot";
    const finalCoverage = await monitor.snapshot({
      requireExtensionRuntime: true,
    });
    const network = {
      unexpectedRequests: finalCoverage.events
        .filter((event) => !event.allowed)
        .map((event) => ({
          kind: event.kind,
          safeUrl: event.safeUrl,
          targetScope: event.targetScope,
        })),
      events: finalCoverage.events,
    };
    const processSamplerStopped = await boundedResult(
      async () => {
        await stopProcessSampler();
        return true;
      },
      false,
      processSamplerStopTimeoutMs,
    );
    if (!processSamplerStopped)
      auditLimitations.push(
        "Process memory sampler did not stop before its deadline.",
      );
    const heapSamplerStopped = await boundedResult(async () => {
      await stopHeapSampler();
      return true;
    }, false);
    if (!heapSamplerStopped)
      auditLimitations.push(
        "JavaScript heap sampler did not stop before its deadline; heap samples are partial.",
      );
    const processReportSamples = processSamples.map((sample) => {
      const totals = sumProcessMemory(sample.rows);
      return {
        label: sample.label,
        timestamp: sample.timestamp,
        durationMs: sample.durationMs,
        status: sample.status,
        scope: sample.scope,
        ...(sample.reason ? { reason: sample.reason } : {}),
        ...(sample.queryExitCode !== undefined
          ? { queryExitCode: sample.queryExitCode }
          : {}),
        ...(sample.missingPids ? { missingPids: sample.missingPids } : {}),
        processCount: sample.rows.length,
        currentBytes: sample.rows.length ? totals.currentBytes : null,
        peakHwmBytes: sample.rows.length ? totals.peakBytes : null,
        processes: sample.rows.map(
          ({ pid, parentPid, role, currentBytes, peakBytes }) => ({
            pid,
            ...(parentPid !== undefined ? { parentPid } : {}),
            ...(role !== undefined ? { role } : {}),
            currentBytes,
            peakHwmBytes: peakBytes,
          }),
        ),
      };
    });
    const hasProcessSamples = processReportSamples.some(
      (sample) => sample.processCount > 0,
    );
    const processSamplesComplete =
      processReportSamples.length > 0 &&
      processReportSamples.every((sample) => sample.status === "measured");
    const securityGateFailures = [];
    if (!finalCoverage.coverageComplete)
      securityGateFailures.push("extension-or-fixture-coverage-incomplete");
    if (network.unexpectedRequests.length > 0)
      securityGateFailures.push("unexpected-extension-network-request");
    const resourceGateFailures = [];
    if (!processSamplerStopped || !processSamplesComplete)
      resourceGateFailures.push("process-memory-incomplete");
    if (!heapSamplerStopped || jsHeapSamples.length === 0)
      resourceGateFailures.push("javascript-heap-incomplete");
    const releaseGateFailures = [
      ...securityGateFailures,
      ...resourceGateFailures,
    ];
    stage = "identity-postflight";
    postflightBinding = {
      source: await captureSourceIdentity({
        expectedCommit: evidence.binding.source.commit,
      }),
      distribution: await collectDistributionInventory(args.extensionDir),
    };
    verifyAuditIdentity(evidence.binding, postflightBinding);
    report = {
      schemaVersion: 2,
      evidenceBinding: {
        before: evidence.binding,
        after: postflightBinding,
        verified: true,
      },
      execution: {
        status: "completed",
        gate: {
          passed: releaseGateFailures.length === 0,
          failures: releaseGateFailures,
          securityFailures: securityGateFailures,
          resourceFailures: resourceGateFailures,
        },
      },
      environment: {
        platform: process.platform,
        node: process.version,
        browserVersion,
        auditScriptSha256: scriptSha256,
        sourceCommit: evidence.binding.source.commit,
        sourceTree: evidence.binding.source.tree,
        sourceClean: true,
      },
      assetIdentity,
      extension: { extensionDir: "<configured-extension-dir>", extensionId },
      positiveControl,
      extensionRuntime: finalCoverage,
      network,
      offline: {
        ...offlineEvidence,
        enabledAfterPositiveControl: true,
        inferenceStatus:
          "offline-first-short-long-sequential-real-model-complete",
      },
      processMemory: {
        status: !hasProcessSamples
          ? "unavailable"
          : processSamplerStopped && processSamplesComplete
            ? "measured"
            : "partial",
        ...(process.platform === "win32" || process.platform === "linux"
          ? {
              available: hasProcessSamples,
              method:
                process.platform === "win32"
                  ? "cdp-process-ids-and-get-process"
                  : "cdp-process-ids-and-procfs",
              scope: "cdp-associated-browser-processes",
            }
          : platformMemorySupport(process.platform)),
        ...(hasProcessSamples
          ? {}
          : { available: false, reason: "no-valid-process-memory-samples" }),
        samples: processReportSamples,
        peakObservedHwmBytes: hasProcessSamples
          ? Math.max(
              0,
              ...processSamples.map(
                (sample) => sumProcessMemory(sample.rows).peakBytes,
              ),
            )
          : null,
      },
      jsHeap: {
        status:
          !heapSamplerStopped || jsHeapSamples.length === 0
            ? "unavailable"
            : "measured",
        samples: jsHeapSamples,
      },
      limitations: [
        "This audit measures browser process memory separately from JavaScript heap; it does not treat one as the other.",
        "Process-tree samples are point-in-time; a child that exits or a PID reused during sampling can be omitted from that sample.",
        "Samples query the browser endpoint's CDP process IDs and OS byte metrics only (Get-Process on Windows; procfs on Linux). Helper processes omitted by CDP are outside that cohort.",
        "Summed per-process high-water marks are not a simultaneous RSS peak. Process churn and inaccessible PIDs make samples partial rather than zero.",
        "The CDP observer starts after Chromium launches and before Extensions.loadUnpacked; browser bootstrap traffic before observer setup is outside this event sample.",
        "The audit uses only synthetic fixture text and does not record inference input or output text.",
        ...auditLimitations,
        ...monitor.limitations,
      ],
    };
    if (releaseGateFailures.length > 0) process.exitCode = 1;
  } catch (error) {
    const observedFixtureControls = fixturePage
      ? await boundedResult(
          () =>
            fixturePage.evaluate(() =>
              Array.isArray(globalThis.__kgAuditControls)
                ? globalThis.__kgAuditControls
                : [],
            ),
          undefined,
        )
      : undefined;
    if (observedFixtureControls === undefined)
      auditLimitations.push(
        "Fixture control read was unavailable before its deadline.",
      );
    const processSamplerStoppedOnFailure = stopProcessSampler
      ? await boundedResult(
          async () => {
            await stopProcessSampler();
            return true;
          },
          false,
          processSamplerStopTimeoutMs,
        )
      : true;
    if (!processSamplerStoppedOnFailure)
      auditLimitations.push(
        "Process memory sampler did not stop before its failure deadline.",
      );
    const heapSamplerStoppedOnFailure = stopHeapSampler
      ? await boundedResult(async () => {
          await stopHeapSampler();
          return true;
        }, false)
      : true;
    if (!heapSamplerStoppedOnFailure)
      auditLimitations.push(
        "JavaScript heap sampler did not stop before its failure deadline; heap samples are partial.",
      );
    const partialCoverage = monitor
      ? await boundedResult(
          () => monitor.snapshot({ refresh: false }),
          undefined,
        )
      : undefined;
    report = {
      schemaVersion: 2,
      status: "failed",
      stage,
      error: sanitizeAuditDiagnostic(
        error instanceof Error ? error.message : "audit failed",
      ),
      fixtureControls: {
        required: requiredFixtureControls,
        observed: observedFixtureControls ?? [],
        status: observedFixtureControls === undefined ? "unavailable" : "read",
      },
      partialCoverage,
      assetIdentity,
      evidenceBinding: {
        before: evidence.binding,
        ...(postflightBinding ? { after: postflightBinding } : {}),
        verified: false,
      },
      limitations: [
        "No user input or request bodies are recorded.",
        ...auditLimitations,
        ...(monitor?.limitations ?? []),
      ],
    };
    process.exitCode = 1;
  } finally {
    if (stopProcessSampler)
      await boundedResult(
        async () => {
          await stopProcessSampler();
          return true;
        },
        false,
        processSamplerStopTimeoutMs,
      );
    if (stopHeapSampler)
      await boundedResult(async () => {
        await stopHeapSampler();
        return true;
      }, false);
    const cleanup = {
      ...inferenceCleanup,
      ...(await cleanupAuditResources({
        monitor,
        cdp,
        context,
        browser,
        fixture,
      })),
    };
    const resolvedProfile = profilePath ? resolve(profilePath) : undefined;
    if (
      resolvedProfile &&
      dirname(resolvedProfile) === resolve(tmpdir()) &&
      basename(resolvedProfile).startsWith(auditPrefix)
    ) {
      cleanup.profile = await boundedResult(
        async () => {
          await rm(resolvedProfile, { recursive: true, force: true });
          return true;
        },
        false,
        5_000,
      );
    }
    report.cleanup = {
      schemaVersion: 3,
      completed: Object.values(cleanup).every(Boolean),
      operations: cleanup,
    };
    if (!report.cleanup.completed) {
      process.exitCode = 1;
      if (report.execution?.gate) {
        report.execution.gate.passed = false;
        report.execution.gate.failures.push("cleanup-incomplete");
        report.execution.gate.resourceFailures.push("cleanup-incomplete");
      }
    }
    try {
      await evidence.reportFile.writeFile(
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8",
      );
    } finally {
      await evidence.reportFile.close();
    }
  }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1]))
  main().catch(() => {
    process.exitCode = 1;
  });
