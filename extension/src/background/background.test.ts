import { afterEach, describe, expect, it, vi } from "vitest";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_INSTANCE_ID = "22222222-2222-4222-8222-222222222222";

type EventHook = {
  addListener: (listener: (...args: unknown[]) => unknown) => void;
  listeners: Array<(...args: unknown[]) => unknown>;
};

function hook(): EventHook {
  const event: EventHook = {
    listeners: [],
    addListener(listener) {
      event.listeners.push(listener);
    },
  };
  return event;
}

async function loadBackground(options?: {
  permission?: boolean;
  enabledSites?: string[];
  removeFails?: boolean;
  tabs?: Array<{ id: number; url: string }>;
}) {
  const runtimeMessage = hook();
  const installed = hook();
  const removed = hook();
  const permissionRemoved = hook();
  const sendMessage = vi.fn().mockResolvedValue({ ok: true, result: {} });
  const instanceProbe = vi.fn().mockResolvedValue({ instanceId: INSTANCE_ID });
  const runtimeSendMessage = vi.fn((message: { type?: string }) =>
    message.type === "offscreen-instance"
      ? instanceProbe(message)
      : sendMessage(message),
  );
  const storageSet = vi.fn().mockResolvedValue(undefined);
  const permission = options?.permission ?? true;
  const contains = vi.fn().mockResolvedValue(permission);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      onMessage: runtimeMessage,
      onInstalled: installed,
      sendMessage: runtimeSendMessage,
    },
    tabs: {
      onRemoved: removed,
      query: vi.fn().mockResolvedValue(options?.tabs ?? []),
      get: vi.fn().mockResolvedValue({ id: 1, url: "https://example.test/" }),
      sendMessage: vi.fn().mockResolvedValue({ ok: true }),
    },
    permissions: {
      contains,
      remove: options?.removeFails
        ? vi.fn().mockRejectedValue(new Error("remove-failed"))
        : vi.fn().mockResolvedValue(true),
      onRemoved: permissionRemoved,
    },
    scripting: {
      unregisterContentScripts: vi.fn().mockResolvedValue(undefined),
      registerContentScripts: vi.fn().mockResolvedValue(undefined),
      executeScript: vi.fn().mockResolvedValue(undefined),
    },
    offscreen: {
      createDocument: vi.fn().mockResolvedValue(undefined),
      closeDocument: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({
          globalEnabled: true,
          enabledSites: options?.enabledSites ?? [],
        }),
        set: storageSet,
      },
    },
  });
  vi.resetModules();
  await import("./background");
  await Promise.resolve();
  await Promise.resolve();
  return {
    runtimeMessage,
    instanceProbe,
    runtimeSendMessage,
    permissionRemoved,
    storageSet,
    sendMessage,
    contains,
  };
}

const id = "abcdefghijklmnopabcdefghijklmnop";
const popup = { id, url: `chrome-extension://${id}/popup.html` };
const tabSender = { id, tab: { id: 1, url: "https://example.test/" } };

