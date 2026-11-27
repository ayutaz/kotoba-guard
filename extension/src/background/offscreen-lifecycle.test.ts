import { afterEach, expect, it, vi } from "vitest";
import { OffscreenLifecycle } from "./offscreen-lifecycle";

const defer = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const context = { documentId: "current" };
function fixture() {
  const api = {
    getContexts: vi.fn().mockResolvedValue([context]),
    getInstanceId: vi.fn().mockResolvedValue(INSTANCE_ID),
    create: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isRetiring: vi.fn().mockResolvedValue(false),
  };
  const busy = vi.fn(() => false);
  return { api, busy, lifecycle: new OffscreenLifecycle(api, busy) };
}
afterEach(() => vi.useRealTimers());

it("does not start another API phase when a timed-out discovery eventually settles", async () => {
  vi.useFakeTimers();
  const { api, lifecycle } = fixture();
  const query = defer<Array<{ documentId: string }>>();
  api.getContexts.mockReturnValueOnce(query.promise);
  const failed = lifecycle.identify(INSTANCE_ID).then(
    () => "resolved",
    (error: Error) => error.message,
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect(await failed).toBe("offscreen-identity-timeout");
  query.resolve([context]);
  await vi.advanceTimersByTimeAsync(0);
  expect(api.getContexts).toHaveBeenCalledOnce();
  expect(api.getInstanceId).not.toHaveBeenCalled();
  expect(await lifecycle.identify(INSTANCE_ID)).toBe("current");
  expect(api.getContexts).toHaveBeenCalledTimes(3);
});

it("binds each concurrent caller to the live instance instead of returning a shared acceptance", async () => {
  const { api, lifecycle } = fixture();
  const [current, stale] = await Promise.all([
    lifecycle.identify(INSTANCE_ID),
    lifecycle.identify(OTHER_INSTANCE_ID),
  ]);
  expect(current).toBe("current");
  expect(stale).toBeUndefined();
  expect(api.getInstanceId).toHaveBeenCalledOnce();
  expect(api.getContexts).toHaveBeenCalledTimes(2);
  expect(await lifecycle.closeIfIdle("current", OTHER_INSTANCE_ID)).toBe(false);
  expect(api.close).not.toHaveBeenCalled();
});

it("rejects a document replacement during the instance probe", async () => {
  const { api, lifecycle } = fixture();
  api.getContexts
    .mockResolvedValueOnce([context])
    .mockResolvedValueOnce([{ documentId: "replacement" }]);
  expect(await lifecycle.identify(INSTANCE_ID)).toBeUndefined();
  api.getContexts
    .mockResolvedValueOnce([context])
    .mockResolvedValueOnce([{ documentId: "replacement" }]);
  expect(await lifecycle.closeIfIdle("current", INSTANCE_ID)).toBe(false);
  expect(api.close).not.toHaveBeenCalled();
});

it.each([undefined, "", "not-a-uuid", OTHER_INSTANCE_ID])(
  "rejects a missing or mismatched probed marker %s",
  async (instanceId) => {
    const { api, lifecycle } = fixture();
    api.getInstanceId.mockResolvedValue(instanceId);
    expect(await lifecycle.identify(INSTANCE_ID)).toBeUndefined();
    expect(await lifecycle.closeIfIdle("current", INSTANCE_ID)).toBe(false);
    expect(api.close).not.toHaveBeenCalled();
  },
);

it.each(["resolve", "reject"])(
  "bounds the entire multi-step probe and retains a hung status call until late %s",
  async (outcome) => {
    vi.useFakeTimers();
    const { api, lifecycle } = fixture();
    const probe = defer<string>();
    api.getInstanceId.mockReturnValueOnce(probe.promise);
    const failed = lifecycle.identify(INSTANCE_ID).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(await failed).toBe("offscreen-identity-timeout");
    await expect(lifecycle.identify(OTHER_INSTANCE_ID)).rejects.toThrow(
      "offscreen-identity-timeout",
    );
    expect(api.getInstanceId).toHaveBeenCalledOnce();
    expect(api.getContexts).toHaveBeenCalledOnce();
    if (outcome === "resolve") probe.resolve(INSTANCE_ID);
    else probe.reject(new Error("late-probe-failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await lifecycle.identify(INSTANCE_ID)).toBe("current");
    expect(api.getInstanceId).toHaveBeenCalledTimes(2);
  },
);

it("rejects malformed caller markers without querying Chrome", async () => {
  const { api, lifecycle } = fixture();
  expect(await lifecycle.identify("invalid")).toBeUndefined();
  expect(await lifecycle.closeIfIdle("current", "invalid")).toBe(false);
  expect(api.getContexts).not.toHaveBeenCalled();
  expect(api.getInstanceId).not.toHaveBeenCalled();
  expect(api.close).not.toHaveBeenCalled();
});

it("shares one uncancellable identity query across timeouts and recovers after settlement", async () => {
  vi.useFakeTimers();
  const { api, lifecycle } = fixture();
  const query = defer<Array<{ documentId: string }>>();
  api.getContexts.mockReturnValueOnce(query.promise);
  const first = lifecycle.identify(INSTANCE_ID);
  const failed = expect(first).rejects.toThrow("offscreen-identity-timeout");
  await vi.advanceTimersByTimeAsync(5000);
  await failed;
  await expect(lifecycle.identify(INSTANCE_ID)).rejects.toThrow(
    "offscreen-identity-timeout",
  );
  expect(api.getContexts).toHaveBeenCalledOnce();
  query.resolve([context]);
  await vi.advanceTimersByTimeAsync(0);
  expect(await lifecycle.identify(INSTANCE_ID)).toBe("current");
  // The expired discovery stops before probing; only the fresh query has two reads.
  expect(api.getContexts).toHaveBeenCalledTimes(3);
  expect(api.getInstanceId).toHaveBeenCalledOnce();
});

it.each(["resolve", "reject"] as const)(
  "rediscovers a retiring document after background restart and late %s without reusing or closing it",
  async (outcome) => {
    vi.useFakeTimers();
    const { api, busy, lifecycle } = fixture();
    api.isRetiring.mockResolvedValue(true);
    const closing = defer<void>();
    api.close.mockReturnValue(closing.promise);
    const oldClose = lifecycle.closeIfIdle("current", INSTANCE_ID);
    const failed = expect(oldClose).rejects.toThrow(
      "offscreen-transition-timeout",
    );
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    const restarted = new OffscreenLifecycle(api, busy);
    const inference = vi.fn(async () => "new-document-result");
    const detected = restarted.withDocument(inference);
    await vi.advanceTimersByTimeAsync(300);
    expect(inference).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
    expect(api.close).toHaveBeenCalledOnce();
    if (outcome === "resolve") {
      api.getContexts.mockResolvedValue([]);
      closing.resolve();
      await vi.advanceTimersByTimeAsync(100);
      expect(await detected).toBe("new-document-result");
      expect(api.create).toHaveBeenCalledOnce();
    } else {
      const stopped = expect(detected).rejects.toThrow(
        "offscreen-transition-timeout",
      );
      closing.reject(new Error("late-close-failure"));
      await vi.advanceTimersByTimeAsync(5000);
      await stopped;
      expect(inference).not.toHaveBeenCalled();
      expect(api.create).not.toHaveBeenCalled();
    }
    expect(api.close).toHaveBeenCalledOnce();
  },
);

it("shares creation and holds an active lease through inference", async () => {
  const { api, lifecycle } = fixture();
  api.getContexts.mockResolvedValue([]);
  const creation = defer<void>(),
    inference = defer<string>();
  api.create.mockReturnValue(creation.promise);
  const first = lifecycle.withDocument(() => inference.promise);
  const second = lifecycle.withDocument(async () => "second");
  await vi.waitFor(() => expect(api.create).toHaveBeenCalledOnce());
  expect(await lifecycle.closeIfIdle("current", INSTANCE_ID)).toBe(null);
  creation.resolve();
  expect(await second).toBe("second");
  expect(await lifecycle.closeIfIdle("current", INSTANCE_ID)).toBe(false);
  inference.resolve("first");
  expect(await first).toBe("first");
});

it("serializes a new detection behind close and rediscovers the document", async () => {
  const { api, lifecycle } = fixture();
  const closing = defer<void>();
  api.close.mockReturnValue(closing.promise);
  const closed = lifecycle.closeIfIdle("current", INSTANCE_ID);
  await vi.waitFor(() => expect(api.close).toHaveBeenCalledOnce());
  expect(await lifecycle.closeIfIdle("current", INSTANCE_ID)).toBe(null);
  api.getContexts.mockResolvedValue([]);
  const infer = vi.fn(async () => "result");
  const detection = lifecycle.withDocument(infer);
  expect(api.create).not.toHaveBeenCalled();
  expect(infer).not.toHaveBeenCalled();
  closing.resolve();
  expect(await closed).toBe(true);
  expect(await detection).toBe("result");
  expect(api.create).toHaveBeenCalledOnce();
});

it("rejects stale documents and rechecks activity after context discovery", async () => {
  const { api, busy, lifecycle } = fixture();
  expect(await lifecycle.closeIfIdle("retired", INSTANCE_ID)).toBe(false);
  expect(api.close).not.toHaveBeenCalled();
  const discovery = defer<Array<{ documentId: string }>>();
  api.getContexts.mockReturnValue(discovery.promise);
  const closing = lifecycle.closeIfIdle("current", INSTANCE_ID);
  await Promise.resolve();
  busy.mockReturnValue(true);
  discovery.resolve([context]);
  expect(await closing).toBe(false);
  expect(api.close).not.toHaveBeenCalled();
});

it.each([
  ["create", "resolve"],
  ["create", "reject"],
  ["close", "resolve"],
  ["close", "reject"],
] as const)(
  "bounds a hung %s with late %s while retaining the real API lock",
  async (kind, outcome) => {
    vi.useFakeTimers();
    const { api, lifecycle } = fixture();
    const stuck = defer<void>();
    if (kind === "create") api.getContexts.mockResolvedValue([]);
    api[kind].mockReturnValue(stuck.promise);
    const request =
      kind === "create"
        ? lifecycle.withDocument(async () => "unused")
        : lifecycle.closeIfIdle("current", INSTANCE_ID);
    const failed = expect(request).rejects.toThrow(
      "offscreen-transition-timeout",
    );
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    await expect(lifecycle.withDocument(async () => "unused")).rejects.toThrow(
      "offscreen-transition-timeout",
    );
    expect(api[kind]).toHaveBeenCalledOnce();
    expect(await lifecycle.closeIfIdle("current", INSTANCE_ID)).toBe(null);
    if (outcome === "resolve") stuck.resolve();
    else stuck.reject(new Error("late-api-failure"));
    await vi.advanceTimersByTimeAsync(0);
    api.getContexts.mockResolvedValue([context]);
    expect(await lifecycle.withDocument(async () => "recovered")).toBe(
      "recovered",
    );
  },
);

it("recovers from failed creation, close and inference without losing the active lease", async () => {
  const { api, lifecycle } = fixture();
  api.getContexts.mockResolvedValueOnce([]);
  api.create.mockRejectedValueOnce(new Error("create-failed"));
  await expect(lifecycle.withDocument(async () => "unused")).rejects.toThrow(
    "create-failed",
  );
  api.close.mockRejectedValueOnce(new Error("close-failed"));
  await expect(lifecycle.closeIfIdle("current", INSTANCE_ID)).rejects.toThrow(
    "close-failed",
  );
  await expect(
    lifecycle.withDocument(async () => {
      throw new Error("inference-failed");
    }),
  ).rejects.toThrow("inference-failed");
  expect(await lifecycle.closeIfIdle("current", INSTANCE_ID)).toBe(true);
  expect(await lifecycle.withDocument(async () => "recovered")).toBe(
    "recovered",
  );
});
