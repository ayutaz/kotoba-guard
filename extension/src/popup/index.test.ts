import { afterEach, describe, expect, it, vi } from "vitest";

function setupChrome(siteResponse: unknown, permission = true) {
  const sendMessage = vi
    .fn()
    .mockImplementation((message: { type: string }) => {
      if (message.type === "get-status")
        return Promise.resolve({
          origin: "https://example.test",
          globalEnabled: true,
          siteEnabled: false,
          modelReady: false,
          modelVersion: "abcdef1234567890",
          backend: "unknown",
          detectionCount: 3,
        });
      if (message.type === "set-site-enabled")
        return Promise.resolve(siteResponse);
      return Promise.resolve({ ok: true });
    });
  vi.stubGlobal("chrome", {
    runtime: { sendMessage },
    tabs: {
      query: vi
        .fn()
        .mockResolvedValue([{ id: 1, url: "https://example.test/" }]),
    },
    permissions: { request: vi.fn().mockResolvedValue(permission) },
    storage: {
      local: {
        get: vi
          .fn()
          .mockResolvedValue({ globalEnabled: true, enabledSites: [] }),
      },
    },
  });
  return { sendMessage };
}

async function loadPopup(): Promise<HTMLButtonElement> {
  document.body.innerHTML =
    '<button id="site-toggle"></button><button id="manual-check"></button><input id="global-toggle" type="checkbox"><p id="site-name"></p><p id="status"></p><p id="model-state"></p><p id="model-name"></p><p id="detection-count"></p><p id="backend-state"></p>';
  await import("./index");
  await vi.waitFor(() =>
    expect(
      document.querySelector<HTMLButtonElement>("#site-toggle")?.disabled,
    ).toBe(false),
  );
  return document.querySelector<HTMLButtonElement>("#site-toggle")!;
}

describe("popup setting transactions", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("restores the site button after a denied host permission", async () => {
    setupChrome({ ok: true }, false);
    const button = await loadPopup();
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(button.textContent).toContain("有効にする");
    expect(document.querySelector("#status")?.textContent).toContain("許可");
    expect(document.querySelector("#model-name")?.textContent).toContain("30M");
    expect(document.querySelector("#detection-count")?.textContent).toContain(
      "3件",
    );
  });

  it("does not flip local state when the background rejects a site change", async () => {
    const { sendMessage } = setupChrome({ ok: false, code: "state-failed" });
    const button = await loadPopup();
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(button.textContent).toContain("有効にする");
    expect(
      sendMessage.mock.calls.some(
        ([message]) =>
          (message as { type: string }).type === "set-site-enabled",
      ),
    ).toBe(true);
  });
});
