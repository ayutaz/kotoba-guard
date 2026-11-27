import { describe, expect, it, vi } from "vitest";

import { boundedResult, createCdpMonitor } from "./browser_security_audit.mjs";

import {
  classifyNetworkEvent,
  classifyTargetScope,
  createSerialSampler,
  createAuditLedger,
  isDirectEntrypoint,
  parseLinuxProcessStatus,
  parseWindowsProcessRows,
  platformMemorySupport,
  selectProcessTreeRows,
  sanitizeUrl,
  sumProcessMemory,
  webSocketAccept,
  verifyArtifactManifest,
} from "./browser_security_audit_helpers.mjs";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const fixtureOrigin = "http://127.0.0.1:43127";
const fixtureUrls = {
  root: `${fixtureOrigin}/?token=control-token`,
  script: `${fixtureOrigin}/__kg_audit_sw__.js?token=control-token`,
  control: `${fixtureOrigin}/__kg_audit_control__?token=control-token`,
  websocket: `ws://127.0.0.1:43127/__kg_audit_ws__?token=control-token`,
};

it("stops discovery and auto-attach before retiring monitor sessions", async () => {
  const session = fakeCdpSession({
    existingTargetInfos: [
      {
        targetId: "worker-one",
        type: "worker",
        url: `chrome-extension://${extensionId}/worker.js`,
      },
    ],
  });
  const ledger = createAuditLedger({ extensionId, fixtureUrls });
  const monitor = createCdpMonitor(session, ledger, extensionId);
  await monitor.start();
  await monitor.snapshot();
  await monitor.stop();
  expect(session.calls).toContainEqual({
    method: "Target.setDiscoverTargets",
    params: { discover: false },
  });
  expect(
    session.calls.some(
      (call) =>
        call.method === "Target.setAutoAttach" &&
        call.params.autoAttach === false,
    ),
  ).toBe(true);
  expect(
    session.calls.some((call) => call.method === "Target.detachFromTarget"),
  ).toBe(true);
});

function fakeCdpSession(
  options: {
    failNestedAutoAttach?: boolean;
    failSessionNotFound?: boolean;
    autoAttachRequiresResume?: boolean;
    enableRequiresResume?: boolean;
    failNetworkEnable?: boolean;
    failNetworkSessionIds?: string[];
    failRuntimeEnable?: boolean;
    existingTargetInfos?: Array<{
      targetId: string;
      type: string;
      url: string;
    }>;
    manualAttachEvent?: {
      sessionId: string;
      targetInfo: { targetId: string; type: string; url: string };
      waitingForDebugger?: boolean;
    };
    manualAttachReturnSessionId?: string;
    resumeDelayMs?: number;
    secondaryResumeReleasesPrimary?: {
      primarySessionId: string;
      secondarySessionId: string;
    };
  } = {},
) {
  const listeners: Array<(event: unknown) => void> = [];
  const resumedSessions = new Set<string>();
  const waitingEnableAcks = new Map<string, Array<() => void>>();
  const waitingAutoAttachAcks = new Map<string, Array<() => void>>();
  const waitingBarrierAcks = new Map<string, Array<() => void>>();
  const calls: Array<{
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }> = [];
  return {
    calls,
    onEvent(listener: (event: unknown) => void) {
      listeners.push(listener);
    },
    emit(event: unknown) {
      for (const listener of listeners) listener(event);
    },
    async send(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) {
      const call = { method, params } as {
        method: string;
        params: Record<string, unknown>;
        sessionId?: string;
      };
      if (sessionId !== undefined) call.sessionId = sessionId;
      calls.push(call);
      if (method === "Target.getTargets")
        return { targetInfos: options.existingTargetInfos ?? [] };
      if (method === "Target.attachToTarget") {
        if (options.manualAttachEvent)
          for (const listener of listeners)
            listener({
              method: "Target.attachedToTarget",
              params: {
                sessionId: options.manualAttachEvent.sessionId,
                targetInfo: options.manualAttachEvent.targetInfo,
                ...(options.manualAttachEvent.waitingForDebugger === undefined
                  ? {}
                  : {
                      waitingForDebugger:
                        options.manualAttachEvent.waitingForDebugger,
                    }),
              },
            });
        return {
          sessionId:
            options.manualAttachReturnSessionId ??
            options.manualAttachEvent?.sessionId ??
            "manual-session",
        };
      }
      if (
        options.failSessionNotFound &&
        sessionId !== undefined &&
        method === "Target.setAutoAttach"
      )
        throw new Error("Session with given id not found.");
      if (
        options.failNestedAutoAttach &&
        method === "Target.setAutoAttach" &&
        sessionId !== undefined
      )
        throw new Error("nested auto-attach unsupported");
      if (
        options.autoAttachRequiresResume &&
        sessionId !== undefined &&
        method === "Target.setAutoAttach" &&
        !resumedSessions.has(sessionId)
      )
        return new Promise((resolve) => {
          const pending = waitingAutoAttachAcks.get(sessionId) ?? [];
          pending.push(() => resolve({}));
          waitingAutoAttachAcks.set(sessionId, pending);
        });
      if (
        options.enableRequiresResume &&
        sessionId !== undefined &&
        (method === "Network.enable" || method === "Runtime.enable") &&
        !resumedSessions.has(sessionId)
      )
        return new Promise((resolve) => {
          const pending = waitingEnableAcks.get(sessionId) ?? [];
          pending.push(() => resolve({}));
          waitingEnableAcks.set(sessionId, pending);
        });
      if (
        method === "Runtime.runIfWaitingForDebugger" &&
        sessionId !== undefined
      ) {
        const barrier = options.secondaryResumeReleasesPrimary;
        if (
          barrier?.primarySessionId === sessionId &&
          !resumedSessions.has(barrier.secondarySessionId)
        ) {
          return new Promise((resolve) => {
            const pending = waitingBarrierAcks.get(sessionId) ?? [];
            pending.push(() => resolve({}));
            waitingBarrierAcks.set(sessionId, pending);
          });
        }
        resumedSessions.add(sessionId);
        for (const resolve of waitingEnableAcks.get(sessionId) ?? []) resolve();
        waitingEnableAcks.delete(sessionId);
        for (const resolve of waitingAutoAttachAcks.get(sessionId) ?? [])
          resolve();
        waitingAutoAttachAcks.delete(sessionId);
        if (barrier?.secondarySessionId === sessionId) {
          resumedSessions.add(barrier.primarySessionId);
          for (const resolve of waitingEnableAcks.get(
            barrier.primarySessionId,
          ) ?? [])
            resolve();
          waitingEnableAcks.delete(barrier.primarySessionId);
          for (const resolve of waitingAutoAttachAcks.get(
            barrier.primarySessionId,
          ) ?? [])
            resolve();
          waitingAutoAttachAcks.delete(barrier.primarySessionId);
          for (const resolve of waitingBarrierAcks.get(
            barrier.primarySessionId,
          ) ?? [])
            resolve();
          waitingBarrierAcks.delete(barrier.primarySessionId);
        }
      }
      if (
        sessionId !== undefined &&
        ((method === "Network.enable" && options.failNetworkEnable) ||
          (method === "Network.enable" &&
            options.failNetworkSessionIds?.includes(sessionId)) ||
          (method === "Runtime.enable" && options.failRuntimeEnable))
      )
        throw new Error(`${method} rejected`);
      if (method === "Runtime.runIfWaitingForDebugger" && options.resumeDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, options.resumeDelayMs),
        );
      return {};
    },
  };
}

