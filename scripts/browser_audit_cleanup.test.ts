// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { cleanupAuditResources } from "./browser_security_audit.mjs";

describe("audit persistent-browser cleanup", () => {
  it("stops the monitor before disconnecting its CDP transport", async () => {
    let stopped = false;
    expect(
      await cleanupAuditResources({
        monitor: {
          stop: async () => {
            stopped = true;
          },
        },
        cdp: {
          close: async () => {
            expect(stopped).toBe(true);
          },
        },
      }),
    ).toEqual({ monitor: true, cdp: true });
  });
  it("closes the owning browser before awaiting its persistent context", async () => {
    let ownerClosed = false;
    const result = await cleanupAuditResources({
      browser: {
        close: async () => {
          ownerClosed = true;
        },
      },
      context: {
        pages: () => [],
        close: async () => {
          if (!ownerClosed)
            throw new Error("persistent context waits for its browser owner");
        },
      },
    });
    expect(result.context).toBe(true);
    expect(ownerClosed).toBe(true);
  });
  it("disconnects the observer and closes pages before the persistent context", async () => {
    const events: string[] = [];
    const cdp = {
      close: async () => {
        events.push("cdp");
      },
      send: vi.fn(() => {
        throw new Error("Browser.close must not race context.close");
      }),
    };
    let pageClosed = false;
    const page = {
      close: async () => {
        pageClosed = true;
        events.push("pages");
      },
    };
    const context = {
      pages: () => [page],
      close: async () => {
        expect(pageClosed).toBe(true);
        expect(events[0]).toBe("cdp");
        events.push("context");
      },
    };
    const browser = {
      close: async () => {
        events.push("browser");
      },
    };
    const fixture = {
      close: async () => {
        events.push("fixture");
      },
    };
    expect(
      await cleanupAuditResources({ cdp, context, browser, fixture }),
    ).toEqual({
      cdp: true,
      pages: true,
      context: true,
      browser: true,
      fixture: true,
    });
    expect(events).toEqual(["cdp", "pages", "browser", "context", "fixture"]);
    expect(cdp.send).not.toHaveBeenCalled();
  });

  it("retains failed operations and still attempts every later resource", async () => {
    const page2 = vi.fn(async () => undefined);
    const contextClose = vi.fn(async () => undefined);
    const fixtureClose = vi.fn(async () => undefined);
    const result = await cleanupAuditResources({
      cdp: {
        close: async () => {
          throw new Error("observer failed");
        },
      },
      context: {
        pages: () => [
          {
            close: async () => {
              throw new Error("page failed");
            },
          },
          { close: page2 },
        ],
        close: contextClose,
      },
      browser: {
        close: async () => {
          throw new Error("browser failed");
        },
      },
      fixture: { close: fixtureClose },
    });
    expect(result).toEqual({
      cdp: false,
      pages: false,
      context: true,
      browser: false,
      fixture: true,
    });
    expect(page2).toHaveBeenCalledOnce();
    expect(contextClose).toHaveBeenCalledOnce();
    expect(fixtureClose).toHaveBeenCalledOnce();
  });

  it("bounds a stuck page close and preserves the failure", async () => {
    vi.useFakeTimers();
    try {
      const contextClose = vi.fn(async () => undefined);
      const task = cleanupAuditResources(
        {
          context: {
            pages: () => [{ close: () => new Promise<void>(() => undefined) }],
            close: contextClose,
          },
        },
        5_000,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await task).toEqual({ pages: false, context: true });
      expect(contextClose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
