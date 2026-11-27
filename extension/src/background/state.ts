import {
  isOrigin,
  originPattern,
  readSettings,
  writeSettings,
  type StoredSettings,
} from "../shared/storage";
import type { RuntimeState } from "../shared/types";

export const CONTENT_SCRIPT_ID = "kotoba-guard-content";

export function originFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export class ExtensionState {
  private current: StoredSettings = { globalEnabled: true, enabledSites: [] };

  async load(): Promise<StoredSettings> {
    this.current = await readSettings();
    return this.current;
  }

  get settings(): StoredSettings {
    return this.current;
  }

  async setGlobalEnabled(enabled: boolean): Promise<StoredSettings> {
    this.current = { ...this.current, globalEnabled: enabled };
    await writeSettings(this.current);
    return this.current;
  }

  async setSiteEnabled(
    origin: string,
    enabled: boolean,
  ): Promise<StoredSettings> {
    if (!isOrigin(origin)) throw new Error("invalid-origin");
    const next = new Set(this.current.enabledSites);
    if (enabled) next.add(origin);
    else next.delete(origin);
    this.current = { ...this.current, enabledSites: [...next] };
    await writeSettings(this.current);
    return this.current;
  }

  forUrl(url: string | undefined): RuntimeState | undefined {
    const origin = originFromUrl(url);
    if (!origin) return undefined;
    return {
      globalEnabled: this.current.globalEnabled,
      siteEnabled: this.current.enabledSites.includes(origin),
      origin,
    };
  }

  patterns(): string[] {
    return this.current.globalEnabled
      ? this.current.enabledSites.map(originPattern)
      : [];
  }
}
