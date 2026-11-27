export type ClosableFixtureContext = {
  close: () => Promise<void>;
  pages?: () => readonly { close: () => Promise<void> }[];
};

type OwnedFixtureSession = {
  detach: () => Promise<void>;
};

type OwnedFixtureObserver = {
  dispose: () => Promise<void>;
};

type AsyncCleanup = () => Promise<void>;

function withTimeout(
  cleanup: AsyncCleanup,
  timeoutMs: number,
  resourceName: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(
        new Error(`${resourceName} cleanup timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    void Promise.resolve()
      .then(cleanup)
      .then(
        () => {
          if (timedOut) return;
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          if (timedOut) return;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

export async function cleanupFixtureResources(
  context: ClosableFixtureContext | undefined,
  closeServer: AsyncCleanup,
  timeoutMs = 5_000,
  session?: OwnedFixtureSession,
  observer?: OwnedFixtureObserver,
): Promise<void> {
  const errors: unknown[] = [];
  if (observer !== undefined) {
    try {
      await withTimeout(() => observer.dispose(), timeoutMs, "Worker observer");
    } catch (error) {
      errors.push(error);
    }
  }
  if (session !== undefined) {
    try {
      await withTimeout(() => session.detach(), timeoutMs, "CDP session");
    } catch (error) {
      errors.push(error);
    }
  }
  if (context !== undefined) {
    if (context.pages !== undefined) {
      try {
        await withTimeout(
          async () => {
            await Promise.all(context.pages!().map((page) => page.close()));
          },
          timeoutMs,
          "browser pages",
        );
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await withTimeout(() => context.close(), timeoutMs, "browser context");
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await withTimeout(closeServer, timeoutMs, "fixture server");
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Fixture resource cleanup failed");
  }
}
