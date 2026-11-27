import type { CDPSession } from "@playwright/test";

type RootSession = Pick<CDPSession, "send" | "on" | "off">;
type Entry = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const expression = "globalThis.__kotobaMemoryProbeSnapshot()";
const timeoutMs = 5_000;

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("heap-command-timeout")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-heap-metadata");
  return value as Record<string, unknown>;
}
function bytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("invalid-heap-metadata");
  return value;
}

/** Owned non-flat child CDP session. Only fixed numeric metadata reads are sent. */
export class WorkerHeapSession {
  private sessionId = "";
  private readonly pending = new Map<number, Entry>();
  private nextId = 0;
  private closed = false;
  private reading: ReturnType<WorkerHeapSession["sample"]> | undefined;
  private closing: Promise<void> | undefined;

  private constructor(private readonly root: RootSession) {}

  /** Adopt only a session already obtained from an owned parent's notification. */
  static adopt(root: RootSession, sessionId: string): WorkerHeapSession {
    if (!sessionId || sessionId.length > 128)
      throw new Error("invalid-owned-worker-session");
    const session = new WorkerHeapSession(root);
    session.sessionId = sessionId;
    root.on("Target.receivedMessageFromTarget", session.receive);
    return session;
  }

  static async attach(
    root: RootSession,
    targetId: string,
  ): Promise<WorkerHeapSession> {
    const session = new WorkerHeapSession(root);
    root.on("Target.receivedMessageFromTarget", session.receive);
    try {
      const response = await bounded(
        root.send("Target.attachToTarget", { targetId, flatten: false }),
      );
      if (!response.sessionId || response.sessionId.length > 128)
        throw new Error("invalid-session");
      session.sessionId = response.sessionId;
      return session;
    } catch {
      root.off("Target.receivedMessageFromTarget", session.receive);
      throw new Error("heap-attach-failed");
    }
  }

  private readonly receive = (event: {
    sessionId: string;
    message: string;
  }): void => {
    if (
      event.sessionId !== this.sessionId ||
      typeof event.message !== "string" ||
      event.message.length > 4096
    )
      return;
    let message: Record<string, unknown>;
    try {
      message = record(JSON.parse(event.message));
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    if (Object.hasOwn(message, "error"))
      entry.reject(new Error("heap-command-failed"));
    else entry.resolve(message.result);
  };

  private request(
    method:
      "Runtime.getIsolateId" | "Runtime.getHeapUsage" | "Runtime.evaluate",
    parameters: object = {},
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("heap-session-closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("heap-command-timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.root
        .send("Target.sendMessageToTarget", {
          sessionId: this.sessionId,
          message: JSON.stringify({ id, method, params: parameters }),
        })
        .catch(() => {
          const entry = this.pending.get(id);
          if (!entry) return;
          clearTimeout(entry.timer);
          this.pending.delete(id);
          entry.reject(new Error("heap-command-failed"));
        });
    });
  }

  read(): ReturnType<WorkerHeapSession["sample"]> {
    if (this.closed) return Promise.reject(new Error("heap-session-closed"));
    if (!this.reading)
      this.reading = this.sample().finally(() => {
        this.reading = undefined;
      });
    return this.reading;
  }

  private async sample() {
    const isolate = record(await this.request("Runtime.getIsolateId"));
    if (
      typeof isolate.id !== "string" ||
      isolate.id.length === 0 ||
      isolate.id.length > 128
    )
      throw new Error("invalid-heap-metadata");
    const usage = record(await this.request("Runtime.getHeapUsage"));
    const heap = {
      usedSize: bytes(usage.usedSize),
      totalSize: bytes(usage.totalSize),
      embedderHeapUsedSize: bytes(usage.embedderHeapUsedSize),
      backingStorageSize: bytes(usage.backingStorageSize),
    };
    if (heap.usedSize > heap.totalSize)
      throw new Error("invalid-heap-metadata");
    const evaluation = record(
      await this.request("Runtime.evaluate", {
        expression,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: false,
      }),
    );
    if (evaluation.exceptionDetails)
      throw new Error("heap-probe-evaluation-failed");
    const value = record(record(evaluation.result).value);
    if (
      value.status !== "complete" ||
      !Array.isArray(value.byteLengths) ||
      value.byteLengths.length > 32
    )
      throw new Error("invalid-heap-metadata");
    const byteLengths = value.byteLengths.map(bytes);
    const totalBytes = bytes(value.totalBytes);
    const observedCount = bytes(value.observedCount);
    const liveCount = bytes(value.liveCount);
    if (
      totalBytes !== byteLengths.reduce((a, b) => a + b, 0) ||
      liveCount !== byteLengths.length ||
      observedCount < liveCount ||
      observedCount > 32
    )
      throw new Error("invalid-heap-metadata");
    return {
      isolateId: isolate.id,
      heap,
      wasm: {
        status: "complete",
        observedCount,
        liveCount,
        totalBytes,
        byteLengths,
      },
    };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.root.off("Target.receivedMessageFromTarget", this.receive);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("heap-session-closed"));
    }
    this.pending.clear();
    this.closing = bounded(
      this.root.send("Target.detachFromTarget", { sessionId: this.sessionId }),
    ).then(() => undefined);
    return this.closing;
  }
}
