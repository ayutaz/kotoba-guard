import { afterEach, describe, expect, it, vi } from "vitest";
import { readSettings, writeSettings } from "./storage";

describe("extension settings storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("filters malformed and non-origin persisted values", async () => {
    const get = vi.fn().mockResolvedValue({
      globalEnabled: "yes",
      enabledSites: [
        "https://example.test",
        "https://example.test",
        "javascript:alert(1)",
        "https://user:pass@example.test",
        42,
      ],
      inputText: "機密情報",
    });
    vi.stubGlobal("chrome", { storage: { local: { get } } });

    await expect(readSettings()).resolves.toEqual({
      globalEnabled: true,
      enabledSites: ["https://example.test"],
    });
    expect(get).toHaveBeenCalledWith(["globalEnabled", "enabledSites"]);
  });

  it("writes only the supported settings keys and normalized origins", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", { storage: { local: { set } } });

    await writeSettings({
      globalEnabled: false,
      enabledSites: [
        "https://example.test",
        "https://example.test",
        "data:text/plain,x",
      ],
    });
    expect(set).toHaveBeenCalledWith({
      globalEnabled: false,
      enabledSites: ["https://example.test"],
    });
  });
});
