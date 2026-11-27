import type { RuntimeState } from "../shared/types";

/**
 * Deliver the authoritative state before the one-shot request. Injection can
 * return before content-ready has completed, so manual-check must not depend on
 * the content script's initial state response.
 */
export async function dispatchManualCheck(
  getState: () => Promise<RuntimeState | undefined>,
  expectedOrigin: string,
  sendMessage: (message: unknown) => Promise<unknown>,
): Promise<void> {
  const state = await getState();
  if (!state || state.origin !== expectedOrigin)
    throw new Error("tab-navigated");
  await sendMessage({ type: "set-state", state });
  await sendMessage({ type: "manual-check" });
}
