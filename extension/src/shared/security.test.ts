import { describe, expect, it } from "vitest";
import { BoundedQueue } from "../background/queue";
import {
  canAcceptCheck,
  isPrivilegedPopupSender,
  isTrustedExtensionSender,
  isValidBackgroundMessage,
  shouldDropQueuedCheck,
} from "./security";

const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
const popupSender = {
  id: runtimeId,
  url: `chrome-extension://${runtimeId}/popup.html`,
};
const state = {
  globalEnabled: true,
  siteEnabled: false,
  origin: "https://example.test",
};

describe("extension message security", () => {
  it("requires an exact extension sender and popup/options URL for privileged commands", () => {
    expect(isTrustedExtensionSender({ id: runtimeId }, runtimeId)).toBe(true);
    expect(isTrustedExtensionSender({}, runtimeId)).toBe(false);
    expect(isPrivilegedPopupSender(popupSender, runtimeId)).toBe(true);
    expect(
      isPrivilegedPopupSender(
        { ...popupSender, url: "https://example.test/popup.html" },
        runtimeId,
      ),
    ).toBe(false);
    expect(isPrivilegedPopupSender({ id: runtimeId }, runtimeId)).toBe(false);
  });

  it("rejects malformed commands and oversized input before dispatch", () => {
    expect(
      isValidBackgroundMessage({ type: "set-global-enabled", enabled: "yes" }),
    ).toBe(false);
    expect(
      isValidBackgroundMessage({
        type: "set-site-enabled",
        origin: "javascript:alert(1)",
        enabled: true,
      }),
    ).toBe(false);
    expect(
      isValidBackgroundMessage({ type: "check", requestId: 1, text: "x" }),
    ).toBe(true);
    expect(
      isValidBackgroundMessage({
        type: "check",
        requestId: 1,
        text: "x",
        manual: "yes",
      }),
    ).toBe(false);
    expect(
      isValidBackgroundMessage({
        type: "check",
        requestId: 1,
        text: "x".repeat(1_000_001),
      }),
    ).toBe(false);
  });

  it("requires a one-shot manual grant on an unregistered site", () => {
    const request = {
      type: "check",
      requestId: 1,
      text: "本文",
      manual: true,
    } as const;
    expect(canAcceptCheck(state, request, false)).toBe(false);
    expect(canAcceptCheck(state, request, true)).toBe(true);
    expect(
      canAcceptCheck({ ...state, globalEnabled: false }, request, true),
    ).toBe(false);
  });

  it("drops queued work after disable or navigation", () => {
    const entry = {
      origin: "https://example.test",
      siteWasEnabled: true,
      manual: false,
    };
    expect(shouldDropQueuedCheck({ ...state, siteEnabled: false }, entry)).toBe(
      true,
    );
    expect(
      shouldDropQueuedCheck({ ...state, origin: "https://other.test" }, entry),
    ).toBe(true);
    expect(shouldDropQueuedCheck({ ...state, siteEnabled: true }, entry)).toBe(
      false,
    );
    expect(
      shouldDropQueuedCheck(
        { ...state, siteEnabled: true },
        { ...entry, generation: 1 },
        2,
      ),
    ).toBe(true);
  });

  it("bounds pending work", () => {
    const queue = new BoundedQueue<number>(2);
    expect(queue.enqueue(1)).toBe(true);
    expect(queue.enqueue(2)).toBe(true);
    expect(queue.enqueue(3)).toBe(false);
    expect(queue.shift()).toBe(1);
    expect(queue.enqueue(3)).toBe(true);
  });
});
