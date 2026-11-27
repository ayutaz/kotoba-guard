import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const FIXTURE_SCOPES = new Set([
  "page",
  "dedicatedworker",
  "fixture-service-worker",
  "sharedworker",
]);

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function webSocketAccept(key) {
  if (typeof key !== "string" || key.length === 0)
    throw new TypeError("WebSocket key must be a non-empty string");
  return createHash("sha1")
    .update(`${key}${WEBSOCKET_GUID}`, "ascii")
    .digest("base64");
}

export function createSerialSampler(sample) {
  let inFlight;
  let stopped = false;
  const tick = (label) => {
    if (stopped || inFlight) return false;
    inFlight = Promise.resolve()
      .then(() => sample(label))
      .catch(() => undefined)
      .finally(() => {
        inFlight = undefined;
      });
    return true;
  };
  return {
    tick,
    async stop(finalLabel) {
      stopped = true;
      if (inFlight) await inFlight;
      if (finalLabel !== undefined) await sample(finalLabel);
    },
  };
}

export function verifyArtifactManifest(manifest, actualEntries) {
  const declared = manifest?.files ?? manifest?.artifacts;
  const declaredEntries = Array.isArray(declared)
    ? declared
    : declared && typeof declared === "object"
      ? Object.entries(declared).map(([path, value]) => ({
          path,
          ...(value && typeof value === "object" ? value : {}),
        }))
      : [];
  const actual = new Map(
    (actualEntries ?? []).map((entry) => [entry.path, entry]),
  );
  const missing = [];
  const mismatches = [];
  const malformed = [];
  if (declaredEntries.length === 0) malformed.push("manifest.files");
  for (const [index, entry] of declaredEntries.entries()) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) {
      malformed.push(`manifest.files[${index}]`);
      continue;
    }
    const observed = actual.get(entry.path);
    if (!observed) {
      missing.push(entry.path);
      continue;
    }
    if (observed.bytes !== entry.bytes && observed.bytes !== entry.size)
      mismatches.push({ path: entry.path, field: "bytes" });
    if (
      typeof entry.sha256 !== "string" ||
      observed.sha256.toLowerCase() !== entry.sha256.toLowerCase()
    )
      mismatches.push({ path: entry.path, field: "sha256" });
  }
  return {
    ok:
      malformed.length === 0 && missing.length === 0 && mismatches.length === 0,
    missing,
    mismatches,
    malformed,
    declaredCount: declaredEntries.length,
  };
}

export function selectProcessTreeRows(rows, profilePath) {
  const normalizedProfile = String(profilePath ?? "")
    .replaceAll("\\", "/")
    .toLowerCase();
  if (!normalizedProfile) return [];
  const candidates = (rows ?? [])
    .map((row) => ({
      row,
      pid: numberValue(row?.pid ?? row?.ProcessId),
      parentPid: numberValue(row?.parentPid ?? row?.ParentProcessId),
      commandLine: String(row?.commandLine ?? row?.CommandLine ?? "")
        .replaceAll("\\", "/")
        .toLowerCase(),
    }))
    .filter((candidate) => candidate.pid !== null);
  const selected = new Set(
    candidates
      .filter((candidate) => candidate.commandLine.includes(normalizedProfile))
      .map((candidate) => candidate.pid),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (
        candidate.parentPid !== null &&
        selected.has(candidate.parentPid) &&
        !selected.has(candidate.pid)
      ) {
        selected.add(candidate.pid);
        changed = true;
      }
    }
  }
  return candidates
    .filter((candidate) => selected.has(candidate.pid))
    .map((candidate) => candidate.row);
}

export function isDirectEntrypoint(importUrl, argvPath) {
  if (!argvPath) return false;
  if (importUrl === pathToFileURL(argvPath).href) return true;
  return (
    /^[A-Za-z]:\\/.test(argvPath) &&
    importUrl === `file:///${argvPath.replaceAll("\\", "/")}`
  );
}

function extensionOrigin(extensionId) {
  return `chrome-extension://${extensionId}`;
}

export function isExtensionUrl(value, extensionId) {
  if (typeof value !== "string" || !extensionId) return false;
  try {
    const url = new URL(value);
    return url.protocol === "chrome-extension:" && url.hostname === extensionId;
  } catch {
    return false;
  }
}

