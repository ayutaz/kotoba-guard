export type ScopedWorkerLedgerSnapshot = {
  readonly status: "complete" | "unavailable";
  readonly parentTargetId: string | null;
  readonly workerTargetIds: string[];
  readonly workerSessionIds: string[];
};

type RecordValue = Record<string, unknown>;

const MAX_WORKERS = 256;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Owns only worker targets observed through one parent CDP session.
 * This class deliberately has no transport dependency: the transport binds
 * events to the active parent session, then withholds any public snapshot
 * until its parent-scoped command has been acknowledged.
 */
export class ScopedWorkerLedger {
  private readonly workersByTarget = new Map<string, string | null>();
  private readonly targetsBySession = new Map<string, string>();
  private readonly retiredTargetIds = new Set<string>();
  private readonly retiredSessionIds = new Set<string>();
  private parentTargetId: string | null = null;
  private parentSessionId: string | null = null;
  private status: "complete" | "unavailable" = "unavailable";
  private hardError = false;
  private observedValidWorker = false;
  private disposed = false;
  private readonly workerUrl: string;

  public constructor(workerUrl: string) {
    this.workerUrl = typeof workerUrl === "string" ? workerUrl : "";
  }

  public open(parentTargetId: string, parentSessionId: string): void {
    if (this.disposed) return;
    for (const [targetId, sessionId] of this.workersByTarget) {
      this.retiredTargetIds.add(targetId);
      if (sessionId) this.retiredSessionIds.add(sessionId);
    }
    this.workersByTarget.clear();
    this.targetsBySession.clear();
    this.parentTargetId = nonEmptyString(parentTargetId)
      ? parentTargetId
      : null;
    this.parentSessionId = nonEmptyString(parentSessionId)
      ? parentSessionId
      : null;
    this.hardError = false;
    this.observedValidWorker = false;
    this.status = "unavailable";
  }

  public ingest(parentSessionId: string, message: unknown): void {
    if (
      this.disposed ||
      !nonEmptyString(parentSessionId) ||
      parentSessionId !== this.parentSessionId ||
      !isRecord(message) ||
      !nonEmptyString(message.method) ||
      !isRecord(message.params)
    ) {
      if (
        !this.disposed &&
        parentSessionId === this.parentSessionId &&
        (!isRecord(message) ||
          !nonEmptyString(message.method) ||
          !isRecord(message.params))
      )
        this.markHardError();
      return;
    }
    const params = message.params;
    switch (message.method) {
      case "Target.attachedToTarget":
        this.ingestAttached(params);
        break;
      case "Target.targetCreated":
      case "Target.targetInfoChanged":
        this.ingestKnownTargetInfo(params);
        break;
      case "Target.detachedFromTarget":
        this.ingestDetached(params);
        break;
      case "Target.targetDestroyed":
        if (nonEmptyString(params.targetId))
          this.targetDestroyed(params.targetId);
        else this.markHardError();
        break;
      default:
        break;
    }
  }

  public targetDestroyed(targetId: string): void {
    if (this.disposed || !nonEmptyString(targetId)) return;
    if (targetId === this.parentTargetId) {
      this.retireCurrentWorkers();
      this.parentTargetId = null;
      this.parentSessionId = null;
      this.workersByTarget.clear();
      this.targetsBySession.clear();
      this.status = "complete";
      this.hardError = false;
      this.observedValidWorker = false;
      return;
    }
    if (!this.workersByTarget.has(targetId)) return;
    const sessionId = this.workersByTarget.get(targetId);
    this.retiredTargetIds.add(targetId);
    if (sessionId) this.retiredSessionIds.add(sessionId);
    this.workersByTarget.delete(targetId);
    if (sessionId) this.targetsBySession.delete(sessionId);
    if (
      this.workersByTarget.size === 0 &&
      this.parentTargetId &&
      !this.hardError
    )
      this.status = "complete";
  }

  public parentDetached(sessionId: string): void {
    if (
      this.disposed ||
      !nonEmptyString(sessionId) ||
      sessionId !== this.parentSessionId
    )
      return;
    this.retireCurrentWorkers();
    this.parentTargetId = null;
    this.parentSessionId = null;
    this.workersByTarget.clear();
    this.targetsBySession.clear();
    this.status = "unavailable";
    this.observedValidWorker = false;
  }

