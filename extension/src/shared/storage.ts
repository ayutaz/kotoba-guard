export const STORAGE_KEYS = {
  globalEnabled: "globalEnabled",
  enabledSites: "enabledSites",
} as const;

export type StoredSettings = {
  readonly globalEnabled: boolean;
  readonly enabledSites: readonly string[];
};

const DEFAULTS: StoredSettings = { globalEnabled: true, enabledSites: [] };

export async function readSettings(): Promise<StoredSettings> {
  const values = await chrome.storage.local.get([
    STORAGE_KEYS.globalEnabled,
    STORAGE_KEYS.enabledSites,
  ]);
  const globalValue: unknown = values[STORAGE_KEYS.globalEnabled];
  const globalEnabled =
    typeof globalValue === "boolean" ? globalValue : DEFAULTS.globalEnabled;
  const rawSites: unknown = values[STORAGE_KEYS.enabledSites];
  const enabledSites = Array.isArray(rawSites)
    ? rawSites.filter(
        (site): site is string => typeof site === "string" && isOrigin(site),
      )
    : DEFAULTS.enabledSites;
  return { globalEnabled, enabledSites: [...new Set(enabledSites)] };
}

export async function writeSettings(settings: StoredSettings): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.globalEnabled]: settings.globalEnabled,
    [STORAGE_KEYS.enabledSites]: [
      ...new Set(settings.enabledSites.filter(isOrigin)),
    ],
  });
}

export function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      (url.pathname === "" || url.pathname === "/")
    );
  } catch {
    return false;
  }
}

export function originPattern(origin: string): string {
  return `${origin}/*`;
}
