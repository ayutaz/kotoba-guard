import type { CDPSession } from "@playwright/test";

type Root = Pick<CDPSession, "send" | "on" | "off">;
type Message = { sessionId: string; message: string };
type Child = {
  sessionId: string;
  targetId: string;
  explicitParentId: string | null;
};
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-parent-worker-binding");
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128)
    throw new Error("invalid-parent-worker-binding");
  return value;
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("parent-command-timeout")),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A parent-owned non-flat tunnel. This class is diagnostic-only, not a page bridge. */
export class ParentWorkerSession {
  private parentSessionId = "";
  private child: Child | undefined;
  private bindingError = false;
  private notificationCount = 0;
  private observedPause: boolean | null = null;
  private readonly active = new Set<string>();
  private readonly detached = new Set<string>();
  private readonly listeners = new Set<(message: Message) => void>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;
  private observing: Promise<Child> | undefined;
  private closing: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private cancelWait: (() => void) | undefined;
  private detachWait: Promise<void> | undefined;
  private detachWake: (() => void) | undefined;
  private cancelDetach: (() => void) | undefined;

  private constructor(
    private readonly root: Root,
    private readonly parentTargetId: string,
    private readonly workerUrl: string,
  ) {}

  static async attach(
    root: Root,
    extensionId: string,
  ): Promise<ParentWorkerSession> {
    const { targetInfos } = await bounded(
      root.send("Target.getTargets", { filter: [{}] }),
    );
    const parents = targetInfos.filter(
      (t) =>
        t.url === `chrome-extension://${extensionId}/offscreen.html` &&
        ["other", "page", "background_page"].includes(t.type),
    );
    if (parents.length !== 1) throw new Error("invalid-calibration-parent");
    const parent = new ParentWorkerSession(
      root,
      identifier(parents[0]!.targetId),
      `chrome-extension://${extensionId}/worker.js`,
    );
    root.on("Target.receivedMessageFromTarget", parent.receive);
    try {
      const attached = await bounded(
        root.send("Target.attachToTarget", {
          targetId: parent.parentTargetId,
          flatten: false,
        }),
      );
      parent.parentSessionId = identifier(attached.sessionId);
      return parent;
    } catch {
      root.off("Target.receivedMessageFromTarget", parent.receive);
      throw new Error("parent-attach-failed");
    }
  }

  private readonly receive = (outer: Message): void => {
    if (
      outer.sessionId !== this.parentSessionId ||
      typeof outer.message !== "string" ||
      outer.message.length > 8192
    )
      return;
    let message: Record<string, unknown>;
    try {
      message = record(JSON.parse(outer.message));
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (Object.hasOwn(message, "error"))
        entry.reject(new Error("parent-command-failed"));
      else entry.resolve(message.result);
      return;
    }
    try {
      if (message.method === "Target.attachedToTarget") {
        this.notificationCount += 1;
        const params = record(message.params),
          target = record(params.targetInfo);
        this.observedPause =
          typeof params.waitingForDebugger === "boolean"
            ? params.waitingForDebugger
            : null;
        const sessionId = identifier(params.sessionId),
          targetId = identifier(target.targetId);
        if (this.active.size >= 32)
          throw new Error("invalid-parent-worker-binding");
        this.active.add(sessionId);
        if (
          this.notificationCount !== 1 ||
          target.type !== "worker" ||
          target.url !== this.workerUrl ||
          params.waitingForDebugger !== false ||
          (target.parentId !== undefined &&
            target.parentId !== this.parentTargetId)
        )
          throw new Error("invalid-parent-worker-binding");
        this.child = {
          sessionId,
          targetId,
          explicitParentId:
            target.parentId === undefined ? null : identifier(target.parentId),
        };
        this.wake?.();
      } else if (message.method === "Target.receivedMessageFromTarget") {
        const params = record(message.params);
        if (
          !this.child ||
          params.sessionId !== this.child.sessionId ||
          typeof params.message !== "string"
        )
          return;
        for (const listener of this.listeners)
          listener({
            sessionId: this.child.sessionId,
            message: params.message,
          });
      } else if (message.method === "Target.detachedFromTarget") {
        const params = record(message.params);
        const id = identifier(params.sessionId);
        if (this.active.delete(id)) this.detached.add(id);
        this.detachWake?.();
      }
    } catch {
      this.bindingError = true;
      this.wake?.();
    }
  };

