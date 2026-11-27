import { startContentController, getContentController } from "./controller";
import type { RuntimeState } from "../shared/types";
import { isTrustedExtensionSender } from "../shared/security";

const contentGlobal = globalThis as typeof globalThis & {
  __kotobaGuardContentEntry?: boolean;
};

if (!contentGlobal.__kotobaGuardContentEntry) {
  contentGlobal.__kotobaGuardContentEntry = true;
  const controller = startContentController();

  chrome.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse) => {
      if (!isTrustedExtensionSender(sender, chrome.runtime.id)) return false;
      if (!message || typeof message !== "object") return false;
      const value = message as {
        type?: unknown;
        state?: unknown;
        enabled?: unknown;
      };
      if (
        value.type === "set-state" &&
        typeof value.state === "object" &&
        value.state !== null
      ) {
        controller.setState(value.state as RuntimeState);
        sendResponse({ ok: true });
        return false;
      }
      if (value.type === "set-state" && typeof value.enabled === "boolean") {
        controller.setState(value.enabled);
        sendResponse({ ok: true });
        return false;
      }
      if (value.type === "manual-check") {
        getContentController()?.manualCheck();
        sendResponse({ ok: true });
        return false;
      }
      return false;
    },
  );
}
