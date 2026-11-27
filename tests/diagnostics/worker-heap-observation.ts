import type { CDPSession } from "@playwright/test";
import { ParentWorkerSession } from "./parent-worker-session";
import { WorkerHeapSession } from "./worker-heap-session";
import { cleanupFixtureResources } from "../e2e/fixture-resources";

type Root = Pick<CDPSession, "send" | "on" | "off">;
type Parent = Pick<
  ParentWorkerSession,
  | "observeWorker"
  | "transport"
  | "metadata"
  | "waitForChildrenDetached"
  | "detachChildren"
  | "close"
>;
type Child = Pick<WorkerHeapSession, "read" | "close">;
type Dependencies = {
  attachParent: (root: Root, id: string) => Promise<Parent>;
  adoptWorker: (root: Root, id: string) => Child;
  checkBudget?: () => void;
};
export async function observeWorkerMemory(
  root: Root,
  extensionId: string,
  dependencies: Dependencies = {
    attachParent: ParentWorkerSession.attach,
    adoptWorker: WorkerHeapSession.adopt,
  },
) {
  let parent: Parent | undefined, child: Child | undefined;
  let heap: Awaited<ReturnType<Child["read"]>> | null = null;
  let bindingBefore: ReturnType<Parent["metadata"]> | null = null;
  let failed = false,
    stage = "parent-attach";
  const check = dependencies.checkBudget ?? (() => undefined);
  const cleanupPhases: Array<{
    resource: string;
    status: string;
    elapsedMs: number | null;
  }> = [];
  try {
    check();
    parent = await dependencies.attachParent(root, extensionId);
    check();
    stage = "worker-notification";
    const selected = await parent.observeWorker();
    check();
    child = dependencies.adoptWorker(parent.transport, selected.sessionId);
    bindingBefore = parent.metadata();
    stage = "read-memory";
    heap = await child.read();
    check();
    stage = "validate-memory";
    if (
      heap.wasm.liveCount < 1 ||
      heap.wasm.totalBytes <= 0 ||
      heap.wasm.byteLengths.some((size) => size <= 0) ||
      !bindingBefore.bindingValid ||
      bindingBefore.activeChildren !== 1 ||
      bindingBefore.workerSessionId !== selected.sessionId ||
      bindingBefore.workerTargetId !== selected.targetId ||
      bindingBefore.explicitParentId !== bindingBefore.parentTargetId ||
      selected.explicitParentId !== bindingBefore.parentTargetId
    )
      throw new Error("invalid-model-worker-memory");
    stage = "completed";
  } catch {
    failed = true;
  }
  const cleanup = async (resource: string, action: () => Promise<void>) => {
    const row = {
      resource,
      status: "pending",
      elapsedMs: null as number | null,
    };
    cleanupPhases.push(row);
    const started = performance.now();
    try {
      await cleanupFixtureResources(undefined, async () => undefined, 5000, {
        detach: async () => {
          try {
            await action();
            row.status = "completed";
          } catch {
            row.status = "failed";
            throw new Error("worker-observation-cleanup-failed");
          } finally {
            row.elapsedMs = performance.now() - started;
          }
        },
      });
    } catch {
      failed = true;
    }
  };
  const ownedParent = parent,
    ownedChild = child;
  if (ownedChild && ownedParent)
    await cleanup("worker-session", async () => {
      await Promise.all([
        ownedParent.waitForChildrenDetached(),
        ownedChild.close(),
      ]);
      const state = ownedParent.metadata();
      if (state.activeChildren !== 0 || !state.childDetachObserved)
        throw new Error("worker-detach-unobserved");
    });
  if (ownedParent && ownedParent.metadata().activeChildren > 0)
    await cleanup("residual-child-sessions", () =>
      ownedParent.detachChildren(),
    );
  if (ownedParent) await cleanup("parent-session", () => ownedParent.close());
  const bindingAfter = parent?.metadata() ?? null;
  if (
    bindingBefore &&
    bindingAfter &&
    (!bindingAfter.bindingValid ||
      bindingAfter.explicitParentId !== bindingAfter.parentTargetId ||
      [
        "parentTargetId",
        "parentSessionId",
        "workerTargetId",
        "workerSessionId",
      ].some(
        (key) =>
          bindingBefore[key as keyof typeof bindingBefore] !==
          bindingAfter[key as keyof typeof bindingAfter],
      ))
  )
    failed = true;
  if (
    cleanupPhases.some(
      (row) =>
        row.status !== "completed" ||
        row.elapsedMs === null ||
        row.elapsedMs >= 5000,
    )
  )
    failed = true;
  return {
    status: failed ? "failed" : "completed",
    stage,
    heap,
    bindingBefore,
    bindingAfter,
    cleanupPhases,
  };
}
