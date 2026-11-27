import assert from "node:assert/strict";

const HTTP = ["page", "dedicatedworker", "fixture-service-worker"];
const WS = ["page", "dedicatedworker"];
const EXTENSION = [
  "page",
  "background-service-worker",
  "offscreen",
  "extension-dedicatedworker",
];
const EXCLUDED = new Set(["browser-ui", "tab-container", "other-target"]);
const IDENTITY_FILES = [
  "manifest.json",
  "core.js",
  "background.js",
  "content.js",
  "offscreen.js",
  "worker.js",
  "models/manifest.json",
];
const MONITORED = new Set([...HTTP, ...EXTENSION, "sharedworker"]);
const empty = (value) => assert.deepEqual(value, []);
const integer = (value) => assert.ok(Number.isSafeInteger(value) && value >= 0);
const array = (value) => {
  assert.ok(Array.isArray(value));
  return value;
};
const setEqual = (value, expected) =>
  assert.deepEqual([...array(value)].sort(), [...expected].sort());

function coverage(snapshot, requireExtension) {
  assert.equal(snapshot.coverageComplete, true);
  for (const key of [
    "unmonitoredTargets",
    "extensionUnmonitored",
    "monitoringGapTargets",
    "missingExtensionScopes",
    "unsupportedTargets",
    "fatalMonitorErrors",
  ])
    empty(snapshot[key]);
  assert.equal(snapshot.pendingMonitorTasks, 0);
  const controls = snapshot.positiveControl;
  setEqual(controls.expectedScopes, HTTP);
  setEqual(controls.expectedWebSocketScopes, WS);
  for (const scope of HTTP)
    assert.ok(array(controls.coveredScopes).includes(scope));
  for (const scope of WS)
    assert.ok(array(controls.coveredWebSocketScopes).includes(scope));
  empty(controls.missingScopes);
  empty(controls.missingWebSocketScopes);
  const events = array(snapshot.events);
  assert.equal(controls.eventCount, events.length);
  for (const event of events) assert.equal(event.allowed, true);
  for (const [scopes, resourceType] of [
    [HTTP, "Fetch"],
    [WS, "WebSocket"],
  ])
    for (const scope of scopes)
      assert.ok(
        events.some(
          (event) =>
            event.kind === "fixture-control" &&
            event.targetScope === scope &&
            event.resourceType === resourceType,
        ),
      );
  const targets = array(snapshot.targets);
  assert.ok(targets.length > 0);
  const seen = new Set();
  for (const target of targets) {
    assert.ok(
      typeof target.targetId === "string" &&
        target.targetId.length > 0 &&
        !seen.has(target.targetId),
    );
    seen.add(target.targetId);
    assert.equal(target.monitoringGap, false);
    assert.equal(target.monitoringGapCount, 0);
    assert.equal(target.unexpectedRequests, 0);
    if (!MONITORED.has(target.scope)) {
      assert.ok(EXCLUDED.has(target.scope));
      assert.equal(target.extensionOwned, false);
      continue;
    }
    assert.equal(target.networkEnabledEver, true);
    if (target.lifecycle === "destroyed") {
      assert.equal(target.terminated, true);
      assert.equal(target.terminatedCovered, true);
      assert.equal(target.coverageStatus, "terminated-covered");
    } else {
      assert.equal(target.lifecycle, "live");
      assert.equal(target.attached, true);
      assert.equal(target.networkEnabled, true);
      assert.equal(target.coverageStatus, "live-covered");
    }
  }
  if (requireExtension)
    for (const scope of EXTENSION)
      assert.ok(
        targets.some(
          (target) => target.scope === scope && target.extensionOwned === true,
        ),
      );
}

function resources(report) {
  const memory = report.processMemory;
  assert.equal(memory.status, "measured");
  assert.equal(memory.available, true);
  assert.equal(memory.scope, "cdp-associated-browser-processes");
  const samples = array(memory.samples);
  assert.ok(
    samples.some((s) => s.label === "initial") &&
      samples.some((s) => s.label === "final"),
  );
  for (const sample of samples) {
    assert.equal(sample.status, "measured");
    assert.equal(sample.scope, memory.scope);
    empty(sample.missingPids);
    const rows = array(sample.processes);
    assert.ok(rows.length > 0);
    assert.equal(sample.processCount, rows.length);
    const pids = new Set();
    let current = 0;
    let peak = 0;
    for (const row of rows) {
      integer(row.pid);
      assert.ok(row.pid > 0 && !pids.has(row.pid));
      pids.add(row.pid);
      assert.ok(typeof row.role === "string" && row.role.length > 0);
      integer(row.currentBytes);
      integer(row.peakHwmBytes);
      assert.ok(row.peakHwmBytes >= row.currentBytes);
      current += row.currentBytes;
      peak += row.peakHwmBytes;
      integer(current);
      integer(peak);
    }
    assert.equal(sample.currentBytes, current);
    assert.equal(sample.peakHwmBytes, peak);
  }
  assert.equal(
    memory.peakObservedHwmBytes,
    Math.max(...samples.map((s) => s.peakHwmBytes)),
  );
  assert.equal(report.jsHeap.status, "measured");
  const heaps = array(report.jsHeap.samples);
  assert.ok(heaps.length > 0);
  for (const heap of heaps) {
    integer(heap.usedJSHeapSize);
    integer(heap.totalJSHeapSize);
    integer(heap.jsHeapSizeLimit);
    assert.ok(
      heap.usedJSHeapSize <= heap.totalJSHeapSize &&
        heap.totalJSHeapSize <= heap.jsHeapSizeLimit,
    );
  }
}

