import type { CDPSession } from "@playwright/test";

/** Only for the fresh, model-free calibration browser: no related attachment.
 * Chromium may omit a dedicated worker URL from the browser-level inventory.
 * Require exactly one worker and the expected offscreen parent; the subsequent
 * numeric snapshot call must prove that the probe exists in that worker.
 */
export async function findCalibrationWorker(
  cdp: Pick<CDPSession, "send">,
  extensionId: string,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const { targetInfos } = await Promise.race([
    cdp.send("Target.getTargets", { filter: [{}] }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("heap-inventory-timeout")),
        5000,
      );
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  const parents = targetInfos.filter(
    (target) =>
      target.url === `chrome-extension://${extensionId}/offscreen.html`,
  );
  const workers = targetInfos.filter((target) => target.type === "worker");
  if (parents.length !== 1 || workers.length !== 1) return undefined;
  const worker = workers[0]!;
  if (
    worker.url !== "" &&
    worker.url !== `chrome-extension://${extensionId}/worker.js`
  )
    return undefined;
  return worker.targetId;
}
