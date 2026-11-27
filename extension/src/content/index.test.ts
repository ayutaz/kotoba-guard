import { afterEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => unknown;

function makeRuntime() {
  const listeners: Listener[] = [];
  const sendMessage = vi.fn().mockResolvedValue({
    state: {
      globalEnabled: true,
      siteEnabled: true,
      origin: "https://example.test",
    },
  });
  vi.stubGlobal("chrome", {
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      sendMessage,
      onMessage: {
        addListener: (listener: Listener) => listeners.push(listener),
      },
    },
  });
  return { listeners, sendMessage };
}

describe("content entry message boundary", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    delete (globalThis as { __kotobaGuardContentEntry?: boolean })
      .__kotobaGuardContentEntry;
    document.body.innerHTML = "";
  });

  it("accepts trusted state and manual messages", async () => {
    const { listeners } = makeRuntime();
    document.body.innerHTML = '<textarea id="editor">本文</textarea>';
    await import("./index");
    const listener = listeners[0]!;
    const response = vi.fn();
    const sender = { id: "abcdefghijklmnopabcdefghijklmnop" };
    expect(
      listener(
        {
          type: "set-state",
          state: {
            globalEnabled: true,
            siteEnabled: true,
            origin: "https://example.test",
          },
        },
        sender,
        response,
      ),
    ).toBe(false);
    expect(response).toHaveBeenCalledWith({ ok: true });
    expect(listener({ type: "manual-check" }, sender, response)).toBe(false);
    expect(response).toHaveBeenLastCalledWith({ ok: true });
  });

  it("rejects messages from a web page or unknown shape", async () => {
    const { listeners } = makeRuntime();
    await import("./index");
    const listener = listeners[0]!;
    const response = vi.fn();
    expect(
      listener({ type: "set-state", enabled: true }, { id: "web" }, response),
    ).toBe(false);
    expect(response).not.toHaveBeenCalled();
    expect(
      listener(
        { type: "unknown" },
        { id: "abcdefghijklmnopabcdefghijklmnop" },
        response,
      ),
    ).toBe(false);
    expect(response).not.toHaveBeenCalled();
  });

  it("initializes only once when the content entry is injected again", async () => {
    const { listeners, sendMessage } = makeRuntime();
    document.body.innerHTML = '<textarea id="editor">本文</textarea>';
    await import("./index");
    vi.resetModules();
    await import("./index");
    expect(listeners).toHaveLength(1);
    expect(
      sendMessage.mock.calls.filter(
        ([message]) => (message as { type: string }).type === "content-ready",
      ),
    ).toHaveLength(1);
  });
});