export function classifyTargetScope(targetInfo, extensionId) {
  const type = targetInfo?.type ?? "unknown";
  const url = typeof targetInfo?.url === "string" ? targetInfo.url : "";
  const isExtension = isExtensionUrl(url, extensionId);
  if (isExtension) {
    try {
      const pathname = new URL(url).pathname;
      if (pathname === "/offscreen.html") return "offscreen";
      if (pathname === "/popup.html") return "page";
    } catch {
      /* Fall through to type-based classification. */
    }
  }
  if (type === "tab") return "tab-container";
  if (type === "service_worker")
    return isExtension ? "background-service-worker" : "fixture-service-worker";
  if (type === "worker")
    return isExtension ? "extension-dedicatedworker" : "dedicatedworker";
  if (type === "shared_worker") return "sharedworker";
  if (type === "browser_ui") return "browser-ui";
  if (type === "other") return isExtension ? "unknown" : "other-target";
  if (type === "page" || type === "tab") return "page";
  return "unknown";
}

function exactFixtureUrl(value, fixtureUrls) {
  return Object.values(fixtureUrls ?? {}).some(
    (candidate) => candidate === value,
  );
}

export function sanitizeUrl(value, options = {}) {
  if (typeof value !== "string") return "<invalid-url>";
  if (exactFixtureUrl(value, options.fixtureUrls)) return value;
  try {
    const url = new URL(value);
    if (
      url.protocol === "chrome-extension:" &&
      url.hostname === options.extensionId
    ) {
      return `${extensionOrigin(options.extensionId)}<redacted>`;
    }
    return `${url.protocol}//${url.host}/<redacted>`;
  } catch {
    return "<invalid-url>";
  }
}

function isFixtureRootNavigation({
  url,
  targetScope,
  resourceType,
  isNavigation,
  fixtureUrls,
}) {
  return (
    targetScope === "page" &&
    resourceType === "Document" &&
    isNavigation === true &&
    url === fixtureUrls?.root
  );
}

function isFixtureControl(url, fixtureUrls) {
  return (
    url === fixtureUrls?.control ||
    url === fixtureUrls?.script ||
    url === fixtureUrls?.websocket
  );
}

function isFixtureBlobScript({ url, targetScope, resourceType, fixtureUrls }) {
  if (targetScope !== "page" && targetScope !== "dedicatedworker") return false;
  if (resourceType !== "Script") return false;
  try {
    const blobUrl = new URL(url);
    const fixtureUrl = new URL(fixtureUrls?.root);
    return blobUrl.protocol === "blob:" && blobUrl.origin === fixtureUrl.origin;
  } catch {
    return false;
  }
}

export function classifyNetworkEvent({
  url,
  targetScope,
  resourceType = "Other",
  isNavigation = false,
  fixtureUrls = {},
  extensionId,
  extensionOwned = false,
}) {
  const safeUrl = sanitizeUrl(url, { fixtureUrls, extensionId });
  const inferredExtension =
    extensionOwned ||
    new Set([
      "offscreen",
      "background-service-worker",
      "extension-dedicatedworker",
    ]).has(targetScope) ||
    isExtensionUrl(url, extensionId);
  if (inferredExtension) {
    if (isExtensionUrl(url, extensionId)) {
      return {
        kind: "extension-local",
        allowed: true,
        safeUrl,
        targetScope,
        resourceType,
      };
    }
    return {
      kind: "extension-request",
      allowed: false,
      safeUrl,
      targetScope,
      resourceType,
    };
  }
  if (
    isFixtureRootNavigation({
      url,
      targetScope,
      resourceType,
      isNavigation,
      fixtureUrls,
    })
  ) {
    return {
      kind: "fixture-navigation",
      allowed: true,
      safeUrl,
      targetScope,
      resourceType,
    };
  }
  if (isFixtureControl(url, fixtureUrls) && FIXTURE_SCOPES.has(targetScope)) {
    return {
      kind: "fixture-control",
      allowed: true,
      safeUrl,
      targetScope,
      resourceType,
    };
  }
  if (isFixtureBlobScript({ url, targetScope, resourceType, fixtureUrls })) {
    return {
      kind: "fixture-worker-blob-script",
      allowed: true,
      safeUrl,
      targetScope,
      resourceType,
    };
  }
  return {
    kind: "unexpected-page-request",
    allowed: false,
    safeUrl,
    targetScope,
    resourceType,
  };
}

