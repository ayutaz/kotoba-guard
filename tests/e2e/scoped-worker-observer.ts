import type { CDPSession } from "@playwright/test";
import { ScopedWorkerLedger } from "./scoped-worker-ledger";

type Root = Pick<CDPSession, "send" | "on" | "off">;
type Parent = {
  targetId: string;
  sessionId: string;
  token: number;
  acknowledged: boolean;
  lost: boolean;
};
type Pending = {
  id: number;
  sessionId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const unavailable = () => new Error("Scoped Worker observation unavailable");
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

/** Diagnostic observer: child notifications are routed through their owning parent session. */
export class ScopedWorkerObserver {
  private readonly ledger: ScopedWorkerLedger;
  private parent: Parent | undefined;
  private attachingParentId: string | undefined;
  private token = 0;
  private nextId = 0;
  private pending: Pending | undefined;
  private observation: Promise<string[]> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private disconnected = false;
  private failed = false;
  private absenceConfirmed = false;
  private readonly raw = new Set<Promise<unknown>>();
  private readonly sessions = new Map<string, string>();
  private readonly retiredParents = new Set<string>();
  private readonly offscreenUrl: string;

  constructor(
    private readonly root: Root,
    extensionId: string,
  ) {
    if (!/^[a-p]{32}$/.test(extensionId)) throw unavailable();
    this.offscreenUrl = `chrome-extension://${extensionId}/offscreen.html`;
    this.ledger = new ScopedWorkerLedger(
      `chrome-extension://${extensionId}/worker.js`,
    );
    root.on("Target.receivedMessageFromTarget", this.receive);
    root.on("Target.targetDestroyed", this.destroyed);
    root.on("Target.targetInfoChanged", this.changed);
    root.on("Target.targetCreated", this.created);
    root.on("Target.detachedFromTarget", this.detached);
    root.on("close", this.disconnectedEvent);
  }

  private cancelPending(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(unavailable());
    }
  }
  private fail(): void {
    this.failed = true;
    this.absenceConfirmed = false;
    this.token += 1;
    this.cancelPending();
    this.ledger.invalidate();
  }
  private check(token?: number): void {
    if (
      this.closed ||
      this.failed ||
      this.disconnected ||
      (token !== undefined && token !== this.token)
    )
      throw unavailable();
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => this.raw.delete(tracked));
    this.raw.add(tracked);
    return tracked;
  }
  private async command<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.fail();
            reject(unavailable());
          }, 5000);
        }),
      ]);
    } catch {
      this.fail();
      throw unavailable();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  private invalidateParent(gone: boolean): void {
    this.absenceConfirmed = false;
    const parent = this.parent;
    this.token += 1;
    this.cancelPending();
    if (parent) {
      if (gone) {
        this.retiredParents.add(parent.targetId);
        this.sessions.delete(parent.sessionId);
        this.parent = undefined;
        this.ledger.targetDestroyed(parent.targetId);
        this.ledger.invalidate();
      } else {
        parent.lost = true;
        this.ledger.parentDetached(parent.sessionId);
      }
    }
  }
  private readonly destroyed = (event: { targetId: string }): void => {
    if (this.closed) return;
    this.ledger.targetDestroyed(event.targetId);
    if (this.attachingParentId === event.targetId) {
      this.retiredParents.add(event.targetId);
      this.token += 1;
    }
    if (this.parent?.targetId === event.targetId) this.invalidateParent(true);
  };
  private readonly changed = (event: {
    targetInfo: { targetId: string; type: string; url: string };
  }): void => {
    if (this.closed || event.targetInfo.targetId !== this.parent?.targetId)
      return;
    if (
      event.targetInfo.url !== this.offscreenUrl ||
      !["page", "other", "background_page"].includes(event.targetInfo.type)
    )
      this.invalidateParent(false);
  };
  private readonly created = (event: {
    targetInfo: { targetId: string; type: string; url: string };
  }): void => {
    if (
      !this.closed &&
      event.targetInfo.url === this.offscreenUrl &&
      ["page", "other", "background_page"].includes(event.targetInfo.type)
    ) {
      this.absenceConfirmed = false;
      if (this.parent && event.targetInfo.targetId !== this.parent.targetId)
        this.invalidateParent(false);
      else if (
        !this.parent &&
        event.targetInfo.targetId !== this.attachingParentId
      )
        this.token += 1;
    }
  };
  private readonly detached = (event: { sessionId: string }): void => {
    if (this.closed) return;
    this.sessions.delete(event.sessionId);
    if (this.parent?.sessionId === event.sessionId)
      this.invalidateParent(false);
  };
  private readonly disconnectedEvent = (): void => {
    this.disconnected = true;
    this.sessions.clear();
    this.fail();
  };
  private readonly receive = (event: {
    sessionId: string;
    message: string;
  }): void => {
    const parent = this.parent;
    if (
      this.closed ||
      this.failed ||
      !parent ||
      parent.lost ||
      event.sessionId !== parent.sessionId
    )
      return;
    if (typeof event.message !== "string" || event.message.length > 8192) {
      this.fail();
      return;
    }
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(event.message);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw unavailable();
      message = parsed as Record<string, unknown>;
    } catch {
      this.fail();
      return;
    }
    if (typeof message.id === "number") {
      const entry = this.pending;
      if (
        !entry ||
        entry.id !== message.id ||
        entry.sessionId !== event.sessionId
      )
        return;
      this.pending = undefined;
      clearTimeout(entry.timer);
      if (
        Object.hasOwn(message, "error") ||
        !Object.hasOwn(message, "result")
      ) {
        this.fail();
        entry.reject(unavailable());
      } else entry.resolve();
      return;
    }
    this.ledger.ingest(event.sessionId, message);
  };

  private async enableChildren(parent: Parent): Promise<void> {
    const id = this.nextId++;
    const response = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail();
        reject(unavailable());
      }, 5000);
      this.pending = {
        id,
        sessionId: parent.sessionId,
        resolve,
        reject,
        timer,
      };
    });
    const sent = this.command(
      this.track(
        this.root.send("Target.sendMessageToTarget", {
          sessionId: parent.sessionId,
          message: JSON.stringify({
            id,
            method: "Target.setAutoAttach",
            params: {
              autoAttach: true,
              waitForDebuggerOnStart: false,
              flatten: false,
              filter: [{ type: "worker" }, { exclude: true }],
            },
          }),
        }),
      ),
    );
    try {
      await Promise.all([sent, response]);
    } catch {
      this.fail();
      throw unavailable();
    }
  }
  private async inventory() {
    return (
      await this.command(
        this.track(this.root.send("Target.getTargets", { filter: [{}] })),
      )
    ).targetInfos;
  }
  private async run(): Promise<string[]> {
    this.check();
    const token = this.token;
    let targets = await this.inventory();
    this.check(token);
    const parents = targets.filter(
      (t) =>
        t.url === this.offscreenUrl &&
        ["page", "other", "background_page"].includes(t.type),
    );
    if (parents.length > 1) throw unavailable();
    if (
      this.parent &&
      !targets.some((t) => t.targetId === this.parent!.targetId)
    )
      this.invalidateParent(true);
    if (parents.length === 0) {
      if (this.parent) throw unavailable();
      this.ledger.invalidate();
      this.absenceConfirmed = true;
      return [];
    }
    this.absenceConfirmed = false;
    const selected = parents[0]!;
    if (this.retiredParents.has(selected.targetId)) throw unavailable();
    if (this.parent?.lost) throw unavailable();
    if (this.parent && this.parent.targetId !== selected.targetId)
      throw unavailable();
    if (!this.parent) {
      const generation = ++this.token;
      this.attachingParentId = selected.targetId;
      const raw = this.track(
        this.root
          .send("Target.attachToTarget", {
            targetId: selected.targetId,
            flatten: false,
          })
          .then((attached) => {
            if (!identifier(attached.sessionId)) throw unavailable();
            this.sessions.set(attached.sessionId, selected.targetId);
            return attached;
          }),
      );
      const attached = await this.command(raw);
      this.attachingParentId = undefined;
      this.check(generation);
      const parent: Parent = {
        targetId: selected.targetId,
        sessionId: attached.sessionId,
        token: generation,
        acknowledged: false,
        lost: false,
      };
      this.parent = parent;
      this.ledger.open(parent.targetId, parent.sessionId);
      await this.enableChildren(parent);
      this.check(generation);
      targets = await this.inventory();
      this.check(generation);
      const stillOwned = targets.filter(
        (t) =>
          t.url === this.offscreenUrl &&
          ["page", "other", "background_page"].includes(t.type),
      );
      if (
        stillOwned.length !== 1 ||
        stillOwned[0]!.targetId !== parent.targetId
      ) {
        this.invalidateParent(
          !targets.some((t) => t.targetId === parent.targetId),
        );
        throw unavailable();
      }
      parent.acknowledged = true;
    }
    if (!this.parent?.acknowledged) throw unavailable();
    const snapshot = this.ledger.snapshot();
    if (snapshot.status !== "complete") throw unavailable();
    return [...snapshot.workerTargetIds];
  }
  observe(): Promise<string[]> {
    if (this.closed || this.disconnected || this.failed)
      return Promise.reject(unavailable());
    if (this.observation) return this.observation;
    const operation = Promise.resolve().then(() => this.run());
    this.observation = operation;
    const finish = () => {
      if (this.observation === operation) this.observation = undefined;
    };
    void operation.then(finish, finish);
    return operation;
  }
  metadata() {
    const snapshot = this.ledger.snapshot();
    const status = this.closed
      ? "closed"
      : this.failed ||
          this.disconnected ||
          this.parent?.lost ||
          (this.parent && !this.parent.acknowledged)
        ? "unavailable"
        : !this.parent && this.absenceConfirmed
          ? "complete"
          : snapshot.status;
    return {
      status,
      parentBound:
        status === "complete" &&
        !!this.parent?.acknowledged &&
        !this.parent.lost,
      workers: status === "complete" ? snapshot.workerTargetIds.length : 0,
      pendingCommands: this.raw.size + (this.pending ? 1 : 0),
      ownedParentSessions: this.sessions.size,
      disposed: this.closed,
    };
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.token += 1;
    this.cancelPending();
    this.ledger.dispose();
    this.root.off("Target.receivedMessageFromTarget", this.receive);
    this.root.off("Target.targetDestroyed", this.destroyed);
    this.root.off("Target.targetInfoChanged", this.changed);
    this.root.off("Target.targetCreated", this.created);
    this.root.off("Target.detachedFromTarget", this.detached);
    this.root.off("close", this.disconnectedEvent);
    this.closing = this.closeResources();
    return this.closing;
  }
  private async closeResources(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempted = new Set<string>();
    const detachKnown = async () => {
      const sessions = [...this.sessions.keys()].filter(
        (id) => !attempted.has(id),
      );
      const results = await Promise.allSettled(
        sessions.map((sessionId) => {
          attempted.add(sessionId);
          return this.root.send("Target.detachFromTarget", { sessionId });
        }),
      );
      for (const id of sessions) this.sessions.delete(id);
      return results.some((r) => r.status === "rejected");
    };
    const cleanup = async () => {
      const initial = this.disconnected
        ? Promise.resolve(false)
        : detachKnown();
      await Promise.allSettled([...this.raw]);
      const failed = await initial;
      const lateFailed = !this.disconnected && (await detachKnown());
      if (failed || lateFailed) throw unavailable();
    };
    try {
      await Promise.race([
        cleanup(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(unavailable()), 5000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
