export type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly code: string };

export type WorkerLike = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage: (message: unknown) => void;
  terminate: () => void;
};

type Pending = {
  readonly resolve: (value: WorkerResponse) => void;
  readonly reject: (reason?: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { id?: unknown; ok?: unknown; code?: unknown };
  if (!Number.isInteger(candidate.id) || (candidate.id as number) < 0)
    return false;
  if (
    candidate.ok === true &&
    Object.prototype.hasOwnProperty.call(value, "result")
  )
    return true;
  return candidate.ok === false && typeof candidate.code === "string";
}

/** Bounded, restartable bridge between the offscreen document and model worker. */
export class WorkerBroker {
  private readonly pending = new Map<number, Pending>();
  private worker: WorkerLike | undefined;
  private restartError: Error | undefined;
  private nextId = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private retentionTimer: ReturnType<typeof setTimeout> | undefined;
  private nextReleaseId = 0;
  private modelReady = false;
  private retiring: Promise<void> | undefined;
  private cancelRetirement: (() => void) | undefined;
  private readonly releases = {
    completed: 0,
    failed: 0,
    timedOut: 0,
    sendFailed: 0,
  };

  constructor(
    private readonly createWorker: () => WorkerLike,
    private readonly timeoutMs = 60_000,
    private readonly idleTimeoutMs = 60_000,
    private readonly onIdle: () => void = () => {},
    private readonly retainWorkerMs = 0,
  ) {
    if (
      !Number.isSafeInteger(retainWorkerMs) ||
      retainWorkerMs < 0 ||
      retainWorkerMs > 60_000
    )
      throw new Error("invalid-worker-retention");
  }

  get ready(): boolean {
    return this.modelReady;
  }

  get size(): number {
    return this.pending.size;
  }

  get releaseCounts(): Readonly<typeof this.releases> {
    return { ...this.releases };
  }

  request(text: string): Promise<WorkerResponse> {
    this.clearIdleTimer();
    // Preserve synchronous creation failure and request IDs outside retirement.
    if (!this.retiring) {
      try {
        this.ensureWorker();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const id = this.nextId++;
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.restart();
        reject(new Error("worker-timeout"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const send = () => {
        if (!this.pending.has(id)) return;
        try {
          this.ensureWorker().postMessage({ id, type: "detect", text });
        } catch (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          this.restart();
          reject(error);
        }
      };
      if (this.retiring) void this.retiring.then(send);
      else send();
    });
  }

  private bind(worker: WorkerLike): void {
    worker.onmessage = (event) => {
      if (this.worker !== worker) return;
      const response = event.data;
      if (!isWorkerResponse(response)) return;
      const entry = this.pending.get(response.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(response.id);
      this.modelReady = response.ok;
      this.scheduleIdleRelease();
      entry.resolve(response);
    };
    worker.onerror = () => {
      if (this.worker !== worker) return;
      this.restart();
    };
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    try {
      const worker = this.createWorker();
      this.worker = worker;
      this.nextReleaseId = 0;
      this.restartError = undefined;
      this.bind(worker);
      return worker;
    } catch {
      const error = this.restartError ?? new Error("worker-unavailable");
      this.restartError = error;
      throw error;
    }
  }

  private restart(): void {
    this.clearIdleTimer();
    this.modelReady = false;
    this.cancelRetirement?.();
    const old = this.worker;
    this.worker = undefined;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("worker-failed"));
    }
    this.pending.clear();
    old?.terminate();
    try {
      const worker = this.createWorker();
      this.worker = worker;
      this.nextReleaseId = 0;
      this.restartError = undefined;
      this.bind(worker);
      this.scheduleIdleRelease();
    } catch {
      this.restartError = new Error("worker-restart-failed");
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.retentionTimer !== undefined) clearTimeout(this.retentionTimer);
    this.retentionTimer = undefined;
  }

  private scheduleRetentionExpiry(worker: WorkerLike): void {
    this.clearIdleTimer();
    this.retentionTimer = setTimeout(() => {
      this.retentionTimer = undefined;
      if (this.worker !== worker || this.pending.size > 0) return;
      // The session-release acknowledgement already completed. No detector or
      // session remains to dispose, and no queued request may use this Worker.
      this.worker = undefined;
      this.modelReady = false;
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      this.onIdle();
    }, this.retainWorkerMs);
  }

  private scheduleIdleRelease(): void {
    this.clearIdleTimer();
    const worker = this.worker;
    if (!worker || this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.worker !== worker || this.pending.size > 0) return;
      const retain =
        this.retainWorkerMs > 0 && Number.isSafeInteger(this.nextReleaseId);
      const releaseId = retain ? this.nextReleaseId++ : undefined;
      this.worker = undefined;
      this.modelReady = false;
      // Serialize replacement behind a bounded release; waiting requests already
      // count in pending, so the offscreen concurrency limit still applies.
      let finish!: () => void;
      const retirement = new Promise<void>((resolve) => {
        finish = resolve;
      });
      this.retiring = retirement;
      let settled = false;
      const complete = (
        outcome: keyof typeof this.releases,
        notifyIdle = true,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.releases[outcome] += 1;
        worker.onmessage = null;
        worker.onerror = null;
        const retained = retain && outcome === "completed";
        if (retained) {
          this.worker = worker;
          this.bind(worker);
        } else worker.terminate();
        this.cancelRetirement = undefined;
        if (this.retiring === retirement) this.retiring = undefined;
        finish();
        if (this.pending.size === 0) {
          if (retained) this.scheduleRetentionExpiry(worker);
          else if (notifyIdle) this.onIdle();
        }
      };
      const timer = setTimeout(() => complete("timedOut"), 1_000);
      this.cancelRetirement = () => complete("failed", !retain);
      worker.onmessage = (event) => {
        if (!event.data || typeof event.data !== "object") return;
        const response = event.data as {
          type?: unknown;
          ok?: unknown;
          releaseId?: unknown;
        };
        if (typeof response.ok !== "boolean") return;
        if (retain) {
          if (
            response.type !== "session-released" ||
            response.releaseId !== releaseId ||
            Object.keys(response).sort().join(",") !== "ok,releaseId,type"
          )
            return;
        } else if (response.type !== "disposed") return;
        complete(response.ok ? "completed" : "failed");
      };
      worker.onerror = () => complete("failed");
      try {
        worker.postMessage(
          retain ? { type: "release-session", releaseId } : { type: "dispose" },
        );
      } catch {
        complete("sendFailed");
      }
    }, this.idleTimeoutMs);
  }
}