describe("browser audit target scopes", () => {
  it("enables and resumes an auto-attached nested worker", async () => {
    const session = fakeCdpSession();
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    session.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "nested-session",
        targetInfo: {
          targetId: "nested-worker",
          type: "worker",
          url: `chrome-extension://${extensionId}/worker.js`,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const childMethods = session.calls
      .filter((call) => call.sessionId === "nested-session")
      .map((call) => call.method);
    expect(childMethods).toEqual([
      "Target.setAutoAttach",
      "Network.enable",
      "Runtime.enable",
      "Runtime.runIfWaitingForDebugger",
    ]);
    expect(ledger.snapshot().extensionUnmonitored).toEqual([]);
  });

  it("resumes before awaiting enable acknowledgements from a paused target", async () => {
    const session = fakeCdpSession({ enableRequiresResume: true });
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    session.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "ack-after-resume-session",
        targetInfo: {
          targetId: "ack-after-resume-worker",
          type: "worker",
          url: `${fixtureOrigin}/worker.js`,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const childCalls = session.calls.filter(
      (call) => call.sessionId === "ack-after-resume-session",
    );
    expect(childCalls.map((call) => call.method)).toEqual([
      "Target.setAutoAttach",
      "Network.enable",
      "Runtime.enable",
      "Runtime.runIfWaitingForDebugger",
    ]);
    expect(ledger.snapshot().targets[0]?.networkEnabled).toBe(true);
  });

  it("resumes a paused child before awaiting its auto-attach acknowledgement", async () => {
    const session = fakeCdpSession({ autoAttachRequiresResume: true });
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    session.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "auto-attach-ack-session",
        targetInfo: {
          targetId: "auto-attach-ack-worker",
          type: "worker",
          url: `${fixtureOrigin}/worker.js`,
        },
      },
    });
    await expect
      .poll(
        () =>
          session.calls.some(
            (call) =>
              call.method === "Runtime.runIfWaitingForDebugger" &&
              call.sessionId === "auto-attach-ack-session",
          ),
        { timeout: 250, interval: 10 },
      )
      .toBe(true);
    await expect
      .poll(() => ledger.snapshot().targets[0]?.networkEnabled, {
        timeout: 250,
        interval: 10,
      })
      .toBe(true);
  });

  it("does not resume a duplicate attached event owned by an in-flight initializer", async () => {
    const session = fakeCdpSession({ enableRequiresResume: true });
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    const targetInfo = {
      targetId: "duplicate-session-target",
      type: "worker",
      url: `${fixtureOrigin}/worker.js`,
    };
    const event = {
      method: "Target.attachedToTarget",
      params: { sessionId: "duplicate-session", targetInfo },
    };
    session.emit(event);
    session.emit(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      session.calls.filter(
        (call) =>
          call.method === "Runtime.runIfWaitingForDebugger" &&
          call.sessionId === "duplicate-session",
      ),
    ).toHaveLength(1);
    expect(ledger.snapshot().targets[0]?.networkEnabled).toBe(true);
  });

  it("retires a duplicate session after the primary owns network monitoring", async () => {
    const session = fakeCdpSession();
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    const targetInfo = {
      targetId: "primary-owned-target",
      type: "service_worker",
      url: `chrome-extension://${extensionId}/background.js`,
    };
    session.emit({
      method: "Target.attachedToTarget",
      params: { sessionId: "primary-owner-session", targetInfo },
    });
    session.emit({
      method: "Target.attachedToTarget",
      params: { sessionId: "secondary-session", targetInfo },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondaryMethods = session.calls
      .filter((call) => call.sessionId === "secondary-session")
      .map((call) => call.method);
    expect(secondaryMethods).not.toEqual(
      expect.arrayContaining([
        "Target.setAutoAttach",
        "Network.enable",
        "Runtime.enable",
      ]),
    );
    expect(
      session.calls.some(
        (call) =>
          call.method === "Target.detachFromTarget" &&
          call.params.sessionId === "secondary-session",
      ),
    ).toBe(true);
    expect(monitor.sessionDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "duplicate-session-retired",
          primarySessionId: "primary-owner-session",
          secondarySessionId: "secondary-session",
          coveredByPrimary: true,
        }),
      ]),
    );
  });

  it("keeps an unhealthy primary target fail-closed while a duplicate is available", async () => {
    const session = fakeCdpSession({ failNetworkEnable: true });
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    const targetInfo = {
      targetId: "unhealthy-primary-target",
      type: "service_worker",
      url: `chrome-extension://${extensionId}/background.js`,
    };
    session.emit({
      method: "Target.attachedToTarget",
      params: { sessionId: "unhealthy-primary-session", targetInfo },
    });
    session.emit({
      method: "Target.attachedToTarget",
      params: { sessionId: "available-secondary-session", targetInfo },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ledger.snapshot().extensionUnmonitored).toContain(
      "unhealthy-primary-target",
    );
    expect(monitor.attached.get("unhealthy-primary-target")?.sessionId).toBe(
      "available-secondary-session",
    );
    expect(monitor.sessionDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "secondary-promoted",
          coveredByPrimary: false,
        }),
      ]),
    );
  });

  it("does not let a detached primary overwrite the promoted secondary ledger state", async () => {
    const session = fakeCdpSession({
      resumeDelayMs: 20,
      failNetworkSessionIds: ["promoted-secondary-session"],
    });
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    const targetInfo = {
      targetId: "promotion-ledger-target",
      type: "service_worker",
      url: `chrome-extension://${extensionId}/background.js`,
    };
    session.emit({
      method: "Target.attachedToTarget",
      params: { sessionId: "detached-primary-session", targetInfo },
    });
    session.emit({
      method: "Target.attachedToTarget",
      params: { sessionId: "promoted-secondary-session", targetInfo },
    });
    session.emit({
      method: "Target.detachedFromTarget",
      params: { sessionId: "detached-primary-session" },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(monitor.attached.get(targetInfo.targetId)?.sessionId).toBe(
      "promoted-secondary-session",
    );
    expect(ledger.snapshot().extensionUnmonitored).toContain(
      targetInfo.targetId,
    );
  });

  it("marks a target unmonitored when its owner detaches without a replacement", async () => {
    const session = fakeCdpSession();
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    const targetInfo = {
      targetId: "detached-owner-target",
      type: "service_worker",
      url: `chrome-extension://${extensionId}/background.js`,
    };
    session.emit({
      method: "Target.attachedToTarget",
      params: { sessionId: "detached-owner-session", targetInfo },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ledger.snapshot().targets[0]?.networkEnabled).toBe(true);
    session.emit({
      method: "Target.detachedFromTarget",
      params: { sessionId: "detached-owner-session" },
    });
    expect(ledger.snapshot().extensionUnmonitored).toContain(
      targetInfo.targetId,
    );
  });

  it("waits for in-flight instrumentation before returning a snapshot", async () => {
    const session = fakeCdpSession({ resumeDelayMs: 20 });
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    session.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "snapshot-pending-session",
        targetInfo: {
          targetId: "snapshot-pending-target",
          type: "worker",
          url: `chrome-extension://${extensionId}/worker.js`,
        },
      },
    });
    const snapshot = await monitor.snapshot({ refresh: false });
    expect(
      snapshot.targets.find(
        (target: { targetId: string }) =>
          target.targetId === "snapshot-pending-target",
      ),
    ).toMatchObject({ networkEnabled: true });
  });

  it("handles immediate enable rejection while resume acknowledgement is delayed", async () => {
    const session = fakeCdpSession({
      failNetworkEnable: true,
      failRuntimeEnable: true,
      resumeDelayMs: 10,
    });
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    session.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "rejected-enable-session",
        targetInfo: {
          targetId: "rejected-enable-worker",
          type: "worker",
          url: `${fixtureOrigin}/worker.js`,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(monitor.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CDP Network.enable failed"),
        expect.stringContaining("CDP Runtime.enable failed"),
      ]),
    );
    expect(ledger.snapshot().targets[0]?.networkEnabled).toBe(false);
    expect(monitor.fatalErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CDP Network.enable failed"),
      ]),
    );
  });

  it("resumes the manual attach session when auto-attach races target creation", async () => {
    const session = fakeCdpSession();
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    const targetInfo = {
      targetId: "racing-worker",
      type: "worker",
      url: `chrome-extension://${extensionId}/worker.js`,
    };
    session.emit({ method: "Target.targetCreated", params: { targetInfo } });
    session.emit({
      method: "Target.attachedToTarget",
      params: { sessionId: "manual-session", targetInfo },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const childCalls = session.calls.filter(
      (call) => call.sessionId === "manual-session",
    );
    const childMethods = childCalls.map((call) => call.method);
    expect(childMethods).toEqual(
      expect.arrayContaining([
        "Target.setAutoAttach",
        "Network.enable",
        "Runtime.enable",
        "Runtime.runIfWaitingForDebugger",
      ]),
    );
    expect(
      childMethods.filter((method) => method === "Network.enable"),
    ).toHaveLength(1);
    expect(
      session.calls.filter((call) => call.method === "Target.attachToTarget"),
    ).toHaveLength(0);
    session.emit({
      method: "Network.requestWillBeSent",
      sessionId: "manual-session",
      params: {
        type: "Fetch",
        request: { url: fixtureUrls.control },
      },
    });
    expect(ledger.snapshot().targets[0]?.httpRequests).toBe(1);
    expect(monitor.attached.get("racing-worker")?.sessionId).toBe(
      "manual-session",
    );
  });

  it("keeps an auto-attached owner when manual attach races and its session cannot enable Network", async () => {
    const targetInfo = {
      targetId: "racing-existing-other",
      type: "other",
      url: `chrome-extension://${extensionId}/popup.html`,
    };
    const session = fakeCdpSession({
      existingTargetInfos: [targetInfo],
      manualAttachEvent: {
        sessionId: "auto-owner-session",
        targetInfo,
      },
      manualAttachReturnSessionId: "manual-owner-session",
      failNetworkSessionIds: ["manual-owner-session"],
    });
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    const snapshot = await monitor.snapshot({ refresh: false });
    expect(monitor.attached.get(targetInfo.targetId)?.sessionId).toBe(
      "auto-owner-session",
    );
    expect(
      snapshot.targets.find(
        (target: { targetId: string }) =>
          target.targetId === targetInfo.targetId,
      ),
    ).toMatchObject({ networkEnabled: true });
    expect(snapshot.extensionUnmonitored).not.toContain(targetInfo.targetId);
  });

  it("treats a tab target as a container without requiring Network.enable", async () => {
    const session = fakeCdpSession();
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    session.emit({
      method: "Target.targetCreated",
      params: {
        targetInfo: {
          targetId: "tab-container",
          type: "tab",
          url: fixtureUrls.root,
        },
      },
    });
    session.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "tab-session",
        targetInfo: {
          targetId: "tab-container",
          type: "tab",
          url: fixtureUrls.root,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(monitor.attached.has("tab-container")).toBe(false);
    expect(
      session.calls.some(
        (call) =>
          call.method === "Network.enable" &&
          call.sessionId === "manual-session",
      ),
    ).toBe(false);
    expect(
      session.calls.some(
        (call) =>
          call.method === "Runtime.runIfWaitingForDebugger" &&
          call.sessionId === "tab-session",
      ),
    ).toBe(true);
  });

  it("promotes a remaining session when detachedFromTarget provides only sessionId", async () => {
    vi.useFakeTimers();
    try {
      const session = fakeCdpSession({ resumeDelayMs: 20 });
      const ledger = createAuditLedger({ extensionId, fixtureUrls });
      const monitor = createCdpMonitor(session, ledger, extensionId);
      await monitor.start();
      const targetInfo = {
        targetId: "shared-target",
        type: "worker",
        url: `chrome-extension://${extensionId}/worker.js`,
      };
      session.emit({
        method: "Target.attachedToTarget",
        params: { sessionId: "primary-session", targetInfo },
      });
      await vi.advanceTimersByTimeAsync(0);
      session.emit({
        method: "Target.attachedToTarget",
        params: { sessionId: "secondary-session", targetInfo },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.attached.get("shared-target")?.sessionId).toBe(
        "primary-session",
      );
      session.emit({
        method: "Target.detachedFromTarget",
        params: { sessionId: "primary-session" },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.attached.get("shared-target")?.sessionId).toBe(
        "secondary-session",
      );
      session.emit({
        method: "Network.requestWillBeSent",
        sessionId: "secondary-session",
        params: { type: "Fetch", request: { url: fixtureUrls.control } },
      });
      expect(ledger.snapshot().events).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(
        (await monitor.snapshot({ refresh: false })).pendingMonitorTasks,
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records targetDestroyed so a monitored target closed after detach is covered", async () => {
    const session = fakeCdpSession();
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    const targetInfo = {
      targetId: "closed-monitored-page",
      type: "page",
      url: fixtureUrls.root,
    };
    session.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "closed-page-session",
        targetInfo,
        waitingForDebugger: true,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.emit({
      method: "Target.detachedFromTarget",
      params: { sessionId: "closed-page-session" },
    });
    expect(ledger.snapshot().unmonitoredTargets).toContain(
      "closed-monitored-page",
    );
    session.emit({
      method: "Target.targetDestroyed",
      params: { targetId: "closed-monitored-page" },
    });
    const snapshot = await monitor.snapshot({ refresh: false });
    expect(snapshot.unmonitoredTargets).not.toContain("closed-monitored-page");
    expect(snapshot.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: "closed-monitored-page",
          lifecycle: "destroyed",
          terminatedCovered: true,
        }),
      ]),
    );
    expect(monitor.sessionDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "target-detached",
          targetId: "closed-monitored-page",
          sessionOrigin: "auto",
          waitingForDebugger: true,
        }),
        expect.objectContaining({
          kind: "target-destroyed",
          targetId: "closed-monitored-page",
        }),
      ]),
    );
  });

  it("resumes a paused auto secondary before waiting for the primary barrier", async () => {
    const session = fakeCdpSession({
      autoAttachRequiresResume: true,
      enableRequiresResume: true,
      secondaryResumeReleasesPrimary: {
        primarySessionId: "barrier-primary",
        secondarySessionId: "barrier-secondary",
      },
    });
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    const targetInfo = {
      targetId: "barrier-target",
      type: "service_worker",
      url: `${fixtureOrigin}/sw.js`,
    };
    session.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "barrier-primary",
        targetInfo,
        waitingForDebugger: true,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "barrier-secondary",
        targetInfo,
        waitingForDebugger: true,
      },
    });
    const snapshot = await monitor.snapshot({ refresh: false });
    expect(monitor.fatalErrors).toEqual([]);
    expect(snapshot.pendingMonitorTasks).toBe(0);
    expect(snapshot.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: "barrier-target",
          attached: true,
          networkEnabled: true,
        }),
      ]),
    );
    const primaryNetworkIndex = session.calls.findIndex(
      (call) =>
        call.method === "Network.enable" &&
        call.sessionId === "barrier-primary",
    );
    const secondaryResumeIndex = session.calls.findIndex(
      (call) =>
        call.method === "Runtime.runIfWaitingForDebugger" &&
        call.sessionId === "barrier-secondary",
    );
    expect(primaryNetworkIndex).toBeGreaterThanOrEqual(0);
    expect(secondaryResumeIndex).toBeGreaterThan(primaryNetworkIndex);
  });

  it("keeps a destroyed target uncovered when a live gap is observed after detach", async () => {
    const session = fakeCdpSession();
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    const targetInfo = {
      targetId: "gap-monitored-page",
      type: "page",
      url: fixtureUrls.root,
    };
    session.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "gap-page-session",
        targetInfo,
        waitingForDebugger: true,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.emit({
      method: "Target.detachedFromTarget",
      params: { sessionId: "gap-page-session" },
    });
    session.emit({
      method: "Target.targetInfoChanged",
      params: { targetInfo },
    });
    session.emit({
      method: "Target.targetDestroyed",
      params: { targetId: "gap-monitored-page" },
    });
    const snapshot = await monitor.snapshot({ refresh: false });
    expect(snapshot.unmonitoredTargets).toContain("gap-monitored-page");
    expect(snapshot.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: "gap-monitored-page",
          monitoringGap: true,
          terminatedCovered: false,
        }),
      ]),
    );
  });

  it("retains manual attach origin and explicit non-paused state in lifecycle diagnostics", async () => {
    const targetInfo = {
      targetId: "manual-page",
      type: "page",
      url: fixtureUrls.root,
    };
    const session = fakeCdpSession({
      existingTargetInfos: [targetInfo],
      manualAttachEvent: {
        sessionId: "manual-event-session",
        targetInfo,
        waitingForDebugger: false,
      },
      manualAttachReturnSessionId: "manual-event-session",
    });
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    session.emit({
      method: "Target.detachedFromTarget",
      params: { sessionId: "manual-event-session" },
    });
    expect(monitor.sessionDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "target-detached",
          targetId: "manual-page",
          sessionOrigin: "manual",
          waitingForDebugger: false,
        }),
      ]),
    );
  });

  it("marks recursive auto-attach failure as fatal and still resumes the paused target", async () => {
    const session = fakeCdpSession({ failNestedAutoAttach: true });
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    session.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "unsupported-child-session",
        targetInfo: {
          targetId: "unsupported-child",
          type: "worker",
          url: `chrome-extension://${extensionId}/worker.js`,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snapshot = await monitor.snapshot();
    expect(monitor.fatalErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CDP child auto-attach failed"),
      ]),
    );
    expect(snapshot.coverageComplete).toBe(false);
    expect(
      session.calls.some(
        (call) =>
          call.method === "Runtime.runIfWaitingForDebugger" &&
          call.sessionId === "unsupported-child-session",
      ),
    ).toBe(true);
  });

  it("marks container auto-attach failure as fatal while resuming its session", async () => {
    const session = fakeCdpSession({ failNestedAutoAttach: true });
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    session.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "tab-container-session",
        targetInfo: {
          targetId: "tab-container-fatal",
          type: "tab",
          url: fixtureUrls.root,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(monitor.fatalErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CDP container auto-attach failed"),
      ]),
    );
    expect(
      session.calls.some(
        (call) =>
          call.method === "Runtime.runIfWaitingForDebugger" &&
          call.sessionId === "tab-container-session",
      ),
    ).toBe(true);
  });

  it("retains fatal session loss and reports a detached container as redundant", async () => {
    const session = fakeCdpSession({ failSessionNotFound: true });
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    const targetInfo = {
      targetId: "ephemeral-container",
      type: "tab",
      url: fixtureUrls.root,
    };
    session.emit({
      method: "Target.attachedToTarget",
      params: { sessionId: "ephemeral-container-session", targetInfo },
    });
    session.emit({
      method: "Target.detachedFromTarget",
      params: { sessionId: "ephemeral-container-session" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(monitor.fatalErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CDP container auto-attach failed"),
      ]),
    );
    expect(monitor.sessionDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "ephemeral-session-not-found",
          stage: "container-auto-attach",
          targetType: "tab",
          knownDetached: true,
          redundantSession: false,
        }),
      ]),
    );
  });

  it("instruments an extension other target when its URL identifies offscreen", async () => {
    const session = fakeCdpSession();
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    session.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "other-offscreen-session",
        targetInfo: {
          targetId: "other-offscreen-target",
          type: "other",
          url: `chrome-extension://${extensionId}/offscreen.html`,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      session.calls.some(
        (call) =>
          call.method === "Network.enable" &&
          call.sessionId === "other-offscreen-session",
      ),
    ).toBe(true);
    expect(ledger.snapshot().targets[0]).toMatchObject({
      scope: "offscreen",
      extensionOwned: true,
      attached: true,
      networkEnabled: true,
    });
  });

  it("instruments an initially unknown other target before a later URL transition", async () => {
    const session = fakeCdpSession();
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    session.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "transition-session",
        targetInfo: {
          targetId: "transition-target",
          type: "other",
          url: "",
        },
      },
    });
    session.emit({
      method: "Target.targetInfoChanged",
      params: {
        targetInfo: {
          targetId: "transition-target",
          type: "page",
          url: `chrome-extension://${extensionId}/offscreen.html`,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      session.calls.some(
        (call) =>
          call.method === "Network.enable" &&
          call.sessionId === "transition-session",
      ),
    ).toBe(true);
    expect(ledger.snapshot().targets[0]).toMatchObject({
      type: "page",
      scope: "offscreen",
      networkEnabled: true,
    });
  });

  it("reports a target-created extension other target until attachment starts", async () => {
    const session = fakeCdpSession();
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const monitor = createCdpMonitor(session, ledger, extensionId);
    await monitor.start();
    session.emit({
      method: "Target.targetCreated",
      params: {
        targetInfo: {
          targetId: "created-only-other",
          type: "other",
          url: `chrome-extension://${extensionId}/offscreen.html`,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      session.calls.some(
        (call) =>
          call.method === "Network.enable" &&
          call.sessionId === "created-only-other",
      ),
    ).toBe(false);
    expect(ledger.snapshot().extensionUnmonitored).toContain(
      "created-only-other",
    );
  });

  it("recognizes a Windows direct invocation through file URL conversion", () => {
    expect(
      isDirectEntrypoint(
        "file:///C:/Users/fixture/kotoba-guard/scripts/browser_security_audit.mjs",
        "C:\\Users\\fixture\\kotoba-guard\\scripts\\browser_security_audit.mjs",
      ),
    ).toBe(true);
    expect(isDirectEntrypoint("file:///tmp/other.mjs", "/tmp/audit.mjs")).toBe(
      false,
    );
  });

  it("classifies extension page, offscreen, service worker and workers", () => {
    expect(
      classifyTargetScope(
        { type: "page", url: `chrome-extension://${extensionId}/popup.html` },
        extensionId,
      ),
    ).toBe("page");
    expect(
      classifyTargetScope(
        {
          type: "page",
          url: `chrome-extension://${extensionId}/offscreen.html`,
        },
        extensionId,
      ),
    ).toBe("offscreen");
    expect(
      classifyTargetScope(
        {
          type: "service_worker",
          url: `chrome-extension://${extensionId}/background.js`,
        },
        extensionId,
      ),
    ).toBe("background-service-worker");
    expect(
      classifyTargetScope(
        { type: "worker", url: `chrome-extension://${extensionId}/worker.js` },
        extensionId,
      ),
    ).toBe("extension-dedicatedworker");
    expect(
      classifyTargetScope(
        {
          type: "other",
          url: `chrome-extension://${extensionId}/offscreen.html`,
        },
        extensionId,
      ),
    ).toBe("offscreen");
    expect(
      classifyTargetScope(
        {
          type: "other",
          url: `chrome-extension://${extensionId}/popup.html`,
        },
        extensionId,
      ),
    ).toBe("page");
    expect(
      classifyTargetScope(
        {
          type: "background_page",
          url: `chrome-extension://${extensionId}/offscreen.html`,
        },
        extensionId,
      ),
    ).toBe("offscreen");
    expect(
      classifyTargetScope(
        {
          type: "other",
          url: `chrome-extension://${extensionId}/unknown.html`,
        },
        extensionId,
      ),
    ).toBe("unknown");
    expect(
      classifyTargetScope(
        { type: "service_worker", url: `${fixtureOrigin}/sw.js` },
        extensionId,
      ),
    ).toBe("fixture-service-worker");
    expect(
      classifyTargetScope(
        { type: "worker", url: `${fixtureOrigin}/worker.js` },
        extensionId,
      ),
    ).toBe("dedicatedworker");
    expect(
      classifyTargetScope({ type: "tab", url: fixtureUrls.root }, extensionId),
    ).toBe("tab-container");
  });

  it("retains partial target metadata and updates report type after target transitions", () => {
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    ledger.recordTargetCreated({
      targetId: "transitioning-target",
      type: "other",
      url: `chrome-extension://${extensionId}/offscreen.html`,
    });
    ledger.recordTargetCreated({
      targetId: "transitioning-target",
      type: "page",
    });
    const target = ledger
      .snapshot()
      .targets.find(
        (candidate) => candidate.targetId === "transitioning-target",
      );
    expect(target).toMatchObject({
      type: "page",
      scope: "offscreen",
      extensionOwned: true,
    });
  });

  it("fails closed for an unknown extension target type", () => {
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    ledger.recordTargetCreated({
      targetId: "unknown-extension-target",
      type: "other",
      url: `chrome-extension://${extensionId}/unknown.html`,
    });
    expect(ledger.snapshot().unsupportedTargets).toContain(
      "unknown-extension-target",
    );
  });
});

describe("browser audit network classification", () => {
  it("computes the RFC 6455 WebSocket accept value", () => {
    expect(webSocketAccept("dGhlIHNhbXBsZSBub25jZQ==")).toBe(
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
  });

  it("redacts non-fixture paths and query values, including a secret marker", () => {
    const safe = sanitizeUrl("http://127.0.0.1:43127/leak?text=DO_NOT_RECORD", {
      fixtureUrls,
      extensionId,
    });
    expect(safe).not.toContain("DO_NOT_RECORD");
    expect(safe).toContain("<redacted>");
  });

  it("allows only exact synthetic fixture controls and exact root navigation", () => {
    expect(
      classifyNetworkEvent({
        url: fixtureUrls.root,
        targetScope: "page",
        resourceType: "Document",
        isNavigation: true,
        fixtureUrls,
        extensionId,
      }),
    ).toMatchObject({ kind: "fixture-navigation", allowed: true });
    expect(
      classifyNetworkEvent({
        url: fixtureUrls.control,
        targetScope: "dedicatedworker",
        resourceType: "Fetch",
        fixtureUrls,
        extensionId,
      }),
    ).toMatchObject({ kind: "fixture-control", allowed: true });
    expect(
      classifyNetworkEvent({
        url: `${fixtureOrigin}/leak?text=DO_NOT_RECORD`,
        targetScope: "page",
        resourceType: "Fetch",
        fixtureUrls,
        extensionId,
      }),
    ).toMatchObject({ kind: "unexpected-page-request", allowed: false });
    expect(
      classifyNetworkEvent({
        url: fixtureUrls.control,
        targetScope: "page",
        resourceType: "Fetch",
        fixtureUrls,
        extensionId,
        extensionOwned: true,
      }),
    ).toMatchObject({ kind: "extension-request", allowed: false });
    expect(
      classifyNetworkEvent({
        url: `chrome-extension://${extensionId}/worker.js`,
        targetScope: "extension-dedicatedworker",
        resourceType: "Script",
        fixtureUrls,
        extensionId,
      }),
    ).toMatchObject({ kind: "extension-local", allowed: true });
    expect(
      classifyNetworkEvent({
        url: fixtureUrls.websocket,
        targetScope: "page",
        resourceType: "WebSocket",
        fixtureUrls,
        extensionId,
      }),
    ).toMatchObject({ kind: "fixture-control", allowed: true });
    expect(
      classifyNetworkEvent({
        url: `blob:${fixtureOrigin}/worker-script-id`,
        targetScope: "dedicatedworker",
        resourceType: "Script",
        fixtureUrls,
        extensionId,
      }),
    ).toMatchObject({ kind: "fixture-worker-blob-script", allowed: true });
    expect(
      classifyNetworkEvent({
        url: `blob:${fixtureOrigin}/page-script-id`,
        targetScope: "page",
        resourceType: "Script",
        fixtureUrls,
        extensionId,
      }),
    ).toMatchObject({ kind: "fixture-worker-blob-script", allowed: true });
    expect(
      classifyNetworkEvent({
        url: "blob:https://other.example/worker-script-id",
        targetScope: "dedicatedworker",
        resourceType: "Script",
        fixtureUrls,
        extensionId,
      }),
    ).toMatchObject({ kind: "unexpected-page-request", allowed: false });
    expect(
      classifyNetworkEvent({
        url: `blob:${fixtureOrigin}/image-id`,
        targetScope: "page",
        resourceType: "Image",
        fixtureUrls,
        extensionId,
      }),
    ).toMatchObject({ kind: "unexpected-page-request", allowed: false });
  });
});

describe("browser audit ledger", () => {
  it("keeps a detach as an uncovered gap until a destroyed event confirms a covered close", () => {
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    ledger.recordTargetCreated({
      targetId: "closed-page",
      type: "page",
      url: fixtureUrls.root,
    });
    ledger.recordAttached("closed-page", true);
    ledger.recordDetached("closed-page");
    expect(ledger.snapshot().unmonitoredTargets).toContain("closed-page");

    ledger.recordTargetDestroyed("closed-page");
    const target = ledger
      .snapshot()
      .targets.find((candidate) => candidate.targetId === "closed-page");
    expect(ledger.snapshot().unmonitoredTargets).not.toContain("closed-page");
    expect(target).toMatchObject({
      lifecycle: "destroyed",
      terminated: true,
      terminatedCovered: true,
      coverageStatus: "terminated-covered",
    });
  });

  it("keeps an uninstrumented destroyed target as a coverage failure", () => {
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    ledger.recordTargetCreated({
      targetId: "uncovered-page",
      type: "page",
      url: fixtureUrls.root,
    });
    ledger.recordTargetDestroyed("uncovered-page");
    const report = ledger.snapshot();
    expect(report.unmonitoredTargets).toContain("uncovered-page");
    expect(report.targets[0]).toMatchObject({
      lifecycle: "destroyed",
      terminated: true,
      terminatedCovered: false,
      coverageStatus: "terminated-uncovered",
    });
  });

  it("does not hide a live monitoring gap after target info changes before destruction", () => {
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    ledger.recordTargetCreated({
      targetId: "gap-page",
      type: "page",
      url: fixtureUrls.root,
    });
    ledger.recordAttached("gap-page", true);
    ledger.recordDetached("gap-page");
    ledger.recordTargetCreated({
      targetId: "gap-page",
      type: "page",
      url: fixtureUrls.root,
    });
    ledger.recordTargetDestroyed("gap-page");
    const target = ledger
      .snapshot()
      .targets.find((candidate) => candidate.targetId === "gap-page");
    expect(ledger.snapshot().unmonitoredTargets).toContain("gap-page");
    expect(target).toMatchObject({
      monitoringGap: true,
      monitoringGapCount: 1,
      coverageStatus: "terminated-uncovered",
    });
  });

  it("keeps a recovered monitoring gap as a lifetime coverage failure", () => {
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const targetInfo = {
      targetId: "recovered-gap-page",
      type: "page",
      url: fixtureUrls.root,
    };
    ledger.recordTargetCreated(targetInfo);
    ledger.recordAttached(targetInfo.targetId, true);
    ledger.recordDetached(targetInfo.targetId);
    ledger.recordTargetCreated(targetInfo);
    ledger.recordAttached(targetInfo.targetId, true);

    const liveReport = ledger.snapshot();
    expect(liveReport.unmonitoredTargets).not.toContain(targetInfo.targetId);
    expect(liveReport.coverageComplete).toBe(false);
    expect(liveReport.monitoringGapTargets).toContain(targetInfo.targetId);
    expect(liveReport.targets[0]).toMatchObject({
      lifecycle: "live",
      networkEnabled: true,
      monitoringGap: false,
      monitoringGapCount: 1,
    });

    ledger.recordTargetDestroyed(targetInfo.targetId);
    const terminated = ledger.snapshot();
    expect(terminated.unmonitoredTargets).toContain(targetInfo.targetId);
    expect(terminated.targets[0]).toMatchObject({
      lifecycle: "destroyed",
      terminatedCovered: false,
      coverageStatus: "terminated-uncovered",
    });
  });

  it("keeps destroyed targets terminal when late attach, detach, or metadata events arrive", () => {
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    ledger.recordTargetCreated({
      targetId: "terminal-page",
      type: "page",
      url: fixtureUrls.root,
    });
    ledger.recordAttached("terminal-page", true);
    ledger.recordTargetDestroyed("terminal-page");
    ledger.recordAttached("terminal-page", true);
    ledger.recordDetached("terminal-page");
    ledger.recordTargetCreated({
      targetId: "terminal-page",
      type: "worker",
      url: `${fixtureOrigin}/worker.js`,
    });
    expect(ledger.snapshot().targets[0]).toMatchObject({
      type: "page",
      lifecycle: "destroyed",
      terminated: true,
      terminatedCovered: true,
    });
  });

  it("tracks positive controls and reports an unmonitored extension target", () => {
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    ledger.recordTargetCreated({
      targetId: "page-1",
      type: "page",
      url: fixtureUrls.root,
    });
    ledger.recordTargetCreated({
      targetId: "worker-1",
      type: "worker",
      url: `${fixtureOrigin}/worker.js`,
    });
    ledger.recordTargetCreated({
      targetId: "sw-1",
      type: "service_worker",
      url: `${fixtureOrigin}/sw.js`,
    });
    ledger.recordTargetCreated({
      targetId: "ext-1",
      type: "service_worker",
      url: `chrome-extension://${extensionId}/background.js`,
    });
    ledger.recordAttached("page-1");
    ledger.recordAttached("worker-1");
    ledger.recordAttached("sw-1");
    ledger.recordNetworkRequest({
      targetId: "page-1",
      url: fixtureUrls.control,
      resourceType: "Fetch",
    });
    ledger.recordNetworkRequest({
      targetId: "worker-1",
      url: fixtureUrls.control,
      resourceType: "Fetch",
    });
    ledger.recordNetworkRequest({
      targetId: "sw-1",
      url: fixtureUrls.control,
      resourceType: "Fetch",
    });
    ledger.recordWebSocket({ targetId: "page-1", url: fixtureUrls.websocket });
    ledger.recordWebSocket({
      targetId: "worker-1",
      url: fixtureUrls.websocket,
    });
    const report = ledger.snapshot();
    expect(report.positiveControl.coveredScopes).toEqual(
      expect.arrayContaining([
        "page",
        "dedicatedworker",
        "fixture-service-worker",
      ]),
    );
    expect(report.coverageComplete).toBe(false);
    expect(report.unmonitoredTargets).toContain("ext-1");
    expect(report.positiveControl.missingWebSocketScopes).toEqual([]);
  });

  it("does not treat HTTP-only controls as complete", () => {
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    for (const [targetId, type, url] of [
      ["page-1", "page", fixtureUrls.root],
      ["worker-1", "worker", fixtureOrigin + "/worker.js"],
      ["sw-1", "service_worker", fixtureOrigin + "/sw.js"],
    ]) {
      ledger.recordTargetCreated({ targetId, type, url });
      ledger.recordAttached(targetId);
      ledger.recordNetworkRequest({
        targetId,
        url: fixtureUrls.control,
        resourceType: "Fetch",
      });
    }
    const report = ledger.snapshot();
    expect(report.coverageComplete).toBe(false);
    expect(report.positiveControl.missingWebSocketScopes).toEqual([
      "page",
      "dedicatedworker",
    ]);
  });

  it("reclassifies bootstrap events after the extension id is loaded", () => {
    const ledger = createAuditLedger({
      extensionId: "pending-extension-id",
      fixtureUrls,
    });
    ledger.recordTargetCreated({
      targetId: "bootstrap-worker",
      type: "service_worker",
      url: `chrome-extension://${extensionId}/background.js`,
    });
    ledger.recordAttached("bootstrap-worker");
    ledger.recordNetworkRequest({
      targetId: "bootstrap-worker",
      url: `chrome-extension://${extensionId}/background.js`,
      resourceType: "Script",
    });
    ledger.setExtensionId(extensionId);
    const report = ledger.snapshot();
    expect(report.targets[0]).toMatchObject({
      scope: "background-service-worker",
      extensionOwned: true,
      unexpectedRequests: 0,
    });
    expect(report.events[0]).toMatchObject({
      kind: "extension-local",
      allowed: true,
    });
  });

  it("requires all extension runtime scopes for final coverage", () => {
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const report = ledger.snapshot({ requireExtensionRuntime: true });
    expect(report.coverageComplete).toBe(false);
    expect(report.missingExtensionScopes).toEqual([
      "page",
      "background-service-worker",
      "offscreen",
      "extension-dedicatedworker",
    ]);
  });

  it("accepts final coverage when all extension runtime scopes are monitored", () => {
    const ledger = createAuditLedger({ extensionId, fixtureUrls });
    const fixtureTargets = [
      ["fixture-page", "page", fixtureUrls.root],
      ["fixture-worker", "worker", `${fixtureOrigin}/worker.js`],
      ["fixture-sw", "service_worker", `${fixtureOrigin}/sw.js`],
    ];
    for (const [targetId, type, url] of fixtureTargets) {
      ledger.recordTargetCreated({ targetId, type, url });
      ledger.recordAttached(targetId);
      ledger.recordNetworkRequest({
        targetId,
        url: fixtureUrls.control,
        resourceType: "Fetch",
      });
    }
    ledger.recordWebSocket({
      targetId: "fixture-page",
      url: fixtureUrls.websocket,
    });
    ledger.recordWebSocket({
      targetId: "fixture-worker",
      url: fixtureUrls.websocket,
    });
    const extensionTargets = [
      [
        "extension-page",
        "page",
        `chrome-extension://${extensionId}/popup.html`,
      ],
      [
        "extension-background",
        "service_worker",
        `chrome-extension://${extensionId}/background.js`,
      ],
      [
        "extension-offscreen",
        "page",
        `chrome-extension://${extensionId}/offscreen.html`,
      ],
      [
        "extension-worker",
        "worker",
        `chrome-extension://${extensionId}/worker.js`,
      ],
    ];
    for (const [targetId, type, url] of extensionTargets) {
      ledger.recordTargetCreated({ targetId, type, url });
      ledger.recordAttached(targetId, true);
    }
    const report = ledger.snapshot({ requireExtensionRuntime: true });
    expect(report.coverageComplete).toBe(true);
    expect(report.missingExtensionScopes).toEqual([]);
  });
});

describe("browser audit sampler", () => {
  it("returns the fallback when an audit operation never settles", async () => {
    await expect(
      boundedResult(() => new Promise(() => {}), "unavailable", 5),
    ).resolves.toBe("unavailable");
  });

  it("serializes slow samples and waits for the in-flight sample before final", async () => {
    let active = 0;
    let maximum = 0;
    const labels: string[] = [];
    const sampler = createSerialSampler(async (label: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      labels.push(label);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    });
    expect(sampler.tick("first")).toBe(true);
    expect(sampler.tick("overlap")).toBe(false);
    await sampler.stop("final");
    expect(maximum).toBe(1);
    expect(labels).toEqual(["first", "final"]);
    expect(sampler.tick("after-stop")).toBe(false);
  });
});

describe("browser process memory helpers", () => {
  it("selects Chromium descendants from profile-matched roots", () => {
    const rows = selectProcessTreeRows(
      [
        {
          ProcessId: 100,
          ParentProcessId: 1,
          CommandLine: 'chrome --user-data-dir="C:\\audit-profile"',
        },
        {
          ProcessId: 101,
          ParentProcessId: 100,
          CommandLine: "chrome --type=gpu",
        },
        {
          ProcessId: 102,
          ParentProcessId: 101,
          CommandLine: "chrome --type=renderer",
        },
        {
          ProcessId: 200,
          ParentProcessId: 1,
          CommandLine: 'other --user-data-dir="C:\\other-profile"',
        },
        { ProcessId: 201, ParentProcessId: 200, CommandLine: "other-child" },
      ],
      "C:/audit-profile",
    ) as Array<{ ProcessId: number }>;
    expect(rows.map((row) => row.ProcessId)).toEqual([100, 101, 102]);
  });

  it("parses Linux status and sums current and peak values", () => {
    const parsed = parseLinuxProcessStatus(
      "Name:\tchrome\nPPid:\t10\nVmRSS:\t1024 kB\nVmHWM:\t2048 kB\n",
    );
    expect(parsed).toMatchObject({
      parentPid: 10,
      currentBytes: 1024 * 1024,
      peakBytes: 2048 * 1024,
    });
    expect(
      sumProcessMemory([
        { pid: 11, parentPid: 10, currentBytes: 100, peakBytes: 150 },
        { pid: 12, parentPid: 11, currentBytes: 200, peakBytes: 250 },
      ]),
    ).toEqual({ currentBytes: 300, peakBytes: 400 });
  });

  it("parses Windows process rows without retaining command lines", () => {
    const rows = parseWindowsProcessRows([
      {
        ProcessId: 20,
        ParentProcessId: 1,
        WorkingSetSize: 1000,
        PeakWorkingSetSize: 1200,
        CommandLine: "secret",
      },
      {
        ProcessId: 21,
        ParentProcessId: 20,
        WorkingSetSize: "2000",
        PeakWorkingSetSize: "2400",
        CommandLine: "secret",
      },
    ]);
    expect(rows).toEqual([
      { pid: 20, parentPid: 1, currentBytes: 1000, peakBytes: 1200 * 1024 },
      { pid: 21, parentPid: 20, currentBytes: 2000, peakBytes: 2400 * 1024 },
    ]);
  });

  it("states unsupported platforms explicitly", () => {
    expect(platformMemorySupport("darwin")).toEqual({
      available: false,
      reason: "unsupported-platform",
    });
    expect(platformMemorySupport("linux")).toEqual({
      available: true,
      method: "procfs",
    });
    expect(platformMemorySupport("win32")).toEqual({
      available: true,
      method: "cim-process-tree",
    });
  });
});

describe("distribution asset identity", () => {
  const manifest = {
    files: {
      "model.onnx": { bytes: 3, sha256: "abc123" },
      "config.json": { bytes: 2, sha256: "def456" },
    },
  };

  it("accepts all declared model files with matching size and hash", () => {
    expect(
      verifyArtifactManifest(manifest, [
        { path: "model.onnx", bytes: 3, sha256: "ABC123" },
        { path: "config.json", bytes: 2, sha256: "def456" },
      ]),
    ).toMatchObject({ ok: true, missing: [], mismatches: [] });
  });

  it("fails closed on a missing or tampered declared file", () => {
    expect(
      verifyArtifactManifest(manifest, [
        { path: "model.onnx", bytes: 4, sha256: "tampered" },
      ]),
    ).toMatchObject({
      ok: false,
      missing: ["config.json"],
      mismatches: [
        { path: "model.onnx", field: "bytes" },
        { path: "model.onnx", field: "sha256" },
      ],
    });
  });

  it("fails closed on an empty or malformed manifest", () => {
    expect(verifyArtifactManifest({}, [])).toMatchObject({
      ok: false,
      malformed: ["manifest.files"],
    });
    expect(verifyArtifactManifest({ files: [{}] }, [])).toMatchObject({
      ok: false,
      malformed: ["manifest.files[0]"],
    });
  });
});
