import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFixtureResources } from "../e2e/fixture-resources";

afterEach(() => {
  vi.useRealTimers();
});

describe("cleanupFixtureResources", () => {
  it("still closes context and server after a page close failure", async () => {
    const contextClose = vi.fn(async () => undefined);
    const serverClose = vi.fn(async () => undefined);
    const failure = new Error("page close failed");
    await expect(
      cleanupFixtureResources(
        {
          pages: () => [
            {
              close: async () => {
                throw failure;
              },
            },
          ],
          close: contextClose,
        },
        serverClose,
      ),
    ).rejects.toBe(failure);
    expect(contextClose).toHaveBeenCalledOnce();
    expect(serverClose).toHaveBeenCalledOnce();
  });
  it("closes owned pages before closing a persistent browser context", async () => {
    const events: string[] = [];
    await cleanupFixtureResources(
      {
        pages: () => [
          {
            close: async () => {
              events.push("page");
            },
          },
        ],
        close: async () => {
          events.push("context");
        },
      },
      async () => {
        events.push("server");
      },
    );
    expect(events).toEqual(["page", "context", "server"]);
  });
  it("disposes the owned observer before the CDP, context and server with its this binding", async () => {
    const events: string[] = [];
    const observer = {
      disposed: false,
      async dispose(this: { disposed: boolean }) {
        this.disposed = true;
        events.push("observer");
      },
    };
    await cleanupFixtureResources(
      {
        close: async () => {
          events.push("context");
        },
      },
      async () => {
        events.push("server");
      },
      50,
      {
        detach: async () => {
          events.push("session");
        },
      },
      observer,
    );
    expect(observer.disposed).toBe(true);
    expect(events).toEqual(["observer", "session", "context", "server"]);
  });
  it("keeps every failure after observer disposal fails", async () => {
    const failures = ["observer", "session", "context", "server"].map(
      (name) => new Error(name),
    );
    await expect(
      cleanupFixtureResources(
        {
          close: async () => {
            throw failures[2];
          },
        },
        async () => {
          throw failures[3];
        },
        50,
        {
          detach: async () => {
            throw failures[1];
          },
        },
        {
          dispose: async () => {
            throw failures[0];
          },
        },
      ),
    ).rejects.toMatchObject({ errors: failures });
  });
  it("gives observer and session separate deadlines and attempts later cleanup after both time out", async () => {
    vi.useFakeTimers();
    const context = { close: vi.fn(async () => undefined) };
    const server = vi.fn(async () => undefined);
    const detach = vi.fn(() => new Promise<void>(() => undefined));
    const closing = cleanupFixtureResources(
      context,
      server,
      10,
      { detach },
      { dispose: () => new Promise<void>(() => undefined) },
    );
    const assertion = expect(closing).rejects.toMatchObject({
      errors: [expect.any(Error), expect.any(Error)],
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(detach).toHaveBeenCalledOnce();
    expect(context.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(context.close).toHaveBeenCalledOnce();
    expect(server).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("detaches its owned session before closing the context and server", async () => {
    const events: string[] = [];
    const session = {
      detached: false,
      detach(this: { detached: boolean }) {
        this.detached = true;
        events.push("session");
        return Promise.resolve();
      },
    };
    await cleanupFixtureResources(
      {
        close: async () => {
          events.push("context");
        },
      },
      async () => {
        events.push("server");
      },
      50,
      session,
    );
    expect(events).toEqual(["session", "context", "server"]);
    expect(session.detached).toBe(true);
  });

  it("attempts both other resources after a session detach failure", async () => {
    const events: string[] = [];
    const failure = new Error("detach failed");
    await expect(
      cleanupFixtureResources(
        {
          close: async () => {
            events.push("context");
          },
        },
        async () => {
          events.push("server");
        },
        50,
        {
          detach: async () => {
            throw failure;
          },
        },
      ),
    ).rejects.toBe(failure);
    expect(events).toEqual(["context", "server"]);
  });

  it("bounds session detach and still closes context and server", async () => {
    vi.useFakeTimers();
    const context = { close: vi.fn(async () => undefined) };
    const server = vi.fn(async () => undefined);
    const result = cleanupFixtureResources(context, server, 10, {
      detach: () => new Promise<void>(() => undefined),
    });
    const outcome = result.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toBeInstanceOf(Error);
    expect(((await outcome) as Error).message).toMatch(
      /CDP session cleanup timed out/,
    );
    expect(context.close).toHaveBeenCalledOnce();
    expect(server).toHaveBeenCalledOnce();
  });

  it("preserves every cleanup failure", async () => {
    const sessionFailure = new Error("session failed");
    const contextFailure = new Error("context failed");
    const serverFailure = new Error("server failed");
    const result = cleanupFixtureResources(
      {
        close: async () => {
          throw contextFailure;
        },
      },
      async () => {
        throw serverFailure;
      },
      50,
      {
        detach: async () => {
          throw sessionFailure;
        },
      },
    );
    await expect(result).rejects.toMatchObject({
      errors: [sessionFailure, contextFailure, serverFailure],
    });
  });

  it("closes the server when context cleanup rejects", async () => {
    const context = {
      close: vi.fn(async () => {
        throw new Error("context close failed");
      }),
    };
    const closeServer = vi.fn(async () => undefined);

    await expect(
      cleanupFixtureResources(context, closeServer, 50),
    ).rejects.toThrow("context close failed");
    expect(closeServer).toHaveBeenCalledOnce();
  });

  it("closes the server when no browser context was created", async () => {
    const closeServer = vi.fn(async () => undefined);

    await cleanupFixtureResources(undefined, closeServer, 50);

    expect(closeServer).toHaveBeenCalledOnce();
  });

  it("times out a stuck context and still attempts server cleanup", async () => {
    vi.useFakeTimers();
    const context = {
      close: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const closeServer = vi.fn(async () => undefined);
    const cleanup = cleanupFixtureResources(context, closeServer, 10);
    const rejection = expect(cleanup).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(10);

    await rejection;
    expect(closeServer).toHaveBeenCalledOnce();
  });

  it("closes both resources successfully", async () => {
    const events: string[] = [];
    const context = {
      closed: false,
      close(this: { closed: boolean }) {
        this.closed = true;
        events.push("context");
        return Promise.resolve();
      },
    };
    const closeServer = vi.fn(async () => {
      events.push("server");
    });

    await cleanupFixtureResources(context, closeServer, 50);

    expect(events).toEqual(["context", "server"]);
    expect(context.closed).toBe(true);
  });
});
