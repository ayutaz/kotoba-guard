import path from "node:path";

export function createChromiumLaunchOptions(extensionDir: string):
  | {
      readonly channel: "chromium";
      readonly headless: true;
      readonly args: string[];
    }
  | {
      readonly executablePath: string;
      readonly headless: true;
      readonly args: string[];
    } {
  const extensionArgs = [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ];
  const configuredExecutable = process.env.KOTOBA_GUARD_BROWSER_EXECUTABLE;
  if (configuredExecutable === undefined) {
    return {
      channel: "chromium",
      headless: true,
      args: extensionArgs,
    };
  }
  if (
    configuredExecutable.length === 0 ||
    !path.isAbsolute(configuredExecutable)
  )
    throw new Error(
      "KOTOBA_GUARD_BROWSER_EXECUTABLE must be an absolute non-empty path",
    );
  return {
    executablePath: configuredExecutable,
    headless: true,
    args: [...extensionArgs, "--headless=new"],
  };
}