function addCount(map, key) {
  if (map instanceof Map) map.set(key, (map.get(key) ?? 0) + 1);
  else map[key] = (map[key] ?? 0) + 1;
}

export function createAuditLedger({ extensionId, fixtureUrls }) {
  const targets = new Map();
  const targetInfos = new Map();
  const events = [];
  const eventInputs = [];
  let currentExtensionId = extensionId;
  const controls = new Map();
  const httpControls = new Map();
  const webSocketControls = new Map();
  const expectedControlScopes = new Set([
    "page",
    "dedicatedworker",
    "fixture-service-worker",
  ]);
  const expectedWebSocketScopes = new Set(["page", "dedicatedworker"]);

  function targetOrCreate(targetId, targetInfo = {}) {
    const previousInfo = targetInfos.get(targetId) ?? {};
    const mergedInfo = {
      ...previousInfo,
      ...(targetInfo.type !== undefined ? { type: targetInfo.type } : {}),
      ...(targetInfo.url !== undefined ? { url: targetInfo.url } : {}),
    };
    if (
      targetInfo.type !== undefined ||
      targetInfo.url !== undefined ||
      !targetInfos.has(targetId)
    )
      targetInfos.set(targetId, mergedInfo);
    const info = targetInfos.get(targetId) ?? mergedInfo;
    let target = targets.get(targetId);
    if (!target) {
      const scope = classifyTargetScope(info, currentExtensionId);
      target = {
        targetId,
        type: info.type ?? "unknown",
        scope,
        extensionOwned: isExtensionUrl(info.url, currentExtensionId),
        attached: false,
        networkEnabled: false,
        networkEnabledEver: false,
        lifecycle: "live",
        terminated: false,
        terminatedCovered: false,
        detachedPendingTermination: false,
        monitoringGap: false,
        monitoringGapCount: 0,
        coverageStatus: "live-unmonitored",
        httpRequests: 0,
        webSockets: 0,
        unexpectedRequests: 0,
      };
      targets.set(targetId, target);
    }
    if (
      target &&
      (targetInfo.type !== undefined || targetInfo.url !== undefined)
    ) {
      target.scope = classifyTargetScope(info, currentExtensionId);
      target.extensionOwned = isExtensionUrl(info.url, currentExtensionId);
      target.type = info.type ?? "unknown";
    }
    return target;
  }

  return {
    setExtensionId(value) {
      currentExtensionId = value;
      for (const target of targets.values()) {
        const info = targetInfos.get(target.targetId) ?? target;
        target.scope = classifyTargetScope(info, currentExtensionId);
        target.extensionOwned = isExtensionUrl(
          info.url ?? "",
          currentExtensionId,
        );
        target.unexpectedRequests = 0;
      }
      controls.clear();
      httpControls.clear();
      webSocketControls.clear();
      for (const input of eventInputs) {
        const target = targets.get(input.event.targetId);
        if (!target) continue;
        const classification = classifyNetworkEvent({
          url: input.url,
          targetScope: target.scope,
          resourceType: input.resourceType,
          isNavigation: input.isNavigation,
          fixtureUrls,
          extensionId: currentExtensionId,
          extensionOwned: target.extensionOwned,
        });
        Object.assign(input.event, classification);
        if (!classification.allowed) target.unexpectedRequests += 1;
        if (classification.kind === "fixture-control") {
          addCount(controls, target.scope);
          addCount(
            input.webSocket ? webSocketControls : httpControls,
            target.scope,
          );
        }
      }
    },
    recordTargetCreated(targetInfo) {
      const targetId = targetInfo.targetId ?? targetInfo.targetIdString;
      if (!targetId) return;
      if (targets.get(targetId)?.lifecycle === "destroyed") return;
      const target = targetOrCreate(targetId, targetInfo);
      // A target-info update after a detach proves that the target is still
      // live. Keep the monitoring gap visible until a new session is enabled.
      if (target.lifecycle === "detached") {
        target.detachedPendingTermination = false;
        target.monitoringGap = true;
        target.monitoringGapCount += 1;
      }
    },
    recordAttached(targetId, networkEnabled = true) {
      const target = targetOrCreate(targetId);
      if (target.lifecycle === "destroyed") return;
      target.attached = true;
      target.networkEnabled = networkEnabled;
      target.lifecycle = "live";
      target.terminated = false;
      target.terminatedCovered = false;
      target.detachedPendingTermination = false;
      if (networkEnabled) {
        target.networkEnabledEver = true;
        target.monitoringGap = false;
      }
      target.coverageStatus = networkEnabled
        ? "live-covered"
        : "live-unmonitored";
    },
    recordDetached(targetId) {
      const target = targetOrCreate(targetId);
      if (target.lifecycle === "destroyed") return;
      target.attached = false;
      target.networkEnabled = false;
      target.lifecycle = "detached";
      target.detachedPendingTermination = true;
      target.coverageStatus = "live-unmonitored";
    },
    recordTargetDestroyed(targetId) {
      const target = targetOrCreate(targetId);
      if (target.lifecycle === "destroyed") return;
      target.attached = false;
      target.networkEnabled = false;
      target.lifecycle = "destroyed";
      target.terminated = true;
      target.detachedPendingTermination = false;
      target.terminatedCovered =
        target.networkEnabledEver && target.monitoringGapCount === 0;
      target.coverageStatus = target.terminatedCovered
        ? "terminated-covered"
        : "terminated-uncovered";
    },
    recordNetworkRequest({
      targetId,
      url,
      resourceType = "Other",
      isNavigation = false,
    }) {
      const target = targetOrCreate(targetId);
      target.httpRequests += 1;
      target.trafficObserved = true;
      const classification = classifyNetworkEvent({
        url,
        targetScope: target.scope,
        resourceType,
        isNavigation,
        fixtureUrls,
        extensionId: currentExtensionId,
        extensionOwned: target.extensionOwned,
      });
      if (!classification.allowed) target.unexpectedRequests += 1;
      events.push({ targetId, ...classification });
      if (classification.kind === "fixture-control") {
        addCount(controls, target.scope);
        addCount(httpControls, target.scope);
      }
      eventInputs.push({
        event: events.at(-1),
        url,
        resourceType,
        isNavigation,
        webSocket: false,
      });
      return classification;
    },
    recordWebSocket({ targetId, url }) {
      const target = targetOrCreate(targetId);
      target.webSockets += 1;
      target.trafficObserved = true;
      const classification = classifyNetworkEvent({
        url,
        targetScope: target.scope,
        resourceType: "WebSocket",
        fixtureUrls,
        extensionId: currentExtensionId,
      });
      if (!classification.allowed) target.unexpectedRequests += 1;
      events.push({ targetId, ...classification });
      if (classification.kind === "fixture-control") {
        addCount(controls, target.scope);
        addCount(webSocketControls, target.scope);
      }
      eventInputs.push({
        event: events.at(-1),
        url,
        resourceType: "WebSocket",
        isNavigation: false,
        webSocket: true,
      });
      return classification;
    },
    snapshot({ requireExtensionRuntime = false } = {}) {
      const monitoredScopes = new Set([
        "page",
        "offscreen",
        "background-service-worker",
        "extension-dedicatedworker",
        "dedicatedworker",
        "fixture-service-worker",
        "sharedworker",
      ]);
      const unmonitoredTargets = [...targets.values()]
        .filter(
          (target) =>
            monitoredScopes.has(target.scope) &&
            (target.lifecycle === "destroyed"
              ? !target.terminatedCovered
              : !target.attached || !target.networkEnabled),
        )
        .map((target) => target.targetId);
      const coveredScopes = [...httpControls.keys()];
      const missingPositiveControlScopes = [...expectedControlScopes].filter(
        (scope) => !httpControls.has(scope),
      );
      const coveredWebSocketScopes = [...webSocketControls.keys()];
      const missingPositiveControlWebSocketScopes = [
        ...expectedWebSocketScopes,
      ].filter((scope) => !webSocketControls.has(scope));
      const extensionTargets = [...targets.values()].filter(
        (target) => target.extensionOwned && monitoredScopes.has(target.scope),
      );
      const expectedExtensionScopes = [
        "page",
        "background-service-worker",
        "offscreen",
        "extension-dedicatedworker",
      ];
      const observedExtensionScopes = new Set(
        extensionTargets.map((target) => target.scope),
      );
      const missingExtensionScopes = requireExtensionRuntime
        ? expectedExtensionScopes.filter(
            (scope) => !observedExtensionScopes.has(scope),
          )
        : [];
      const extensionUnmonitored = extensionTargets
        .filter((target) =>
          target.lifecycle === "destroyed"
            ? !target.terminatedCovered
            : !target.attached || !target.networkEnabled,
        )
        .map((target) => target.targetId);
      const monitoringGapTargets = [...targets.values()]
        .filter((target) => target.monitoringGapCount > 0)
        .map((target) => target.targetId);
      for (const target of targets.values()) {
        target.coverageStatus =
          target.lifecycle === "destroyed"
            ? target.terminatedCovered
              ? "terminated-covered"
              : "terminated-uncovered"
            : target.attached && target.networkEnabled
              ? "live-covered"
              : "live-unmonitored";
      }
      const unsupportedTargets = [...targets.values()]
        .filter((target) => target.scope === "unknown")
        .map((target) => target.targetId);
      return {
        coverageComplete:
          unmonitoredTargets.length === 0 &&
          extensionUnmonitored.length === 0 &&
          unsupportedTargets.length === 0 &&
          missingPositiveControlScopes.length === 0 &&
          missingPositiveControlWebSocketScopes.length === 0 &&
          missingExtensionScopes.length === 0 &&
          monitoringGapTargets.length === 0,
        unmonitoredTargets,
        extensionUnmonitored,
        monitoringGapTargets,
        missingExtensionScopes,
        unsupportedTargets,
        targets: [...targets.values()].map((target) => ({ ...target })),
        positiveControl: {
          expectedScopes: [...expectedControlScopes],
          coveredScopes,
          missingScopes: missingPositiveControlScopes,
          expectedWebSocketScopes: [...expectedWebSocketScopes],
          coveredWebSocketScopes,
          missingWebSocketScopes: missingPositiveControlWebSocketScopes,
          eventCount: events.length,
        },
        events: events.map((event) => ({ ...event })),
      };
    },
  };
}