/** Validate against caller-frozen inputs. Runtime provenance needs the outer preflight. */
export function validateAuditReport(report, expected) {
  assert.match(expected.binding.source.commit, /^[a-f0-9]{40}$/);
  assert.match(expected.binding.source.tree, /^[a-f0-9]{40}$/);
  assert.equal(expected.binding.source.clean, true);
  assert.match(expected.scriptSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.execution.status, "completed");
  assert.equal(report.execution.gate.passed, true);
  for (const key of ["failures", "securityFailures", "resourceFailures"])
    empty(report.execution.gate[key]);
  assert.equal(report.evidenceBinding.verified, true);
  assert.deepEqual(report.evidenceBinding.before, expected.binding);
  assert.deepEqual(report.evidenceBinding.after, expected.binding);
  const environment = report.environment;
  assert.equal(environment.sourceCommit, expected.binding.source.commit);
  assert.equal(environment.sourceTree, expected.binding.source.tree);
  assert.equal(environment.sourceClean, true);
  assert.equal(environment.browserVersion.product, expected.browserProduct);
  assert.equal(environment.platform, expected.platform);
  assert.equal(environment.node, expected.node);
  assert.equal(environment.auditScriptSha256, expected.scriptSha256);
  const assets = report.assetIdentity;
  assert.deepEqual(assets.distribution, expected.binding.distribution);
  setEqual(Object.keys(assets.extension), IDENTITY_FILES);
  for (const [file, value] of Object.entries(assets.extension))
    assert.deepEqual(value, expected.binding.distribution[file]);
  const model = assets.model;
  assert.equal(model.modelId, expected.modelId);
  assert.equal(model.revision, expected.modelRevision);
  const files = array(model.files);
  assert.ok(files.length > 0);
  const names = new Set();
  for (const { path, ...descriptor } of files) {
    assert.ok(!names.has(path));
    names.add(path);
    assert.deepEqual(
      descriptor,
      expected.binding.distribution[`models/${path}`],
    );
  }
  setEqual([...names], expected.modelFiles);
  assert.ok(names.has("onnx/model_quantized.onnx"));
  assert.equal(model.verification.ok, true);
  assert.equal(model.verification.declaredCount, files.length);
  for (const key of ["missing", "mismatches", "malformed"])
    empty(model.verification[key]);
  const offline = report.offline;
  assert.equal(offline.offlineBeforeAction, true);
  assert.equal(offline.enabledAfterPositiveControl, true);
  assert.equal(offline.backend, "wasm");
  assert.equal(offline.completedChecks, expected.completedChecks);
  assert.equal(offline.previousMarksCleared, expected.completedChecks);
  assert.equal(
    offline.inferenceStatus,
    "offline-first-short-long-sequential-real-model-complete",
  );
  coverage(report.positiveControl, false);
  coverage(report.extensionRuntime, true);
  empty(report.network.unexpectedRequests);
  assert.deepEqual(report.network.events, report.extensionRuntime.events);
  assert.equal(report.cleanup.completed, true);
  const operations = report.cleanup.operations;
  setEqual(Object.keys(operations), [
    "popup",
    ...(report.cleanup.schemaVersion === 3
      ? ["monitor", "pages"]
      : report.cleanup.schemaVersion === 2
        ? ["pages"]
        : ["browserCdp"]),
    "cdp",
    "context",
    "browser",
    "fixture",
    "profile",
  ]);
  for (const value of Object.values(operations)) assert.equal(value, true);
  resources(report);
  return {
    communicationAcceptance: true,
    resourceMeasurementGatePassed: true,
    memoryGrowthAcceptance: false,
    fullM5Acceptance: false,
    runtimeSourceAuthority: "external-preflight",
  };
}