describe("background dispatcher security boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    null,
    {},
    { instanceId: "invalid" },
    { instanceId: INSTANCE_ID, extra: true },
  ])(
    "does not identify or close with a malformed live-instance response %j",
    async (probeResponse) => {
      const loaded = await loadBackground();
      loaded.instanceProbe.mockResolvedValue(probeResponse);
      Object.assign(chrome.runtime, {
        getContexts: vi.fn().mockResolvedValue([{ documentId: "current" }]),
      });
      const listener = loaded.runtimeMessage.listeners[0]!;
      const sender = {
        id,
        url: `chrome-extension://${id}/offscreen.html`,
        documentId: null,
      };
      const identified = vi.fn();
      listener(
        { type: "offscreen-identify", instanceId: INSTANCE_ID },
        sender,
        identified,
      );
      await vi.waitFor(() =>
        expect(identified).toHaveBeenCalledWith({
          ok: false,
          code: "offscreen-identity-unavailable",
        }),
      );
      const closed = vi.fn();
      listener(
        {
          type: "offscreen-idle",
          instanceId: INSTANCE_ID,
          documentId: "current",
          releases: { completed: 1, failed: 0, timedOut: 0, sendFailed: 0 },
        },
        sender,
        closed,
      );
      await vi.waitFor(() =>
        expect(closed).toHaveBeenCalledWith({
          ok: false,
          code: "offscreen-close-failed",
        }),
      );
      expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled();
      expect(loaded.storageSet).not.toHaveBeenCalled();
    },
  );

  it("rejects a stale instance with null sender documentId even when it declares the current document", async () => {
    const loaded = await loadBackground();
    Object.assign(chrome.runtime, {
      getContexts: vi.fn().mockResolvedValue([{ documentId: "current" }]),
    });
    const listener = loaded.runtimeMessage.listeners[0]!;
    const fromOffscreen = {
      id,
      url: `chrome-extension://${id}/offscreen.html`,
      documentId: null,
    };
    const identified = vi.fn();
    expect(
      listener(
        { type: "offscreen-identify", instanceId: OTHER_INSTANCE_ID },
        fromOffscreen,
        identified,
      ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(identified).toHaveBeenCalledWith({
        ok: false,
        code: "offscreen-identity-unavailable",
      }),
    );
    const retired = vi.fn();
    listener(
      {
        type: "offscreen-idle",
        documentId: "current",
        instanceId: OTHER_INSTANCE_ID,
        releases: { completed: 1, failed: 0, timedOut: 0, sendFailed: 0 },
      },
      fromOffscreen,
      retired,
    );
    await vi.waitFor(() =>
      expect(retired).toHaveBeenCalledWith({ ok: true, closed: false }),
    );
    expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled();
    expect(loaded.instanceProbe).toHaveBeenCalledWith({
      type: "offscreen-instance",
    });
    expect(loaded.storageSet).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "not-a-uuid"])(
    "rejects a malformed caller instance %s before any Chrome probe",
    async (instanceId) => {
      const loaded = await loadBackground();
      const getContexts = vi
        .fn()
        .mockResolvedValue([{ documentId: "current" }]);
      Object.assign(chrome.runtime, { getContexts });
      const listener = loaded.runtimeMessage.listeners[0]!;
      const fromOffscreen = {
        id,
        url: `chrome-extension://${id}/offscreen.html`,
      };
      for (const raw of [
        { type: "offscreen-identify", instanceId },
        {
          type: "offscreen-idle",
          documentId: "current",
          instanceId,
          releases: { completed: 1, failed: 0, timedOut: 0, sendFailed: 0 },
        },
      ])
        expect(listener(raw, fromOffscreen, vi.fn())).toBe(false);
      expect(getContexts).not.toHaveBeenCalled();
      expect(loaded.instanceProbe).not.toHaveBeenCalled();
    },
  );

  it("brokers current identity only to the actual offscreen document", async () => {
    const loaded = await loadBackground();
    const getContexts = vi.fn().mockResolvedValue([{ documentId: "current" }]);
    Object.assign(chrome.runtime, { getContexts });
    const listener = loaded.runtimeMessage.listeners[0]!;
    const fromOffscreen = {
      id,
      url: `chrome-extension://${id}/offscreen.html`,
    };
    for (const sender of [
      popup,
      tabSender,
      { ...fromOffscreen, id: "foreign" },
      { ...fromOffscreen, tab: tabSender.tab },
    ])
      expect(
        listener(
          { type: "offscreen-identify", instanceId: INSTANCE_ID },
          sender,
          vi.fn(),
        ),
      ).toBe(false);
    expect(
      listener(
        { type: "offscreen-identify", instanceId: INSTANCE_ID, extra: true },
        fromOffscreen,
        vi.fn(),
      ),
    ).toBe(false);
    expect(getContexts).not.toHaveBeenCalled();
    const response = vi.fn();
    expect(
      listener(
        { type: "offscreen-identify", instanceId: INSTANCE_ID },
        fromOffscreen,
        response,
      ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(response).toHaveBeenCalledWith({
        ok: true,
        documentId: "current",
      }),
    );
    const stale = vi.fn();
    listener(
      { type: "offscreen-identify", instanceId: INSTANCE_ID },
      { ...fromOffscreen, documentId: "old" },
      stale,
    );
    await vi.waitFor(() =>
      expect(stale).toHaveBeenCalledWith({
        ok: false,
        code: "offscreen-identity-unavailable",
      }),
    );
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
    expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled();
  });

  it.each([undefined, null])(
    "accepts a current self-declared ID when sender.documentId is %s",
    async (documentId) => {
      const loaded = await loadBackground();
      Object.assign(chrome.runtime, {
        getContexts: vi.fn().mockResolvedValue([{ documentId: "current" }]),
      });
      const response = vi.fn();
      loaded.runtimeMessage.listeners[0]!(
        {
          type: "offscreen-idle",
          instanceId: INSTANCE_ID,
          documentId: "current",
          releases: { completed: 1, failed: 0, timedOut: 0, sendFailed: 0 },
        },
        { id, url: `chrome-extension://${id}/offscreen.html`, documentId },
        response,
      );
      await vi.waitFor(() =>
        expect(chrome.offscreen.closeDocument).toHaveBeenCalledOnce(),
      );
      expect(response).toHaveBeenCalledWith({ ok: true, closed: true });
    },
  );

  it("waits for document close before sending inference to a replacement", async () => {
    const loaded = await loadBackground({
      enabledSites: ["https://example.test"],
    });
    loaded.sendMessage.mockResolvedValue({
      ok: true,
      result: {
        detections: [],
        inferenceMs: 1,
        backend: "wasm",
        modelVersion: "test",
      },
    });
    const getContexts = vi.fn().mockResolvedValue([{ documentId: "current" }]);
    Object.assign(chrome.runtime, { getContexts });
    let finish!: () => void;
    vi.mocked(chrome.offscreen.closeDocument).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const listener = loaded.runtimeMessage.listeners[0]!;
    const idleResponse = vi.fn();
    listener(
      {
        type: "offscreen-idle",
        instanceId: INSTANCE_ID,
        documentId: "current",
        releases: { completed: 1, failed: 0, timedOut: 0, sendFailed: 0 },
      },
      {
        id,
        url: `chrome-extension://${id}/offscreen.html`,
        documentId: "current",
      },
      idleResponse,
    );
    await vi.waitFor(() =>
      expect(chrome.offscreen.closeDocument).toHaveBeenCalledOnce(),
    );
    getContexts.mockResolvedValue([]);
    const detected = vi.fn();
    listener(
      { type: "check", requestId: 1, text: "本文" },
      tabSender,
      detected,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loaded.sendMessage).not.toHaveBeenCalled();
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() =>
      expect(detected).toHaveBeenCalledWith(
        expect.objectContaining({ type: "check-result" }),
      ),
    );
    expect(chrome.offscreen.createDocument).toHaveBeenCalledOnce();
    expect(loaded.sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: "offscreen-detect",
      text: "本文",
    });
    expect(idleResponse).toHaveBeenCalledWith({ ok: true, closed: true });
  });

  it("rejects idle notices from tabs, popup, malformed payloads and stale documents", async () => {
    const loaded = await loadBackground();
    const getContexts = vi.fn().mockResolvedValue([{ documentId: "new" }]);
    Object.assign(chrome.runtime, { getContexts });
    const listener = loaded.runtimeMessage.listeners[0]!;
    const notice = {
      type: "offscreen-idle",
      instanceId: INSTANCE_ID,
      documentId: "old",
      releases: { completed: 1, failed: 0, timedOut: 0, sendFailed: 0 },
    };
    const old = {
      id,
      url: `chrome-extension://${id}/offscreen.html`,
      documentId: "old",
    };
    for (const [raw, sender] of [
      [notice, tabSender],
      [notice, popup],
      [{ ...notice, text: "本文" }, old],
      [{ ...notice, releases: {} }, old],
      [{ ...notice, documentId: undefined }, old],
      [notice, { ...old, documentId: "different" }],
      [notice, { ...old, tab: tabSender.tab }],
      [notice, { ...old, id: "foreign" }],
      [notice, { ...old, url: `${old.url}?fake` }],
      [{ ...notice, releases: { ...notice.releases, completed: -1 } }, old],
      [{ ...notice, releases: { ...notice.releases, completed: 0.5 } }, old],
      [{ ...notice, releases: { ...notice.releases, completed: 0 } }, old],
      [{ ...notice, releases: { ...notice.releases, extra: 0 } }, old],
    ] as const) {
      expect(listener(raw, sender, vi.fn())).toBe(false);
    }
    expect(getContexts).not.toHaveBeenCalled();
    const response = vi.fn();
    expect(listener(notice, old, response)).toBe(true);
    await vi.waitFor(() =>
      expect(response).toHaveBeenCalledWith({ ok: true, closed: false }),
    );
    expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled();
  });

  it("discards a readiness response from a document whose close has started", async () => {
    const loaded = await loadBackground();
    Object.assign(chrome.runtime, {
      getContexts: vi.fn().mockResolvedValue([{ documentId: "current" }]),
    });
    let settle!: (value: unknown) => void;
    loaded.sendMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const listener = loaded.runtimeMessage.listeners[0]!;
    const statusResponse = vi.fn();
    listener({ type: "get-status" }, popup, statusResponse);
    await vi.waitFor(() => expect(loaded.sendMessage).toHaveBeenCalledOnce());
    const idle = vi.fn();
    listener(
      {
        type: "offscreen-idle",
        instanceId: INSTANCE_ID,
        documentId: "current",
        releases: { completed: 1, failed: 0, timedOut: 0, sendFailed: 0 },
      },
      {
        id,
        url: `chrome-extension://${id}/offscreen.html`,
        documentId: "current",
      },
      idle,
    );
    await vi.waitFor(() =>
      expect(idle).toHaveBeenCalledWith({ ok: true, closed: true }),
    );
    settle({ ready: true });
    await vi.waitFor(() =>
      expect(statusResponse).toHaveBeenCalledWith(
        expect.objectContaining({ modelReady: false }),
      ),
    );
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it("shares one unanswered readiness operation across repeated timeouts and recovers after settlement", async () => {
    vi.useFakeTimers();
    try {
      const loaded = await loadBackground();
      Object.assign(chrome.runtime, {
        getContexts: vi.fn().mockResolvedValue([{}]),
      });
      let settle: (value: unknown) => void = () => {
        throw new Error("not-started");
      };
      loaded.sendMessage.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      );
      loaded.sendMessage.mockResolvedValue({ ready: true });
      const listener = loaded.runtimeMessage.listeners[0]!;
      const first = vi.fn();
      listener({ type: "get-status" }, popup, first);
      await vi.advanceTimersByTimeAsync(1000);
      expect(first).toHaveBeenCalledWith(
        expect.objectContaining({ modelReady: false }),
      );
      const repeated = Array.from({ length: 5 }, () => vi.fn());
      for (const response of repeated)
        listener({ type: "get-status" }, popup, response);
      await vi.advanceTimersByTimeAsync(1000);
      expect(loaded.sendMessage).toHaveBeenCalledTimes(1);
      expect(
        repeated.every((response) => response.mock.calls.length === 1),
      ).toBe(true);
      settle({ ready: true });
      await vi.advanceTimersByTimeAsync(0);
      const recovered = vi.fn();
      listener({ type: "get-status" }, popup, recovered);
      await vi.advanceTimersByTimeAsync(0);
      expect(recovered).toHaveBeenCalledWith(
        expect.objectContaining({ modelReady: true }),
      );
      expect(loaded.sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds an unresponsive readiness query without loading the model", async () => {
    vi.useFakeTimers();
    try {
      const loaded = await loadBackground();
      Object.assign(chrome.runtime, {
        getContexts: vi.fn().mockResolvedValue([{}]),
      });
      loaded.sendMessage.mockImplementation(() => new Promise(() => {}));
      const response = vi.fn();
      loaded.runtimeMessage.listeners[0]!(
        { type: "get-status" },
        popup,
        response,
      );
      await vi.advanceTimersByTimeAsync(999);
      expect(response).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(response).toHaveBeenCalledWith(
        expect.objectContaining({ modelReady: false }),
      );
      expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([null, { ready: "true" }, { ok: true }])(
    "rejects malformed readiness %j",
    async (value) => {
      const loaded = await loadBackground();
      Object.assign(chrome.runtime, {
        getContexts: vi.fn().mockResolvedValue([{}]),
      });
      loaded.sendMessage.mockResolvedValue(value);
      const response = vi.fn();
      loaded.runtimeMessage.listeners[0]!(
        { type: "get-status" },
        popup,
        response,
      );
      await vi.waitFor(() =>
        expect(response).toHaveBeenCalledWith(
          expect.objectContaining({ modelReady: false }),
        ),
      );
    },
  );

  it("uses existing offscreen readiness instead of historical modelReady and never loads for status", async () => {
    const loaded = await loadBackground();
    const getContexts = vi.fn().mockResolvedValue([{}]);
    Object.assign(chrome.runtime, { getContexts });
    loaded.sendMessage.mockResolvedValue({ ready: true });
    const listener = loaded.runtimeMessage.listeners[0]!;
    const ready = vi.fn();
    listener({ type: "get-status", tabId: 1 }, popup, ready);
    await vi.waitFor(() =>
      expect(ready).toHaveBeenCalledWith(
        expect.objectContaining({ modelReady: true, backend: "wasm" }),
      ),
    );
    loaded.sendMessage.mockResolvedValue({ ready: false });
    const idle = vi.fn();
    listener({ type: "get-status", tabId: 1 }, popup, idle);
    await vi.waitFor(() =>
      expect(idle).toHaveBeenCalledWith(
        expect.objectContaining({ modelReady: false, backend: "unknown" }),
      ),
    );
    getContexts.mockResolvedValue([]);
    loaded.sendMessage.mockClear();
    const absent = vi.fn();
    listener({ type: "get-status", tabId: 1 }, popup, absent);
    await vi.waitFor(() =>
      expect(absent).toHaveBeenCalledWith(
        expect.objectContaining({ modelReady: false }),
      ),
    );
    expect(loaded.sendMessage).not.toHaveBeenCalled();
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
    const internal = vi.fn();
    expect(listener({ type: "offscreen-status" }, popup, internal)).toBe(false);
    expect(internal).not.toHaveBeenCalled();
  });

  it("rejects untrusted and malformed privileged messages", async () => {
    const { runtimeMessage } = await loadBackground();
    const listener = runtimeMessage.listeners[0]!;
    const response = vi.fn();
    expect(
      listener(
        { type: "set-global-enabled", enabled: false },
        { id: "web" },
        response,
      ),
    ).toBe(false);
    expect(response).not.toHaveBeenCalled();
    expect(
      listener({ type: "set-global-enabled", enabled: "no" }, popup, response),
    ).toBe(false);
    expect(response).toHaveBeenCalledWith({
      ok: false,
      code: "invalid-message",
    });
  });

  it("requires a current host permission before enabling a site", async () => {
    const { runtimeMessage, storageSet } = await loadBackground({
      permission: false,
    });
    const listener = runtimeMessage.listeners[0]!;
    const response = vi.fn();
    expect(
      listener(
        {
          type: "set-site-enabled",
          origin: "https://example.test",
          enabled: true,
        },
        popup,
        response,
      ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(response).toHaveBeenCalledWith({
        ok: false,
        code: "permission-required",
      }),
    );
    expect(storageSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ enabledSites: ["https://example.test"] }),
    );
  });

  it("does not infer content after a revoked permission is reconciled", async () => {
    const { runtimeMessage, sendMessage } = await loadBackground({
      permission: false,
      enabledSites: ["https://example.test"],
    });
    const listener = runtimeMessage.listeners[0]!;
    const response = vi.fn();
    listener(
      { type: "check", requestId: 1, text: "本文" },
      tabSender,
      response,
    );
    await Promise.resolve();
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "offscreen-detect" }),
    );
    expect(response).not.toHaveBeenCalled();
  });

  it("broadcasts disable state even when permission removal fails", async () => {
    const { runtimeMessage, storageSet } = await loadBackground({
      permission: true,
      enabledSites: ["https://example.test"],
      removeFails: true,
      tabs: [{ id: 1, url: "https://example.test/" }],
    });
    const listener = runtimeMessage.listeners[0]!;
    const response = vi.fn();
    listener(
      {
        type: "set-site-enabled",
        origin: "https://example.test",
        enabled: false,
      },
      popup,
      response,
    );
    await vi.waitFor(() =>
      expect(response).toHaveBeenCalledWith({
        ok: false,
        code: "permission-remove-failed",
      }),
    );
    expect(storageSet).toHaveBeenCalledWith({
      globalEnabled: true,
      enabledSites: [],
    });
    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({
      ids: ["kotoba-guard-content"],
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, {
      type: "set-state",
      state: {
        globalEnabled: true,
        siteEnabled: false,
        origin: "https://example.test",
      },
    });
  });

  it("reconciles a native permission revocation and stops subsequent checks", async () => {
    const {
      runtimeMessage,
      permissionRemoved,
      storageSet,
      contains,
      sendMessage,
    } = await loadBackground({
      permission: true,
      enabledSites: ["https://example.test"],
    });
    contains.mockResolvedValue(false);
    permissionRemoved.listeners[0]?.({ origins: ["https://example.test/*"] });
    await vi.waitFor(() =>
      expect(storageSet).toHaveBeenCalledWith({
        globalEnabled: true,
        enabledSites: [],
      }),
    );
    const response = vi.fn();
    runtimeMessage.listeners[0]?.(
      { type: "check", requestId: 2, text: "本文" },
      tabSender,
      response,
    );
    await Promise.resolve();
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "offscreen-detect" }),
    );
  });

  it("injects only already-open tabs on the newly enabled origin", async () => {
    const { runtimeMessage } = await loadBackground({
      permission: true,
      tabs: [
        { id: 1, url: "https://example.test/editor" },
        { id: 2, url: "https://other.test/editor" },
        { id: 3, url: "chrome://settings/" },
      ],
    });
    const listener = runtimeMessage.listeners[0]!;
    const response = vi.fn();
    listener(
      {
        type: "set-site-enabled",
        origin: "https://example.test",
        enabled: true,
      },
      popup,
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledWith({ ok: true }));
    const chromeApi = globalThis.chrome as unknown as {
      scripting: { executeScript: ReturnType<typeof vi.fn> };
    };
    expect(chromeApi.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(chromeApi.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 1 },
      files: ["content.js"],
    });
  });

  it("continues with another matching tab when one injection is restricted", async () => {
    const { runtimeMessage } = await loadBackground({
      permission: true,
      tabs: [
        { id: 1, url: "https://example.test/first" },
        { id: 2, url: "https://example.test/second" },
      ],
    });
    const chromeApi = globalThis.chrome as unknown as {
      scripting: { executeScript: ReturnType<typeof vi.fn> };
    };
    chromeApi.scripting.executeScript
      .mockRejectedValueOnce(new Error("restricted"))
      .mockResolvedValue(undefined);
    const response = vi.fn();
    runtimeMessage.listeners[0]?.(
      {
        type: "set-site-enabled",
        origin: "https://example.test",
        enabled: true,
      },
      popup,
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledWith({ ok: true }));
    expect(chromeApi.scripting.executeScript).toHaveBeenCalledTimes(2);
  });

  it("returns busy at the bounded queue and drops an in-flight result after toggling", async () => {
    const loaded = await loadBackground({
      permission: true,
      enabledSites: ["https://example.test"],
    });
    let resolveDetect: ((value: unknown) => void) | undefined;
    loaded.sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === "offscreen-detect")
        return new Promise((resolve) => {
          resolveDetect = resolve;
        });
      return Promise.resolve({ ok: true });
    });
    const listener = loaded.runtimeMessage.listeners[0]!;
    const first = vi.fn();
    listener({ type: "check", requestId: 1, text: "一" }, tabSender, first);
    await vi.waitFor(() =>
      expect(loaded.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "offscreen-detect" }),
      ),
    );
    const second = vi.fn();
    const third = vi.fn();
    listener({ type: "check", requestId: 2, text: "二" }, tabSender, second);
    listener({ type: "check", requestId: 3, text: "三" }, tabSender, third);
    await vi.waitFor(() =>
      expect(third).toHaveBeenCalledWith({
        type: "check-error",
        requestId: 3,
        code: "busy",
      }),
    );

    const disabled = vi.fn();
    listener({ type: "set-global-enabled", enabled: false }, popup, disabled);
    await vi.waitFor(() => expect(disabled).toHaveBeenCalledWith({ ok: true }));
    const enabled = vi.fn();
    listener({ type: "set-global-enabled", enabled: true }, popup, enabled);
    await vi.waitFor(() => expect(enabled).toHaveBeenCalledWith({ ok: true }));
    resolveDetect?.({
      ok: true,
      result: {
        detections: [],
        inferenceMs: 1,
        backend: "wasm",
        modelVersion: "test",
      },
    });
    await vi.waitFor(() =>
      expect(first).toHaveBeenCalledWith({
        type: "check-error",
        requestId: 1,
        code: "disabled",
      }),
    );
  });

  it("reports only the latest in-memory count for the current tab and clears it on disable", async () => {
    const loaded = await loadBackground({
      permission: true,
      enabledSites: ["https://example.test"],
    });
    loaded.sendMessage.mockResolvedValue({
      ok: true,
      result: {
        detections: [
          { start: 0, end: 1, text: "一", type: "typo", confidence: 0.9 },
          { start: 1, end: 2, text: "文", type: "typo", confidence: 0.8 },
        ],
        inferenceMs: 1,
        backend: "wasm",
        modelVersion: "abcdef1234567890",
      },
    });
    const listener = loaded.runtimeMessage.listeners[0]!;
    const checkResponse = vi.fn();
    listener(
      { type: "check", requestId: 4, text: "一文" },
      tabSender,
      checkResponse,
    );
    await vi.waitFor(() => expect(checkResponse).toHaveBeenCalled());
    const status = vi.fn();
    listener({ type: "get-status", tabId: 1 }, popup, status);
    await vi.waitFor(() =>
      expect(status).toHaveBeenCalledWith(
        expect.objectContaining({
          modelVersion: "abcdef1234567890",
          detectionCount: 2,
        }),
      ),
    );
    const disable = vi.fn();
    listener({ type: "set-global-enabled", enabled: false }, popup, disable);
    await vi.waitFor(() => expect(disable).toHaveBeenCalledWith({ ok: true }));
    const cleared = vi.fn();
    listener({ type: "get-status", tabId: 1 }, popup, cleared);
    await vi.waitFor(() =>
      expect(cleared).toHaveBeenCalledWith(
        expect.objectContaining({ detectionCount: 0 }),
      ),
    );
  });
});
