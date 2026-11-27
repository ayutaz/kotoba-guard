// @vitest-environment node
import { describe, expect, it } from "vitest";
import { validateAuditReport } from "./audit_report_acceptance.mjs";

function fixture() {
  const descriptor = { bytes: 10, sha256: "a".repeat(64) };
  const identityFiles = [
    "manifest.json",
    "core.js",
    "background.js",
    "content.js",
    "offscreen.js",
    "worker.js",
    "models/manifest.json",
  ];
  const distribution = {
    ...Object.fromEntries(identityFiles.map((file) => [file, descriptor])),
    "models/onnx/model_quantized.onnx": descriptor,
  };
  const binding = {
    source: { commit: "1".repeat(40), tree: "2".repeat(40), clean: true },
    distribution,
  };
  const http = ["page", "dedicatedworker", "fixture-service-worker"];
  const ws = ["page", "dedicatedworker"];
  const events = [
    ...http.map((targetScope) => ({
      kind: "fixture-control",
      targetScope,
      resourceType: "Fetch",
      allowed: true,
    })),
    ...ws.map((targetScope) => ({
      kind: "fixture-control",
      targetScope,
      resourceType: "WebSocket",
      allowed: true,
    })),
  ];
  const scopes = [
    "page",
    "background-service-worker",
    "offscreen",
    "extension-dedicatedworker",
  ];
  const coverage = () => ({
    coverageComplete: true,
    unmonitoredTargets: [],
    extensionUnmonitored: [],
    monitoringGapTargets: [],
    missingExtensionScopes: [],
    unsupportedTargets: [],
    fatalMonitorErrors: [],
    pendingMonitorTasks: 0,
    positiveControl: {
      expectedScopes: http,
      coveredScopes: http,
      missingScopes: [],
      expectedWebSocketScopes: ws,
      coveredWebSocketScopes: ws,
      missingWebSocketScopes: [],
      eventCount: events.length,
    },
    events,
    targets: scopes.map((scope, i) => ({
      targetId: `t${i}`,
      scope,
      extensionOwned: true,
      attached: true,
      networkEnabled: true,
      networkEnabledEver: true,
      lifecycle: "live",
      terminated: false,
      terminatedCovered: false,
      monitoringGap: false,
      monitoringGapCount: 0,
      coverageStatus: "live-covered",
      unexpectedRequests: 0,
    })),
  });
  const model = {
    modelId: "fixture/model",
    revision: "3".repeat(40),
    files: [{ path: "onnx/model_quantized.onnx", ...descriptor }],
    verification: {
      ok: true,
      missing: [],
      mismatches: [],
      malformed: [],
      declaredCount: 1,
    },
  };
  const process = {
    pid: 123,
    role: "renderer",
    currentBytes: 10,
    peakHwmBytes: 20,
  };
  const options = {
    binding,
    browserProduct: "Chrome/159.0.8154.6",
    platform: "win32",
    node: "v24.15.0",
    scriptSha256: "b".repeat(64),
    modelId: model.modelId,
    modelRevision: model.revision,
    modelFiles: model.files.map((file) => file.path),
    completedChecks: 6,
  };
  const report = {
    schemaVersion: 2,
    evidenceBinding: {
      before: binding,
      after: structuredClone(binding),
      verified: true,
    },
    execution: {
      status: "completed",
      gate: {
        passed: true,
        failures: [],
        securityFailures: [],
        resourceFailures: [],
      },
    },
    environment: {
      platform: options.platform,
      node: options.node,
      browserVersion: { product: options.browserProduct },
      auditScriptSha256: options.scriptSha256,
      sourceCommit: binding.source.commit,
      sourceTree: binding.source.tree,
      sourceClean: true,
    },
    assetIdentity: {
      distribution,
      extension: Object.fromEntries(
        identityFiles.map((file) => [file, descriptor]),
      ),
      model,
    },
    positiveControl: coverage(),
    extensionRuntime: coverage(),
    network: { unexpectedRequests: [], events },
    offline: {
      offlineBeforeAction: true,
      completedChecks: 6,
      previousMarksCleared: 6,
      backend: "wasm",
      enabledAfterPositiveControl: true,
      inferenceStatus:
        "offline-first-short-long-sequential-real-model-complete",
    },
    cleanup: {
      completed: true,
      operations: Object.fromEntries(
        [
          "popup",
          "browserCdp",
          "cdp",
          "context",
          "browser",
          "fixture",
          "profile",
        ].map((k) => [k, true]),
      ),
    },
    processMemory: {
      status: "measured",
      available: true,
      scope: "cdp-associated-browser-processes",
      samples: ["initial", "final"].map((label) => ({
        label,
        status: "measured",
        scope: "cdp-associated-browser-processes",
        missingPids: [],
        processCount: 1,
        currentBytes: 10,
        peakHwmBytes: 20,
        processes: [process],
      })),
      peakObservedHwmBytes: 20,
    },
    jsHeap: {
      status: "measured",
      samples: [
        { usedJSHeapSize: 10, totalJSHeapSize: 20, jsHeapSizeLimit: 30 },
      ],
    },
  };
  return { report, options };
}