  private request(
    method: string,
    parameters: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("parent-session-closed"));
    if (
      ![
        "Target.setAutoAttach",
        "Target.sendMessageToTarget",
        "Target.detachFromTarget",
      ].includes(method)
    )
      return Promise.reject(new Error("parent-command-disallowed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("parent-command-timeout"));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      void this.root
        .send("Target.sendMessageToTarget", {
          sessionId: this.parentSessionId,
          message: JSON.stringify({ id, method, params: parameters }),
        })
        .catch(() => {
          const entry = this.pending.get(id);
          if (!entry) return;
          clearTimeout(entry.timer);
          this.pending.delete(id);
          entry.reject(new Error("parent-command-failed"));
        });
    });
  }

  readonly transport = {
    send: (method: string, params?: Record<string, unknown>) => {
      if (
        !["Target.sendMessageToTarget", "Target.detachFromTarget"].includes(
          method,
        )
      )
        return Promise.reject(new Error("parent-command-disallowed"));
      if (
        !this.child ||
        params?.sessionId !== this.child.sessionId ||
        !this.active.has(this.child.sessionId)
      )
        return Promise.reject(new Error("parent-child-session-mismatch"));
      return this.request(method, params);
    },
    on: (event: string, handler: (message: Message) => void) => {
      if (event !== "Target.receivedMessageFromTarget")
        throw new Error("parent-event-disallowed");
      this.listeners.add(handler);
    },
    off: (_event: string, handler: (message: Message) => void) => {
      this.listeners.delete(handler);
    },
  } as unknown as Root;

  observeWorker(): Promise<Child> {
    if (!this.observing) this.observing = this.observe();
    return this.observing;
  }
  waitForChildrenDetached(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("parent-session-closed"));
    if (this.active.size === 0) return Promise.resolve();
    if (!this.detachWait)
      this.detachWait = new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          this.detachWake = undefined;
          this.cancelDetach = undefined;
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(
          () => finish(new Error("parent-child-detach-timeout")),
          5000,
        );
        this.detachWake = () => {
          if (this.active.size === 0) finish();
        };
        this.cancelDetach = () => finish(new Error("parent-session-closed"));
      }).finally(() => {
        this.detachWait = undefined;
      });
    return this.detachWait;
  }
  async detachChildren(): Promise<void> {
    const notification = this.waitForChildrenDetached();
    await Promise.all([
      notification,
      ...[...this.active].map((sessionId) =>
        this.request("Target.detachFromTarget", { sessionId }),
      ),
    ]);
  }
  private async observe(): Promise<Child> {
    await this.request("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: false,
      filter: [{ type: "worker" }, { exclude: true }],
    });
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.wake = undefined;
        this.cancelWait = undefined;
        if (error) reject(error);
        else resolve({ ...this.child! });
      };
      const check = () => {
        if (
          this.bindingError ||
          (this.child && !this.active.has(this.child.sessionId))
        )
          finish(new Error("invalid-parent-worker-binding"));
        else if (this.child) finish();
      };
      const timer = setTimeout(
        () => finish(new Error("parent-worker-notification-timeout")),
        5000,
      );
      this.wake = check;
      this.cancelWait = () => finish(new Error("parent-session-closed"));
      check();
    });
  }
  metadata() {
    return {
      parentTargetId: this.parentTargetId,
      parentSessionId: this.parentSessionId,
      workerTargetId: this.child?.targetId ?? null,
      workerSessionId: this.child?.sessionId ?? null,
      explicitParentId: this.child?.explicitParentId ?? null,
      relationship: "parent-session-attachedToTarget",
      urlMatchesExpected: !!this.child,
      waitingForDebugger: this.observedPause,
      notificationCount: this.notificationCount,
      bindingValid:
        !this.bindingError && this.notificationCount === 1 && !!this.child,
      activeChildren: this.active.size,
      detachedChildren: this.detached.size,
      childDetachObserved:
        !!this.child && this.detached.has(this.child.sessionId),
    };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.cancelWait?.();
    this.cancelDetach?.();
    this.root.off("Target.receivedMessageFromTarget", this.receive);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("parent-session-closed"));
    }
    this.pending.clear();
    this.listeners.clear();
    this.closing = bounded(
      this.root.send("Target.detachFromTarget", {
        sessionId: this.parentSessionId,
      }),
    ).then(() => undefined);
    return this.closing;
  }
}