function numberValue(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parseKb(value) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(kb|mb|b)?\s*$/i.exec(value ?? "");
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1;
  return Number.isFinite(amount) ? Math.round(amount * multiplier) : null;
}

export function parseLinuxProcessStatus(text) {
  const fields = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0)
      fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  const parentPid = numberValue(fields.get("PPid"));
  const currentBytes = parseKb(fields.get("VmRSS"));
  const peakBytes = parseKb(fields.get("VmHWM"));
  return {
    parentPid: parentPid === null ? undefined : parentPid,
    currentBytes: currentBytes ?? 0,
    peakBytes: peakBytes ?? currentBytes ?? 0,
  };
}

export function parseWindowsProcessRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const pid = numberValue(row?.ProcessId);
      const parentPid = numberValue(row?.ParentProcessId);
      const currentBytes = numberValue(row?.WorkingSetSize);
      // Win32_Process.PeakWorkingSetSize is reported in KB; WorkingSetSize is bytes.
      // https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process
      const peakKilobytes = numberValue(row?.PeakWorkingSetSize);
      const peakBytes = peakKilobytes === null ? null : peakKilobytes * 1024;
      if (
        pid === null ||
        parentPid === null ||
        currentBytes === null ||
        peakBytes === null
      )
        return null;
      return { pid, parentPid, currentBytes, peakBytes };
    })
    .filter(Boolean);
}

export function sumProcessMemory(rows) {
  return (rows ?? []).reduce(
    (sum, row) => ({
      currentBytes: sum.currentBytes + (row.currentBytes ?? 0),
      peakBytes: sum.peakBytes + (row.peakBytes ?? 0),
    }),
    { currentBytes: 0, peakBytes: 0 },
  );
}

export function platformMemorySupport(platform) {
  if (platform === "win32")
    return { available: true, method: "cim-process-tree" };
  if (platform === "linux") return { available: true, method: "procfs" };
  return { available: false, reason: "unsupported-platform" };
}
