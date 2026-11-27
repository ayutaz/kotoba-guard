import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { createChromiumLaunchOptions } from "../e2e/browser-options";

const extensionDir = path.resolve(".cache/test-extension");
const originalExecutable = process.env.KOTOBA_GUARD_BROWSER_EXECUTABLE;

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalExecutable === undefined)
    delete process.env.KOTOBA_GUARD_BROWSER_EXECUTABLE;
  else process.env.KOTOBA_GUARD_BROWSER_EXECUTABLE = originalExecutable;
});

describe("createChromiumLaunchOptions", () => {
  it("uses the installed Playwright Chromium channel by default", () => {
    delete process.env.KOTOBA_GUARD_BROWSER_EXECUTABLE;
    expect(createChromiumLaunchOptions(extensionDir)).toEqual({
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
      ],
    });
  });

  it("uses an explicitly selected absolute executable with new headless mode", () => {
    const executablePath = path.resolve(".cache/chrome/chrome");
    vi.stubEnv("KOTOBA_GUARD_BROWSER_EXECUTABLE", executablePath);
    expect(createChromiumLaunchOptions(extensionDir)).toEqual({
      executablePath,
      headless: true,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        "--headless=new",
      ],
    });
  });

  it.each(["", "   ", "relative/chrome"])(
    "rejects an invalid executable path: %j",
    (executablePath) => {
      vi.stubEnv("KOTOBA_GUARD_BROWSER_EXECUTABLE", executablePath);
      expect(() => createChromiumLaunchOptions(extensionDir)).toThrow(
        /absolute non-empty/i,
      );
    },
  );
});
