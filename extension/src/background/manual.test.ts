import { describe, expect, it } from "vitest";
import { dispatchManualCheck } from "./manual";

describe("manual check dispatch", () => {
  it("sends current state before manual-check after an asynchronous handshake", async () => {
    const messages: unknown[] = [];
    let contentReady = false;
    const state = {
      origin: "https://example.test",
      globalEnabled: true,
      siteEnabled: false,
    } as const;
    await dispatchManualCheck(
      async () => {
        await Promise.resolve();
        contentReady = true;
        return state;
      },
      state.origin,
      async (message) => {
        messages.push(message);
      },
    );
    expect(contentReady).toBe(true);
    expect(messages).toEqual([
      { type: "set-state", state },
      { type: "manual-check" },
    ]);
  });

  it("rejects navigation before dispatching a manual request", async () => {
    const send = async (): Promise<void> => undefined;
    await expect(
      dispatchManualCheck(
        async () => ({
          origin: "https://other.test",
          globalEnabled: true,
          siteEnabled: false,
        }),
        "https://example.test",
        send,
      ),
    ).rejects.toThrow("tab-navigated");
  });
});
