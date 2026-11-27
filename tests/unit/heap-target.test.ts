import { afterEach, expect, it, vi } from "vitest";
import type { CDPSession } from "@playwright/test";
import { findCalibrationWorker } from "../diagnostics/heap-target";
afterEach(() => vi.useRealTimers());

it("bounds an unresponsive inventory command to five seconds", async () => {
  vi.useFakeTimers();
  const fake = { send: () => new Promise(() => undefined) } as unknown as Pick<
    CDPSession,
    "send"
  >;
  const result = findCalibrationWorker(fake, "owned").catch(
    (error: Error) => error.message,
  );
  await vi.advanceTimersByTimeAsync(5000);
  const pending = Symbol("pending");
  expect(await Promise.race([result, Promise.resolve(pending)])).toBe(
    "heap-inventory-timeout",
  );
});

function root(workers: Array<{ targetId: string; url: string }>) {
  const send = vi.fn(async () => ({
    targetInfos: [
      {
        targetId: "parent",
        type: "other",
        url: "chrome-extension://owned/offscreen.html",
      },
      ...workers.map((value) => ({ ...value, type: "worker" })),
    ],
  }));
  return { send, typed: { send } as unknown as Pick<CDPSession, "send"> };
}
it("uses only inventory in the isolated fixture, including a unique URL-hidden worker", async () => {
  const fake = root([{ targetId: "worker", url: "" }]);
  expect(await findCalibrationWorker(fake.typed, "owned")).toBe("worker");
  expect(fake.send.mock.calls).toEqual([
    ["Target.getTargets", { filter: [{}] }],
  ]);
});
it("rejects ambiguity and a foreign URL rather than attaching related targets", async () => {
  for (const workers of [
    [],
    [
      { targetId: "one", url: "" },
      { targetId: "two", url: "" },
    ],
    [{ targetId: "foreign", url: "https://example.com/worker.js" }],
  ]) {
    const fake = root(workers);
    expect(await findCalibrationWorker(fake.typed, "owned")).toBeUndefined();
    expect(fake.send).toHaveBeenCalledTimes(1);
  }
});
