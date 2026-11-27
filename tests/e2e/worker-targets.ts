import type { CDPSession } from "@playwright/test";

export type WorkerObservation = {
  readonly stage: "inventory" | "attaching-related";
  readonly totalTargets: number;
  readonly ownedOffscreenTargets: number;
  readonly ownedWorkerTargets: number;
  readonly workersWithoutUrl: number;
  readonly attachmentAttempts: number;
  readonly attachedParents: number;
};

/** Observe offscreen children through their parent before matching worker URLs.
 * A browser-level inventory alone can omit a child worker's final URL.
 * Attachment does not pause execution or alter the production Worker.
 */
export function createModelWorkerObserver(
  cdp: Pick<CDPSession, "send">,
  extensionId: string,
  onObservation?: (observation: WorkerObservation) => void,
): () => Promise<string[]> {
  const attachedParents = new Set<string>();
  let attachmentAttempts = 0;
  const offscreenUrl = `chrome-extension://${extensionId}/offscreen.html`;
  const workerUrl = `chrome-extension://${extensionId}/worker.js`;
  return async () => {
    let { targetInfos } = await cdp.send("Target.getTargets", { filter: [{}] });
    const record = (stage: WorkerObservation["stage"]) => {
      onObservation?.({
        stage,
        totalTargets: targetInfos.length,
        ownedOffscreenTargets: targetInfos.filter(
          (target) => target.url === offscreenUrl,
        ).length,
        ownedWorkerTargets: targetInfos.filter(
          (target) => target.type === "worker" && target.url === workerUrl,
        ).length,
        workersWithoutUrl: targetInfos.filter(
          (target) => target.type === "worker" && target.url === "",
        ).length,
        attachmentAttempts,
        attachedParents: attachedParents.size,
      });
    };
    record("inventory");
    let attached = false;
    for (const target of targetInfos) {
      if (
        target.url !== offscreenUrl ||
        !["background_page", "other", "page"].includes(target.type) ||
        attachedParents.has(target.targetId)
      )
        continue;
      attachmentAttempts += 1;
      record("attaching-related");
      await cdp.send("Target.autoAttachRelated", {
        targetId: target.targetId,
        waitForDebuggerOnStart: false,
        filter: [{}],
      });
      attachedParents.add(target.targetId);
      attached = true;
    }
    if (attached) {
      ({ targetInfos } = await cdp.send("Target.getTargets", { filter: [{}] }));
      record("inventory");
    }
    return targetInfos
      .filter((target) => target.type === "worker" && target.url === workerUrl)
      .map((target) => target.targetId)
      .sort();
  };
}
