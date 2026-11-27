import { isOffscreenInstanceId } from "../shared/security";

type Context = { documentId?: string };
type Identity = { documentId: string; instanceId: string };
type API = {
  getContexts: () => Promise<Context[]>;
  getInstanceId: () => Promise<unknown>;
  create: () => Promise<void>;
  close: () => Promise<void>;
  isRetiring: () => Promise<boolean>;
};
type Transition = { kind: "create" | "close"; result: Promise<unknown> };

/** Serializes document mutations; a timed-out API retains ownership until it settles. */
export class OffscreenLifecycle {
  private transition: Transition | undefined;
  private active = 0;
  private revision = 0;
  private identityQuery: Promise<Identity | undefined> | undefined;

  identify(instanceId: string): Promise<string | undefined> {
    if (!isOffscreenInstanceId(instanceId)) return Promise.resolve(undefined);
    return this.currentIdentity().then((identity) =>
      identity?.instanceId === instanceId ? identity.documentId : undefined,
    );
  }

  private currentIdentity(): Promise<Identity | undefined> {
    if (this.identityQuery) return this.identityQuery;
    const deadline = performance.now() + 5000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const actual = Promise.resolve()
      .then(() => this.api.getContexts())
      .then(async (contexts) => {
        if (performance.now() >= deadline) return undefined;
        const id = contexts[0]?.documentId;
        const valid =
          contexts.length === 1 &&
          typeof id === "string" &&
          id.length > 0 &&
          id.length <= 128;
        if (!valid) return undefined;
        const instanceId = await this.api.getInstanceId();
        if (performance.now() >= deadline || !isOffscreenInstanceId(instanceId))
          return undefined;
        const after = await this.api.getContexts();
        if (
          performance.now() >= deadline ||
          after.length !== 1 ||
          after[0]?.documentId !== id
        )
          return undefined;
        return { documentId: id, instanceId };
      });
    const result = Promise.race([
      actual,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("offscreen-identity-timeout")),
          5000,
        );
      }),
    ]);
    this.identityQuery = result;
    const settled = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (this.identityQuery === result) this.identityQuery = undefined;
    };
    void actual.then(settled, settled);
    return result;
  }

  get generation(): number {
    return this.revision;
  }
  get closing(): boolean {
    return this.transition?.kind === "close";
  }

  constructor(
    private readonly api: API,
    private readonly busy: () => boolean,
  ) {}

  async withDocument<T>(operation: () => Promise<T>): Promise<T> {
    this.active += 1;
    try {
      await this.ensure();
      return await operation();
    } finally {
      this.active -= 1;
    }
  }

  closeIfIdle(documentId: string, instanceId: string): Promise<boolean | null> {
    if (!documentId || !isOffscreenInstanceId(instanceId))
      return Promise.resolve(false);
    // null is an unknown/in-progress transition, never permission to unretire.
    if (this.transition) return Promise.resolve(null);
    if (this.active > 0 || this.busy() || !documentId)
      return Promise.resolve(false);
    return this.start("close", async () => {
      const identity = await this.currentIdentity();
      if (
        this.active > 0 ||
        this.busy() ||
        identity?.documentId !== documentId ||
        identity.instanceId !== instanceId
      )
        return false;
      await this.api.close();
      return true;
    });
  }

  private async ensure(): Promise<void> {
    const current = this.transition;
    if (current) {
      try {
        await current.result;
      } catch (error) {
        // A settled close failure can be recovered by rediscovering its document.
        // An uncancellable, still-live API must retain the lock after timeout.
        if (this.transition === current || current.kind === "create")
          throw error;
      }
      if (current.kind === "create") return;
      // Another waiter may already have started the single replacement.
      if (this.transition) return this.ensure();
    }
    await this.start("create", async () => {
      const deadline = performance.now() + 5000;
      for (;;) {
        if ((await this.api.getContexts()).length === 0) {
          await this.api.create();
          return;
        }
        if (!(await this.api.isRetiring())) return;
        if (performance.now() >= deadline)
          throw new Error("offscreen-retiring");
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    });
  }

  private start<T>(
    kind: Transition["kind"],
    operation: () => Promise<T>,
  ): Promise<T> {
    this.revision += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const actual = Promise.resolve().then(operation);
    const result = Promise.race([
      actual,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("offscreen-transition-timeout")),
          5000,
        );
      }),
    ]);
    const transition: Transition = { kind, result };
    this.transition = transition;
    const settled = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (this.transition === transition) this.transition = undefined;
    };
    void actual.then(settled, settled);
    return result;
  }
}
