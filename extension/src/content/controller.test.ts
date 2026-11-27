import { describe, expect, it, vi } from "vitest";
import { ContentController } from "./controller";

describe("ContentController", () => {
  it("does not read or schedule a composition update until compositionend", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor"></textarea>';
    const editor = document.querySelector("textarea")!;
    const send = vi.fn().mockResolvedValue({
      state: {
        globalEnabled: true,
        siteEnabled: true,
        origin: "https://example.test",
      },
    });
    const controller = new ContentController({
      debounceMs: 100,
      sendMessage: send,
    });
    controller.start();
    controller.setState(true);
    editor.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    editor.value = "変換中";
    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertCompositionText",
      }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(
      send.mock.calls.filter(
        ([message]) => (message as { type: string }).type === "check",
      ),
    ).toHaveLength(0);
    editor.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(
      send.mock.calls.filter(
        ([message]) => (message as { type: string }).type === "check",
      ),
    ).toHaveLength(1);
    vi.useRealTimers();
  });

  it("drops stale results when a newer input has been requested", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor"></textarea>';
    const editor = document.querySelector("textarea")!;
    const responses: Array<(value: unknown) => void> = [];
    const send = vi.fn().mockImplementation((message: { type: string }) =>
      message.type === "check"
        ? new Promise((resolve) => responses.push(resolve))
        : Promise.resolve({
            state: { globalEnabled: true, siteEnabled: true },
          }),
    );
    const controller = new ContentController({
      debounceMs: 1,
      sendMessage: send,
    });
    controller.start();
    controller.setState(true);
    editor.value = "古い";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    editor.value = "新しい";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    expect(responses).toHaveLength(1);
    responses[0]?.({
      type: "check-result",
      requestId: 1,
      result: {
        detections: [
          { start: 0, end: 2, text: "古い", type: "x", confidence: 1 },
        ],
        inferenceMs: 1,
        backend: "wasm",
        modelVersion: "test",
      },
    });
    await Promise.resolve();
    expect(document.querySelector(".kotoba-guard-overlay")).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(responses).toHaveLength(2);
    expect(document.querySelector(".kotoba-guard-overlay")).toBeNull();
    controller.stop();
    vi.useRealTimers();
  });

  it("ignores a pending manual result after global disable", async () => {
    document.body.innerHTML = '<textarea id="editor">本文</textarea>';
    const editor = document.querySelector("textarea")!;
    let resolveCheck: ((value: unknown) => void) | undefined;
    const send = vi.fn().mockImplementation((message: { type: string }) =>
      message.type === "check"
        ? new Promise((resolve) => {
            resolveCheck = resolve;
          })
        : Promise.resolve({
            state: { globalEnabled: true, siteEnabled: false },
          }),
    );
    const controller = new ContentController({ sendMessage: send });
    controller.start();
    await Promise.resolve();
    controller.setState({ globalEnabled: true, siteEnabled: false });
    controller.manualCheck(editor);
    controller.setState(false);
    resolveCheck?.({
      type: "check-result",
      requestId: 1,
      result: {
        detections: [
          { start: 0, end: 2, text: "本文", type: "x", confidence: 1 },
        ],
        inferenceMs: 1,
        backend: "wasm",
        modelVersion: "test",
      },
    });
    await Promise.resolve();
    expect(document.querySelector(".kotoba-guard-overlay")).toBeNull();
  });

  it("does not run a manual check while IME composition is active", async () => {
    document.body.innerHTML = '<textarea id="editor">変換中</textarea>';
    const editor = document.querySelector("textarea")!;
    const send = vi.fn().mockResolvedValue({
      state: { globalEnabled: true, siteEnabled: false },
    });
    const controller = new ContentController({ sendMessage: send });
    controller.start();
    await Promise.resolve();
    controller.setState({ globalEnabled: true, siteEnabled: false });
    editor.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    controller.manualCheck(editor);
    expect(
      send.mock.calls.some(
        ([message]) => (message as { type: string }).type === "check",
      ),
    ).toBe(false);
    controller.stop();
  });

  it("honors InputEvent.isComposing even without a compositionstart event", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor"></textarea>';
    const editor = document.querySelector("textarea")!;
    const send = vi.fn().mockResolvedValue({
      state: { globalEnabled: true, siteEnabled: true },
    });
    const controller = new ContentController({
      debounceMs: 10,
      sendMessage: send,
    });
    controller.start();
    controller.setState(true);
    editor.value = "入力中";
    editor.dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing: true }),
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(
      send.mock.calls.some(
        ([message]) => (message as { type: string }).type === "check",
      ),
    ).toBe(false);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
    expect(
      send.mock.calls.filter(
        ([message]) => (message as { type: string }).type === "check",
      ),
    ).toHaveLength(1);
    controller.stop();
    vi.useRealTimers();
  });

  it("cancels a debounce and rechecks composition at timer execution", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor"></textarea>';
    const editor = document.querySelector("textarea")!;
    const send = vi.fn().mockResolvedValue({
      state: { globalEnabled: true, siteEnabled: true },
    });
    const controller = new ContentController({
      debounceMs: 100,
      sendMessage: send,
    });
    controller.start();
    controller.setState(true);
    editor.value = "未確定";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(
      send.mock.calls.some(
        ([message]) => (message as { type: string }).type === "check",
      ),
    ).toBe(false);
    controller.stop();
    vi.useRealTimers();
  });

  it("invalidates a pending result when composition starts with unchanged text", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor">本文</textarea>';
    const editor = document.querySelector("textarea")!;
    let resolveCheck: ((value: unknown) => void) | undefined;
    const send = vi.fn().mockImplementation((message: { type: string }) =>
      message.type === "check"
        ? new Promise((resolve) => {
            resolveCheck = resolve;
          })
        : Promise.resolve({
            state: { globalEnabled: true, siteEnabled: true },
          }),
    );
    const controller = new ContentController({
      debounceMs: 1,
      sendMessage: send,
    });
    controller.start();
    controller.setState(true);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    expect(resolveCheck).toBeDefined();
    editor.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    resolveCheck?.({
      type: "check-result",
      requestId: 1,
      result: {
        detections: [
          { start: 0, end: 2, text: "本文", type: "誤字", confidence: 1 },
        ],
        inferenceMs: 1,
        backend: "wasm",
        modelVersion: "test",
      },
    });
    await Promise.resolve();
    expect(document.querySelector(".kotoba-guard-overlay")).toBeNull();
    controller.stop();
    vi.useRealTimers();
  });

  it("coalesces rapid input to one in-flight request and the latest pending text", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor"></textarea>';
    const editor = document.querySelector("textarea")!;
    const responses: Array<(value: unknown) => void> = [];
    const send = vi.fn().mockImplementation((message: { type: string }) =>
      message.type === "check"
        ? new Promise((resolve) => responses.push(resolve))
        : Promise.resolve({
            state: { globalEnabled: true, siteEnabled: true },
          }),
    );
    const controller = new ContentController({
      debounceMs: 10,
      sendMessage: send,
    });
    controller.start();
    controller.setState(true);
    editor.value = "A";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
    editor.value = "B";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(5);
    editor.value = "C";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
    expect(
      send.mock.calls
        .filter(([message]) => (message as { type: string }).type === "check")
        .map(([message]) => (message as { text: string }).text),
    ).toEqual(["A"]);
    responses[0]?.({
      type: "check-result",
      requestId: 1,
      result: {
        detections: [],
        inferenceMs: 1,
        backend: "wasm",
        modelVersion: "test",
      },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(
      send.mock.calls
        .filter(([message]) => (message as { type: string }).type === "check")
        .map(([message]) => (message as { text: string }).text),
    ).toEqual(["A", "C"]);
    controller.stop();
    vi.useRealTimers();
  });

  it("cleans detached editors, pending requests, and highlights", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor">本文</textarea><div />';
    const editor = document.querySelector("textarea")!;
    let resolveCheck: ((value: unknown) => void) | undefined;
    const send = vi.fn().mockImplementation((message: { type: string }) =>
      message.type === "check"
        ? new Promise((resolve) => {
            resolveCheck = resolve;
          })
        : Promise.resolve({
            state: { globalEnabled: true, siteEnabled: true },
          }),
    );
    const controller = new ContentController({
      debounceMs: 1,
      sendMessage: send,
    });
    controller.start();
    controller.setState(true);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    expect(resolveCheck).toBeDefined();
    editor.remove();
    document.body.append(document.createElement("p"));
    await Promise.resolve();
    await Promise.resolve();
    resolveCheck?.({
      type: "check-result",
      requestId: 1,
      result: {
        detections: [
          { start: 0, end: 2, text: "本文", type: "誤字", confidence: 1 },
        ],
        inferenceMs: 1,
        backend: "wasm",
        modelVersion: "test",
      },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector(".kotoba-guard-overlay")).toBeNull();
    expect(
      send.mock.calls.filter(
        ([message]) => (message as { type: string }).type === "check",
      ),
    ).toHaveLength(1);
    controller.stop();
    vi.useRealTimers();
  });

  it("retries an automatic busy request at most once", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor">本文</textarea>';
    const editor = document.querySelector("textarea")!;
    const checkMessages: Array<{ requestId: number; text: string }> = [];
    const send = vi
      .fn()
      .mockImplementation(
        (message: { type: string; requestId?: number; text?: string }) => {
          if (message.type !== "check") {
            return Promise.resolve({
              state: { globalEnabled: true, siteEnabled: true },
            });
          }
          checkMessages.push({
            requestId: message.requestId ?? -1,
            text: message.text ?? "",
          });
          return Promise.resolve({
            type: "check-error",
            requestId: message.requestId,
            code: "busy",
          });
        },
      );
    const controller = new ContentController({
      debounceMs: 10,
      sendMessage: send,
    });
    controller.start();
    controller.setState(true);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(checkMessages).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(checkMessages).toHaveLength(2);
    controller.stop();
    vi.useRealTimers();
  });

  it("preserves a pending manual check and never retries a sent manual busy", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor">本文</textarea>';
    const editor = document.querySelector("textarea")!;
    const responses: Array<(value: unknown) => void> = [];
    const checkMessages: Array<{ manual?: boolean; text: string }> = [];
    const send = vi
      .fn()
      .mockImplementation(
        (message: { type: string; text?: string; manual?: boolean }) => {
          if (message.type !== "check") {
            return Promise.resolve({
              state: { globalEnabled: true, siteEnabled: true },
            });
          }
          const checkMessage: { manual?: boolean; text: string } = {
            text: message.text ?? "",
          };
          if (message.manual !== undefined)
            checkMessage.manual = message.manual;
          checkMessages.push(checkMessage);
          return new Promise((resolve) => responses.push(resolve));
        },
      );
    const controller = new ContentController({
      debounceMs: 10,
      sendMessage: send,
    });
    controller.start();
    controller.setState(true);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
    controller.manualCheck(editor);
    expect(checkMessages).toEqual([{ text: "本文" }]);
    responses[0]?.({
      type: "check-result",
      requestId: 1,
      result: {
        detections: [],
        inferenceMs: 1,
        backend: "wasm",
        modelVersion: "test",
      },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(checkMessages).toEqual([
      { text: "本文" },
      { manual: true, text: "本文" },
    ]);
    responses[1]?.({
      type: "check-error",
      requestId: 2,
      code: "busy",
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
    expect(checkMessages).toHaveLength(2);
    controller.stop();
    vi.useRealTimers();
  });

  it("keeps a re-enable check queued while a previous request is in flight", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor">本文</textarea>';
    const editor = document.querySelector("textarea")!;
    editor.focus();
    const responses: Array<(value: unknown) => void> = [];
    const checkMessages: Array<{ requestId: number; text: string }> = [];
    const send = vi
      .fn()
      .mockImplementation(
        (message: { type: string; requestId?: number; text?: string }) => {
          if (message.type !== "check") {
            return Promise.resolve({
              state: { globalEnabled: true, siteEnabled: true },
            });
          }
          checkMessages.push({
            requestId: message.requestId ?? -1,
            text: message.text ?? "",
          });
          return new Promise((resolve) => responses.push(resolve));
        },
      );
    const controller = new ContentController({
      debounceMs: 10,
      sendMessage: send,
    });
    controller.start();
    controller.setState(true);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
    expect(checkMessages).toHaveLength(1);
    controller.setState(false);
    controller.setState(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(checkMessages).toHaveLength(1);
    responses[0]?.({
      type: "check-result",
      requestId: 1,
      result: {
        detections: [],
        inferenceMs: 1,
        backend: "wasm",
        modelVersion: "test",
      },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(checkMessages).toHaveLength(2);
    controller.stop();
    vi.useRealTimers();
  });

  it("keeps only the new input after disable and re-enable while an old request is pending", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor">A</textarea>';
    const editor = document.querySelector("textarea")!;
    editor.focus();
    const responses: Array<(value: unknown) => void> = [];
    const checkMessages: Array<{ requestId: number; text: string }> = [];
    const send = vi
      .fn()
      .mockImplementation(
        (message: { type: string; requestId?: number; text?: string }) => {
          if (message.type !== "check") {
            return Promise.resolve({
              state: { globalEnabled: true, siteEnabled: true },
            });
          }
          checkMessages.push({
            requestId: message.requestId ?? -1,
            text: message.text ?? "",
          });
          return new Promise((resolve) => responses.push(resolve));
        },
      );
    const controller = new ContentController({
      debounceMs: 10,
      sendMessage: send,
    });
    controller.start();
    controller.setState(true);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
    expect(checkMessages.map(({ text }) => text)).toEqual(["A"]);
    controller.setState(false);
    controller.setState(true);
    editor.value = "B";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
    expect(checkMessages.map(({ text }) => text)).toEqual(["A"]);
    responses[0]?.({
      type: "check-result",
      requestId: 1,
      result: {
        detections: [
          { start: 0, end: 1, text: "A", type: "old", confidence: 1 },
        ],
        inferenceMs: 1,
        backend: "wasm",
        modelVersion: "test",
      },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(checkMessages.map(({ text }) => text)).toEqual(["A", "B"]);
    expect(document.querySelector(".kotoba-guard-overlay")).toBeNull();
    controller.stop();
    vi.useRealTimers();
  });

  it("sends a pending manual check after site disable without retrying manual busy", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor">本文</textarea>';
    const editor = document.querySelector("textarea")!;
    editor.focus();
    const responses: Array<(value: unknown) => void> = [];
    const checkMessages: Array<{ manual?: boolean; text: string }> = [];
    const send = vi
      .fn()
      .mockImplementation(
        (message: { type: string; text?: string; manual?: boolean }) => {
          if (message.type !== "check") {
            return Promise.resolve({
              state: { globalEnabled: true, siteEnabled: true },
            });
          }
          const checkMessage: { manual?: boolean; text: string } = {
            text: message.text ?? "",
          };
          if (message.manual !== undefined)
            checkMessage.manual = message.manual;
          checkMessages.push(checkMessage);
          return new Promise((resolve) => responses.push(resolve));
        },
      );
    const controller = new ContentController({
      debounceMs: 10,
      sendMessage: send,
    });
    controller.start();
    controller.setState(true);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
    controller.setState({ globalEnabled: true, siteEnabled: false });
    controller.manualCheck(editor);
    responses[0]?.({
      type: "check-result",
      requestId: 1,
      result: {
        detections: [],
        inferenceMs: 1,
        backend: "wasm",
        modelVersion: "test",
      },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(checkMessages).toEqual([
      { text: "本文" },
      { manual: true, text: "本文" },
    ]);
    responses[1]?.({ type: "check-error", requestId: 2, code: "busy" });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
    expect(checkMessages).toHaveLength(2);
    controller.stop();
    vi.useRealTimers();
  });

  it("clears manual marks and pending work when global checking is disabled", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor">A</textarea>';
    const editor = document.querySelector("textarea")!;
    editor.focus();
    const responses: Array<(value: unknown) => void> = [];
    const checkMessages: Array<{ manual?: boolean; text: string }> = [];
    const send = vi
      .fn()
      .mockImplementation(
        (message: { type: string; text?: string; manual?: boolean }) => {
          if (message.type !== "check") {
            return Promise.resolve({
              state: { globalEnabled: true, siteEnabled: true },
            });
          }
          const checkMessage: { manual?: boolean; text: string } = {
            text: message.text ?? "",
          };
          if (message.manual !== undefined)
            checkMessage.manual = message.manual;
          checkMessages.push(checkMessage);
          return new Promise((resolve) => responses.push(resolve));
        },
      );
    const controller = new ContentController({
      debounceMs: 10,
      sendMessage: send,
    });
    controller.start();
    controller.setState(true);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
    responses[0]?.({
      type: "check-result",
      requestId: 1,
      result: {
        detections: [
          { start: 0, end: 1, text: "A", type: "old", confidence: 1 },
        ],
        inferenceMs: 1,
        backend: "wasm",
        modelVersion: "test",
      },
    });
    await Promise.resolve();
    expect(document.querySelector(".kotoba-guard-overlay")).not.toBeNull();

    editor.value = "B";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
    controller.setState({ globalEnabled: true, siteEnabled: false });
    controller.manualCheck(editor);
    controller.setState({ globalEnabled: false, siteEnabled: false });
    expect(document.querySelector(".kotoba-guard-overlay")).toBeNull();

    responses[1]?.({
      type: "check-result",
      requestId: 2,
      result: {
        detections: [
          { start: 0, end: 1, text: "B", type: "stale", confidence: 1 },
        ],
        inferenceMs: 1,
        backend: "wasm",
        modelVersion: "test",
      },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
    expect(checkMessages).toHaveLength(2);
    expect(document.querySelector(".kotoba-guard-overlay")).toBeNull();
    controller.stop();
    vi.useRealTimers();
  });

  it("does not auto-check when global checking is re-enabled while the site is off", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor">本文</textarea>';
    const editor = document.querySelector("textarea")!;
    editor.focus();
    const send = vi.fn().mockResolvedValue({
      state: { globalEnabled: false, siteEnabled: false },
    });
    const controller = new ContentController({
      debounceMs: 10,
      sendMessage: send,
    });
    controller.start();
    controller.setState({ globalEnabled: false, siteEnabled: false });
    controller.setState({ globalEnabled: true, siteEnabled: false });
    await vi.advanceTimersByTimeAsync(50);
    expect(
      send.mock.calls.filter(
        ([message]) => (message as { type: string }).type === "check",
      ),
    ).toHaveLength(0);
    controller.stop();
    vi.useRealTimers();
  });

  it("clears an existing highlight when the editor becomes empty", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor">本文</textarea>';
    const editor = document.querySelector("textarea")!;
    const send = vi.fn().mockImplementation((message: { type: string }) =>
      message.type === "check"
        ? Promise.resolve({
            type: "check-result",
            requestId: 1,
            result: {
              detections: [
                {
                  start: 0,
                  end: 2,
                  text: "本文",
                  type: "誤字",
                  confidence: 0.9,
                },
              ],
              inferenceMs: 1,
              backend: "wasm",
              modelVersion: "test",
            },
          })
        : Promise.resolve({
            state: { globalEnabled: true, siteEnabled: true },
          }),
    );
    const controller = new ContentController({
      debounceMs: 1,
      sendMessage: send,
    });
    controller.start();
    controller.setState(true);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(document.querySelector(".kotoba-guard-overlay")).not.toBeNull();
    editor.value = "";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector(".kotoba-guard-overlay")).toBeNull();
    controller.stop();
    vi.useRealTimers();
  });

  it("stops timers and ignores input after disconnect cleanup", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor"></textarea>';
    const editor = document.querySelector("textarea")!;
    const send = vi.fn().mockResolvedValue({
      state: { globalEnabled: true, siteEnabled: true },
    });
    const controller = new ContentController({
      debounceMs: 10,
      sendMessage: send,
    });
    controller.start();
    controller.setState(true);
    controller.stop();
    editor.value = "入力";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(20);
    expect(
      send.mock.calls.some(
        ([message]) => (message as { type: string }).type === "check",
      ),
    ).toBe(false);
    vi.useRealTimers();
  });

  it("ignores a pending check result after stop", async () => {
    document.body.innerHTML = '<textarea id="editor">本文</textarea>';
    const editor = document.querySelector("textarea")!;
    let resolveCheck: ((value: unknown) => void) | undefined;
    const send = vi.fn().mockImplementation((message: { type: string }) =>
      message.type === "check"
        ? new Promise((resolve) => {
            resolveCheck = resolve;
          })
        : Promise.resolve({
            state: { globalEnabled: true, siteEnabled: true },
          }),
    );
    const controller = new ContentController({ sendMessage: send });
    controller.start();
    controller.setState(true);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 410));
    expect(resolveCheck).toBeDefined();
    controller.stop();
    resolveCheck?.({
      type: "check-result",
      requestId: 1,
      result: {
        detections: [
          { start: 0, end: 2, text: "本文", type: "誤字", confidence: 1 },
        ],
        inferenceMs: 1,
        backend: "wasm",
        modelVersion: "test",
      },
    });
    await Promise.resolve();
    expect(document.querySelector(".kotoba-guard-overlay")).toBeNull();
  });

  it("ignores a delayed content-ready response after stop", async () => {
    document.body.innerHTML = '<textarea id="editor">本文</textarea>';
    const editor = document.querySelector("textarea")!;
    editor.focus();
    let resolveReady: ((value: unknown) => void) | undefined;
    const send = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReady = resolve;
        }),
    );
    const controller = new ContentController({
      debounceMs: 1,
      sendMessage: send,
    });
    controller.start();
    controller.stop();
    resolveReady?.({
      state: { globalEnabled: true, siteEnabled: true },
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      send.mock.calls.some(
        ([message]) => (message as { type: string }).type === "check",
      ),
    ).toBe(false);
  });

  it("keeps ready responses from a previous start separate from a restart", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor">本文</textarea>';
    const editor = document.querySelector("textarea")!;
    editor.focus();
    const readyResponses: Array<(value: unknown) => void> = [];
    const send = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          readyResponses.push(resolve);
        }),
    );
    const controller = new ContentController({
      debounceMs: 1,
      sendMessage: send,
    });
    controller.start();
    controller.stop();
    controller.start();
    expect(readyResponses).toHaveLength(2);
    readyResponses[0]?.({
      state: { globalEnabled: true, siteEnabled: true },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2);
    expect(
      send.mock.calls.filter(
        ([message]) => (message as { type: string }).type === "check",
      ),
    ).toHaveLength(0);
    readyResponses[1]?.({
      state: { globalEnabled: false, siteEnabled: true },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2);
    expect(
      send.mock.calls.filter(
        ([message]) => (message as { type: string }).type === "check",
      ),
    ).toHaveLength(0);
    controller.stop();
    vi.useRealTimers();
  });

  it("clears a manual-only result as soon as the editor is edited", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor">本文</textarea>';
    const editor = document.querySelector("textarea")!;
    const send = vi.fn().mockImplementation((message: { type: string }) =>
      message.type === "check"
        ? Promise.resolve({
            type: "check-result",
            requestId: 1,
            result: {
              detections: [
                { start: 0, end: 2, text: "本文", type: "誤字", confidence: 1 },
              ],
              inferenceMs: 1,
              backend: "wasm",
              modelVersion: "test",
            },
          })
        : Promise.resolve({
            state: { globalEnabled: true, siteEnabled: false },
          }),
    );
    const controller = new ContentController({
      debounceMs: 1,
      sendMessage: send,
    });
    controller.start();
    await Promise.resolve();
    controller.setState({ globalEnabled: true, siteEnabled: false });
    controller.manualCheck(editor);
    await Promise.resolve();
    expect(document.querySelector(".kotoba-guard-summary")).not.toBeNull();
    editor.value = "本文を変更";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector(".kotoba-guard-summary")).toBeNull();
    expect(
      send.mock.calls.filter(
        ([message]) => (message as { type: string }).type === "check",
      ),
    ).toHaveLength(1);
    controller.stop();
    vi.useRealTimers();
  });

  it("rechecks a focused editor after global re-enable", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="editor"></textarea>';
    const editor = document.querySelector("textarea")!;
    const send = vi.fn().mockImplementation((message: { type: string }) =>
      message.type === "check"
        ? Promise.resolve({
            type: "check-result",
            requestId: 1,
            result: {
              detections: [
                { start: 0, end: 2, text: "本文", type: "誤字", confidence: 1 },
              ],
              inferenceMs: 1,
              backend: "wasm",
              modelVersion: "test",
            },
          })
        : Promise.resolve({
            state: { globalEnabled: true, siteEnabled: true },
          }),
    );
    const controller = new ContentController({
      debounceMs: 100,
      sendMessage: send,
    });
    controller.start();
    await Promise.resolve();
    controller.setState(false);
    editor.focus();
    editor.value = "本文";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
    expect(
      send.mock.calls.filter(
        ([message]) => (message as { type: string }).type === "check",
      ),
    ).toHaveLength(0);

    controller.setState(true);
    await vi.advanceTimersByTimeAsync(99);
    expect(
      send.mock.calls.filter(
        ([message]) => (message as { type: string }).type === "check",
      ),
    ).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      send.mock.calls.filter(
        ([message]) => (message as { type: string }).type === "check",
      ),
    ).toHaveLength(1);
    await Promise.resolve();
    expect(document.querySelector(".kotoba-guard-overlay")).not.toBeNull();
    controller.stop();
    vi.useRealTimers();
  });
});