describe("source-bound audit acceptance", () => {
  it("accepts the measured scope without granting memory or M5 acceptance", () => {
    const { report, options } = fixture();
    expect(validateAuditReport(report, options)).toEqual({
      communicationAcceptance: true,
      resourceMeasurementGatePassed: true,
      memoryGrowthAcceptance: false,
      fullM5Acceptance: false,
      runtimeSourceAuthority: "external-preflight",
    });
  });
  it("accepts page-first cleanup schema without the obsolete Browser.close operation", () => {
    const { report, options } = fixture();
    const operations = Object.fromEntries(
      Object.entries(report.cleanup.operations).filter(
        ([name]) => name !== "browserCdp",
      ),
    );
    Object.assign(report, {
      cleanup: {
        schemaVersion: 2,
        completed: true,
        operations: { ...operations, pages: true },
      },
    });
    expect(validateAuditReport(report, options).communicationAcceptance).toBe(
      true,
    );
  });
  it("rejects page cleanup failure in the new cleanup schema", () => {
    const { report, options } = fixture();
    const operations = Object.fromEntries(
      Object.entries(report.cleanup.operations).filter(
        ([name]) => name !== "browserCdp",
      ),
    );
    Object.assign(report, {
      cleanup: {
        schemaVersion: 2,
        completed: true,
        operations: { ...operations, pages: false },
      },
    });
    expect(() => validateAuditReport(report, options)).toThrow();
  });
  it.each([true, false])(
    "checks explicit monitor shutdown in schema3 (%s)",
    (stopped) => {
      const { report, options } = fixture();
      const operations = Object.fromEntries(
        Object.entries(report.cleanup.operations).filter(
          ([name]) => name !== "browserCdp",
        ),
      );
      Object.assign(report, {
        cleanup: {
          schemaVersion: 3,
          completed: true,
          operations: { ...operations, pages: true, monitor: stopped },
        },
      });
      if (stopped)
        expect(
          validateAuditReport(report, options).communicationAcceptance,
        ).toBe(true);
      else expect(() => validateAuditReport(report, options)).toThrow();
    },
  );
  it("rejects an omitted runtime identity file despite complete distribution bytes", () => {
    const { report, options } = fixture();
    delete report.assetIdentity.extension["offscreen.js"];
    expect(() => validateAuditReport(report, options)).toThrow();
  });
  it("rejects omission of an artifact required by the frozen model manifest", () => {
    const { report, options } = fixture();
    options.modelFiles.push("config.json");
    Object.assign(options.binding.distribution, {
      "models/config.json": { bytes: 1, sha256: "c".repeat(64) },
    });
    Object.assign(report.evidenceBinding.after.distribution, {
      "models/config.json": { bytes: 1, sha256: "c".repeat(64) },
    });
    expect(() => validateAuditReport(report, options)).toThrow();
  });
  const valid = fixture().report;
  const firstSample = valid.processMemory.samples[0];
  if (!firstSample) throw new Error("Fixture requires an initial OS sample");
  const invalid: [string, string, unknown][] = [
    ["source commit", "environment.sourceCommit", "4".repeat(40)],
    ["postflight bytes", "evidenceBinding.after.distribution.worker.js", {}],
    ["verified flag", "evidenceBinding.verified", false],
    ["browser", "environment.browserVersion.product", "Chrome/116.0.5845.96"],
    ["model revision", "assetIdentity.model.revision", "4".repeat(40)],
    [
      "extra model file",
      "assetIdentity.model.files",
      [
        ...valid.assetIdentity.model.files,
        { path: "undeclared.onnx", bytes: 1, sha256: "a".repeat(64) },
      ],
    ],
    [
      "model verification",
      "assetIdentity.model.verification.missing",
      ["file"],
    ],
    ["missing checks", "offline.completedChecks", undefined],
    ["boolean count", "offline.completedChecks", true],
    ["offline order", "offline.offlineBeforeAction", false],
    ["missing cleanup", "cleanup.operations.popup", undefined],
    ["cleanup failure", "cleanup.operations.context", false],
    ["unexpected request", "network.unexpectedRequests", [{}]],
    ["hidden disallowed event", "extensionRuntime.events.0.allowed", false],
    [
      "missing HTTP positive control",
      "positiveControl.events",
      valid.positiveControl.events.filter(
        (e) => e.targetScope !== "fixture-service-worker",
      ),
    ],
    [
      "missing websocket positive control",
      "positiveControl.events",
      valid.positiveControl.events.filter(
        (e) => e.resourceType !== "WebSocket",
      ),
    ],
    [
      "hidden missing scope",
      "extensionRuntime.targets",
      valid.extensionRuntime.targets.filter((t) => t.scope !== "offscreen"),
    ],
    [
      "hidden monitoring gap",
      "extensionRuntime.targets.0.monitoringGapCount",
      1,
    ],
    [
      "uncovered dead target",
      "extensionRuntime.targets.0.lifecycle",
      "destroyed",
    ],
    ["pending task", "extensionRuntime.pendingMonitorTasks", true],
    [
      "missing scope evidence",
      "extensionRuntime.unmonitoredTargets",
      undefined,
    ],
    ["memory scope", "processMemory.scope", "extension-only"],
    [
      "duplicate PID",
      "processMemory.samples.0.processes",
      [...firstSample.processes, ...firstSample.processes],
    ],
    ["missing PID", "processMemory.samples.0.missingPids", [42]],
    ["incorrect byte sum", "processMemory.samples.0.currentBytes", 11],
    ["unavailable heap", "jsHeap.samples", []],
  ];
  it.each(invalid)(
    "rejects %s despite claimed passing flags",
    (_, key, value) => {
      const { report, options } = fixture();
      const keys = key.split(".");
      if (key === "evidenceBinding.after.distribution.worker.js") {
        Object.assign(report.evidenceBinding.after.distribution, {
          "worker.js": { bytes: 11, sha256: "a".repeat(64) },
        });
      } else {
        const last = keys.pop()!;
        const parent = keys.reduce<unknown>(
          (node, part) => (node as Record<string, unknown>)[part],
          report,
        ) as Record<string, unknown>;
        parent[last] = structuredClone(value);
      }
      expect(() => validateAuditReport(report, options)).toThrow();
    },
  );
});
