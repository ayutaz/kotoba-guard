import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { CDPSession } from "@playwright/test";
import { ScopedWorkerObserver } from "../e2e/scoped-worker-observer";

const owner = "abcdefghijklmnopabcdefghijklmnop";
type Root = Pick<CDPSession, "send" | "on" | "off">;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(
  options: {
    ackError?: boolean;
    omitChild?: boolean;
    attachError?: boolean;
    query?: ReturnType<typeof deferred<{ targetInfos: Target[] }>>;
    attach?: ReturnType<typeof deferred<{ sessionId: string }>>;
    ack?: ReturnType<typeof deferred<void>>;
  } = {},
) {
  const events = new EventEmitter();
  let generation = 1;
  let parents: Target[] = [parent(1)];
  const emit = (message: unknown, sessionId = `parent-session-${generation}`) =>
    events.emit("Target.receivedMessageFromTarget", {
      sessionId,
      message: JSON.stringify(message),
    });
  const child = (
    id = `worker-${generation}`,
    sessionId = `child-${generation}`,
  ) => ({
    method: "Target.attachedToTarget",
    params: {
      sessionId,
      waitingForDebugger: false,
      targetInfo: {
        targetId: id,
        type: "worker",
        url: `chrome-extension://${owner}/worker.js`,
      },
    },
  });
  const send = vi.fn(
    async (method: string, params?: Record<string, unknown>) => {
      if (method === "Target.getTargets")
        return options.query ? options.query.promise : { targetInfos: parents };
      if (method === "Target.attachToTarget") {
        if (options.attachError) throw new Error("private attach error");
        return options.attach
          ? options.attach.promise
          : { sessionId: `parent-session-${generation}` };
      }
      if (method === "Target.sendMessageToTarget") {
        const request = JSON.parse(params!.message as string);
        if (!options.omitChild) emit(child());
        if (options.ack) await options.ack.promise;
        emit(
          options.ackError
            ? { id: request.id, error: { message: "private protocol error" } }
            : { id: request.id, result: {} },
        );
        return {};
      }
      if (method === "Target.detachFromTarget") return {};
      throw new Error("unexpected method");
    },
  );
  return {
    root: Object.assign(events, { send }) as unknown as Root,
    events,
    send,
    emit,
    child,
    setParents: (value: Target[]) => {
      parents = value;
    },
    setGeneration: (n: number) => {
      generation = n;
      parents = [parent(n)];
    },
  };
}
type Target = { targetId: string; type: string; url: string };
function parent(n: number): Target {
  return {
    targetId: `parent-${n}`,
    type: "page",
    url: `chrome-extension://${owner}/offscreen.html`,
  };
}
afterEach(() => vi.useRealTimers());

it("does not equate an acknowledged parent without child evidence to zero Workers", async () => {
  const f = fixture({ omitChild: true });
  const observer = new ScopedWorkerObserver(f.root, owner);
  await expect(observer.observe()).rejects.toThrow();
  expect(observer.metadata().status).toBe("unavailable");
  f.emit(f.child());
  expect(await observer.observe()).toEqual(["worker-1"]);
  await observer.dispose();
});

it("publishes confirmed absence only after a successful parent inventory", async () => {
  const f = fixture();
  f.setParents([]);
  const observer = new ScopedWorkerObserver(f.root, owner);
  expect(observer.metadata().status).toBe("unavailable");
  expect(await observer.observe()).toEqual([]);
  expect(observer.metadata()).toMatchObject({
    status: "complete",
    parentBound: false,
    workers: 0,
  });
  f.events.emit("Target.targetCreated", { targetInfo: parent(1) });
  expect(observer.metadata().status).toBe("unavailable");
  await observer.dispose();
});
it("rejects an empty inventory crossed by an owned parent creation", async () => {
  const query = deferred<{ targetInfos: Target[] }>();
  const f = fixture({ query });
  const observer = new ScopedWorkerObserver(f.root, owner);
  const assertion = expect(observer.observe()).rejects.toThrow();
  await Promise.resolve();
  f.events.emit("Target.targetCreated", { targetInfo: parent(1) });
  query.resolve({ targetInfos: [] });
  await assertion;
  expect(observer.metadata().status).toBe("unavailable");
  await observer.dispose();
});