  public invalidate(): void {
    if (!this.disposed) this.markHardError();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.parentTargetId = null;
    this.parentSessionId = null;
    this.workersByTarget.clear();
    this.targetsBySession.clear();
    this.status = "unavailable";
  }

  public snapshot(): ScopedWorkerLedgerSnapshot {
    return {
      status: this.status,
      parentTargetId: this.parentTargetId,
      workerTargetIds: [...this.workersByTarget.keys()].sort(),
      workerSessionIds: [...this.targetsBySession.keys()].sort(),
    };
  }

  private ingestAttached(params: RecordValue): void {
    const targetInfo = isRecord(params.targetInfo) ? params.targetInfo : null;
    const targetId = targetInfo?.targetId;
    const sessionId = params.sessionId;
    if (
      !targetInfo ||
      !nonEmptyString(targetId) ||
      !nonEmptyString(sessionId)
    ) {
      this.markHardError();
      return;
    }
    const targetKnown = this.workersByTarget.has(targetId);
    if (targetInfo.type !== "worker" || targetInfo.url !== this.workerUrl) {
      if (targetKnown) this.markHardError();
      return;
    }
    if (!this.validParentBinding(params, targetInfo)) {
      this.markHardError();
      return;
    }
    if (
      this.retiredTargetIds.has(targetId) ||
      this.retiredSessionIds.has(sessionId)
    )
      return;
    if (params.waitingForDebugger !== false) {
      this.markHardError();
      return;
    }
    const existingSession = this.workersByTarget.get(targetId);
    const existingTarget = this.targetsBySession.get(sessionId);
    if (existingSession === sessionId && existingTarget === targetId) return;
    if (targetKnown && existingSession === null) {
      if (existingTarget) {
        this.markHardError();
        return;
      }
      this.workersByTarget.set(targetId, sessionId);
      this.targetsBySession.set(sessionId, targetId);
      return;
    }
    if (targetKnown || existingTarget) {
      this.markHardError();
      return;
    }
    if (this.workersByTarget.size >= MAX_WORKERS) {
      this.markHardError();
      return;
    }
    this.workersByTarget.set(targetId, sessionId);
    this.targetsBySession.set(sessionId, targetId);
    if (!this.observedValidWorker && !this.hardError) {
      this.observedValidWorker = true;
      this.status = "complete";
    }
  }

  private ingestKnownTargetInfo(params: RecordValue): void {
    const targetInfo = isRecord(params.targetInfo) ? params.targetInfo : null;
    const targetId = targetInfo?.targetId;
    if (!targetInfo || !nonEmptyString(targetId)) {
      this.markHardError();
      return;
    }
    if (!this.workersByTarget.has(targetId)) return;
    if (
      !targetInfo ||
      targetInfo.type !== "worker" ||
      targetInfo.url !== this.workerUrl ||
      !this.validParentBinding(params, targetInfo)
    )
      this.markHardError();
  }

  private ingestDetached(params: RecordValue): void {
    const sessionId = params.sessionId;
    if (!nonEmptyString(sessionId)) {
      this.markHardError();
      return;
    }
    if (sessionId === this.parentSessionId) {
      this.parentDetached(sessionId);
      return;
    }
    if (!this.targetsBySession.has(sessionId)) return;
    const targetId = this.targetsBySession.get(sessionId);
    this.targetsBySession.delete(sessionId);
    if (targetId) this.workersByTarget.set(targetId, null);
    this.status = "unavailable";
  }

  private markHardError(): void {
    this.hardError = true;
    this.status = "unavailable";
  }

  private retireCurrentWorkers(): void {
    for (const [targetId, sessionId] of this.workersByTarget) {
      this.retiredTargetIds.add(targetId);
      if (sessionId) this.retiredSessionIds.add(sessionId);
    }
  }

  private validParentBinding(
    params: RecordValue,
    targetInfo: RecordValue,
  ): boolean {
    return (
      (params.parentId === undefined ||
        params.parentId === this.parentTargetId) &&
      (targetInfo.parentId === undefined ||
        targetInfo.parentId === this.parentTargetId)
    );
  }
}