it("uses a parent-owned child notification when root inventory omits Workers", async () => {
  const f = fixture();
  const observer = new ScopedWorkerObserver(f.root, owner);
  expect(await observer.observe()).toEqual(["worker-1"]);
  expect(f.send).toHaveBeenCalledWith("Target.attachToTarget", {
    targetId: "parent-1",
    flatten: false,
  });
  const request = JSON.parse(
    f.send.mock.calls.find(([m]) => m === "Target.sendMessageToTarget")![1]!
      .message as string,
  );
  expect(request).toMatchObject({
    method: "Target.setAutoAttach",
    params: {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: false,
      filter: [{ type: "worker" }, { exclude: true }],
    },
  });
  expect(observer.metadata()).toMatchObject({
    status: "complete",
    parentBound: true,
    workers: 1,
  });
  await observer.dispose();
  expect(observer.metadata()).toMatchObject({
    status: "closed",
    parentBound: false,
    workers: 0,
    pendingCommands: 0,
    ownedParentSessions: 0,
  });
});
it("does not expose provisional child events before the parent acknowledgement", async () => {
  const ack = deferred<void>();
  const f = fixture({ ack });
  const observer = new ScopedWorkerObserver(f.root, owner);
  const observing = observer.observe();
  await vi.waitFor(() =>
    expect(
      f.send.mock.calls.some(([m]) => m === "Target.sendMessageToTarget"),
    ).toBe(true),
  );
  expect(observer.metadata()).toMatchObject({
    status: "unavailable",
    workers: 0,
    parentBound: false,
  });
  ack.resolve();
  expect(await observing).toEqual(["worker-1"]);
  await observer.dispose();
});
it("withholds acknowledged child events until parent postflight completes", async () => {
  const f = fixture();
  const postflight = deferred<{ targetInfos: Target[] }>();
  const original = f.send.getMockImplementation()!;
  let inventories = 0;
  f.send.mockImplementation(async (method, params) => {
    if (method === "Target.getTargets" && ++inventories === 2)
      return postflight.promise;
    return original(method, params);
  });
  const observer = new ScopedWorkerObserver(f.root, owner);
  const observing = observer.observe();
  await vi.waitFor(() => expect(inventories).toBe(2));
  expect(observer.metadata()).toMatchObject({
    status: "unavailable",
    parentBound: false,
    workers: 0,
  });
  postflight.resolve({ targetInfos: [parent(1)] });
  expect(await observing).toEqual(["worker-1"]);
  await observer.dispose();
});
it("invalidates a parent destroyed before attachment returns", async () => {
  const attach = deferred<{ sessionId: string }>();
  const f = fixture({ attach });
  const observer = new ScopedWorkerObserver(f.root, owner);
  const observing = observer.observe();
  const assertion = expect(observing).rejects.toThrow();
  await vi.waitFor(() =>
    expect(f.send).toHaveBeenCalledWith(
      "Target.attachToTarget",
      expect.anything(),
    ),
  );
  f.events.emit("Target.targetDestroyed", { targetId: "parent-1" });
  f.setParents([]);
  attach.resolve({ sessionId: "dead-parent-session" });
  await assertion;
  expect(
    f.send.mock.calls.filter(([m]) => m === "Target.sendMessageToTarget"),
  ).toHaveLength(0);
  expect(await observer.observe()).toEqual([]);
  await observer.dispose();
  expect(f.send).toHaveBeenCalledWith("Target.detachFromTarget", {
    sessionId: "dead-parent-session",
  });
});
it("deduplicates notifications and rejects foreign parent sessions", async () => {
  const f = fixture();
  const observer = new ScopedWorkerObserver(f.root, owner);
  await observer.observe();
  f.emit(f.child());
  f.emit(f.child("foreign-worker"), "foreign-parent");
  expect(await observer.observe()).toEqual(["worker-1"]);
  expect(JSON.stringify(observer.metadata())).not.toMatch(
    /foreign|chrome-extension|parent-session/,
  );
  await observer.dispose();
});
it("removes destroyed Workers without inferring destruction from detach", async () => {
  const f = fixture();
  const observer = new ScopedWorkerObserver(f.root, owner);
  await observer.observe();
  f.emit({
    method: "Target.detachedFromTarget",
    params: { sessionId: "child-1" },
  });
  await expect(observer.observe()).rejects.toThrow(/unavailable/i);
  f.events.emit("Target.targetDestroyed", { targetId: "worker-1" });
  expect(await observer.observe()).toEqual([]);
  f.emit(f.child());
  expect(await observer.observe()).toEqual([]);
  await observer.dispose();
});
it("binds replacement generations and ignores late notifications from the old parent", async () => {
  const f = fixture();
  const observer = new ScopedWorkerObserver(f.root, owner);
  await observer.observe();
  f.events.emit("Target.targetDestroyed", { targetId: "parent-1" });
  f.setGeneration(2);
  expect(await observer.observe()).toEqual(["worker-2"]);
  f.emit(f.child("late-unknown-worker"), "parent-session-1");
  expect(await observer.observe()).toEqual(["worker-2"]);
  await observer.dispose();
});
it("returns zero only after the owned parent is confirmed absent", async () => {
  const f = fixture();
  const observer = new ScopedWorkerObserver(f.root, owner);
  await observer.observe();
  f.events.emit("Target.detachedFromTarget", {
    sessionId: "parent-session-1",
    targetId: "parent-1",
  });
  await expect(observer.observe()).rejects.toThrow(/unavailable/i);
  f.setParents([]);
  expect(await observer.observe()).toEqual([]);
  expect(observer.metadata()).toMatchObject({
    status: "complete",
    parentBound: false,
    workers: 0,
  });
  await observer.dispose();
});
it("fails closed on parent URL changes while its target still exists", async () => {
  const f = fixture();
  const observer = new ScopedWorkerObserver(f.root, owner);
  await observer.observe();
  const changed = { ...parent(1), url: "https://private.example/secret" };
  f.setParents([changed]);
  f.events.emit("Target.targetInfoChanged", { targetInfo: changed });
  await expect(observer.observe()).rejects.toThrow(/unavailable/i);
  f.events.emit("Target.targetDestroyed", { targetId: "parent-1" });
  f.setParents([]);
  expect(await observer.observe()).toEqual([]);
  expect(observer.metadata()).toMatchObject({
    status: "complete",
    parentBound: false,
    workers: 0,
  });
  await observer.dispose();
});
it("shares concurrent observations rather than queueing duplicate parent attachments", async () => {
  const f = fixture();
  const observer = new ScopedWorkerObserver(f.root, owner);
  const first = observer.observe();
  const second = observer.observe();
  expect(second).toBe(first);
  expect(await first).toEqual(["worker-1"]);
  expect(
    f.send.mock.calls.filter(([m]) => m === "Target.attachToTarget"),
  ).toHaveLength(1);
  await observer.dispose();
});
it("invalidates an established binding when a second owned parent is created", async () => {
  const f = fixture();
  const observer = new ScopedWorkerObserver(f.root, owner);
  await observer.observe();
  f.events.emit("Target.targetCreated", { targetInfo: parent(2) });
  expect(observer.metadata().status).toBe("unavailable");
  await expect(observer.observe()).rejects.toThrow();
  await observer.dispose();
});
it("discards provisional child events when the parent command fails", async () => {
  const f = fixture({ ackError: true });
  const observer = new ScopedWorkerObserver(f.root, owner);
  await expect(observer.observe()).rejects.toThrow();
  expect(observer.metadata()).toMatchObject({
    status: "unavailable",
    workers: 0,
  });
  await observer.dispose();
});
it("does not retry a failed parent attachment", async () => {
  const f = fixture({ attachError: true });
  const observer = new ScopedWorkerObserver(f.root, owner);
  await expect(observer.observe()).rejects.toThrow();
  await expect(observer.observe()).rejects.toThrow();
  expect(
    f.send.mock.calls.filter(([m]) => m === "Target.attachToTarget"),
  ).toHaveLength(1);
  await observer.dispose();
});
it("invalidates pending inventory on disposal without starting an attachment", async () => {
  const query = deferred<{ targetInfos: Target[] }>();
  const f = fixture({ query });
  const observer = new ScopedWorkerObserver(f.root, owner);
  const observation = observer.observe();
  const assertion = expect(observation).rejects.toThrow();
  await Promise.resolve();
  const closing = observer.dispose();
  query.resolve({ targetInfos: [parent(1)] });
  await assertion;
  await closing;
  expect(
    f.send.mock.calls.filter(([m]) => m === "Target.attachToTarget"),
  ).toHaveLength(0);
  expect(f.events.eventNames()).toHaveLength(0);
});
it("cleans up a late parent attachment after disposal and never enables child tracking", async () => {
  const attached = deferred<{ sessionId: string }>();
  const f = fixture({ attach: attached });
  const observer = new ScopedWorkerObserver(f.root, owner);
  const observation = observer.observe();
  const assertion = expect(observation).rejects.toThrow();
  await vi.waitFor(() =>
    expect(f.send).toHaveBeenCalledWith(
      "Target.attachToTarget",
      expect.anything(),
    ),
  );
  const closing = observer.dispose();
  attached.resolve({ sessionId: "late-parent-session" });
  await assertion;
  await closing;
  expect(f.send).toHaveBeenCalledWith("Target.detachFromTarget", {
    sessionId: "late-parent-session",
  });
  expect(
    f.send.mock.calls.filter(([m]) => m === "Target.sendMessageToTarget"),
  ).toHaveLength(0);
});
it("still detaches an attachment resolving after the disposal deadline", async () => {
  vi.useFakeTimers();
  const attach = deferred<{ sessionId: string }>();
  const f = fixture({ attach });
  const observer = new ScopedWorkerObserver(f.root, owner);
  const observed = expect(observer.observe()).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1);
  const closed = expect(observer.dispose()).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(5000);
  await Promise.all([observed, closed]);
  attach.resolve({ sessionId: "after-deadline-session" });
  await vi.advanceTimersByTimeAsync(1);
  expect(f.send).toHaveBeenCalledWith("Target.detachFromTarget", {
    sessionId: "after-deadline-session",
  });
  expect(observer.metadata()).toMatchObject({
    status: "closed",
    parentBound: false,
    workers: 0,
    ownedParentSessions: 0,
    pendingCommands: 0,
  });
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds an uncancellable query and refuses duplicate queries after timeout", async () => {
  vi.useFakeTimers();
  const query = deferred<{ targetInfos: Target[] }>();
  const f = fixture({ query });
  const observer = new ScopedWorkerObserver(f.root, owner);
  const assertion = expect(observer.observe()).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(5000);
  await assertion;
  await expect(observer.observe()).rejects.toThrow();
  expect(f.send).toHaveBeenCalledTimes(1);
  query.resolve({ targetInfos: [] });
  await observer.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("attempts known session detach even when another raw query never settles", async () => {
  const f = fixture();
  const observer = new ScopedWorkerObserver(f.root, owner);
  await observer.observe();
  vi.useFakeTimers();
  const query = deferred<{ targetInfos: Target[] }>();
  const original = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (method, params) =>
    method === "Target.getTargets" ? query.promise : original(method, params),
  );
  const observed = expect(observer.observe()).rejects.toThrow();
  await Promise.resolve();
  const closing = expect(observer.dispose()).rejects.toThrow();
  await Promise.resolve();
  expect(f.send).toHaveBeenCalledWith("Target.detachFromTarget", {
    sessionId: "parent-session-1",
  });
  await vi.advanceTimersByTimeAsync(5000);
  await Promise.all([observed, closing]);
  query.resolve({ targetInfos: [] });
  await Promise.resolve();
});
it("fails closed on CDP disconnection and ignores later child messages", async () => {
  const f = fixture();
  const observer = new ScopedWorkerObserver(f.root, owner);
  await observer.observe();
  f.events.emit("close", f.root);
  f.emit(f.child("late"));
  await expect(observer.observe()).rejects.toThrow();
  expect(observer.metadata().workers).toBe(0);
  await observer.dispose();
  expect(f.events.eventNames()).toHaveLength(0);
});
