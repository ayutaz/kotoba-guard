import { expect, it, vi } from "vitest";
import type { CDPSession } from "@playwright/test";
import { createModelWorkerObserver } from "../e2e/worker-targets";

it("keeps attachment failure observable without falling back or retrying", async () => {
  const id = "abcdefghijklmnopabcdefghijklmnop";
  let observation: unknown;
  const send = vi.fn(async (method: string) => {
    if (method === "Target.autoAttachRelated") throw new Error("unsupported");
    return {
      targetInfos: [
        {
          targetId: "parent",
          type: "page",
          url: `chrome-extension://${id}/offscreen.html`,
        },
      ],
    };
  });
  const observe = createModelWorkerObserver(
    { send } as unknown as Pick<CDPSession, "send">,
    id,
    (value) => {
      observation = value;
    },
  );
  await expect(observe()).rejects.toThrow("unsupported");
  expect(observation).toMatchObject({
    stage: "attaching-related",
    attachmentAttempts: 1,
    attachedParents: 0,
  });
  expect(send).toHaveBeenCalledTimes(2);
});

it("reports bounded classification metadata when a worker cannot be observed", async () => {
  const id = "abcdefghijklmnopabcdefghijklmnop";
  const observations: unknown[] = [];
  const send = vi.fn(async (method: string) => {
    if (method === "Target.autoAttachRelated") return {};
    return {
      targetInfos: [
        {
          targetId: "parent",
          type: "other",
          url: `chrome-extension://${id}/offscreen.html`,
        },
        { targetId: "hidden", type: "worker", url: "" },
        {
          targetId: "foreign",
          type: "page",
          url: "https://private.example/secret",
        },
      ],
    };
  });
  const observe = createModelWorkerObserver(
    { send } as unknown as Pick<CDPSession, "send">,
    id,
    (value) => observations.push(value),
  );
  expect(await observe()).toEqual([]);
  expect(observations).toEqual([
    {
      stage: "inventory",
      totalTargets: 3,
      ownedOffscreenTargets: 1,
      ownedWorkerTargets: 0,
      workersWithoutUrl: 1,
      attachmentAttempts: 0,
      attachedParents: 0,
    },
    {
      stage: "attaching-related",
      totalTargets: 3,
      ownedOffscreenTargets: 1,
      ownedWorkerTargets: 0,
      workersWithoutUrl: 1,
      attachmentAttempts: 1,
      attachedParents: 0,
    },
    {
      stage: "inventory",
      totalTargets: 3,
      ownedOffscreenTargets: 1,
      ownedWorkerTargets: 0,
      workersWithoutUrl: 1,
      attachmentAttempts: 1,
      attachedParents: 1,
    },
  ]);
  expect(JSON.stringify(observations)).not.toMatch(
    /private|secret|foreign|parent|hidden/,
  );
});

it("attaches the owned offscreen parent before matching a child URL and tracks replacement", async () => {
  const id = "abcdefghijklmnopabcdefghijklmnop";
  const parent = {
    targetId: "parent",
    type: "background_page",
    url: `chrome-extension://${id}/offscreen.html`,
  };
  const tab = { ...parent, targetId: "tab", type: "tab" };
  const foreign = {
    ...parent,
    targetId: "foreign",
    url: "chrome-extension://other/offscreen.html",
  };
  let attached = false;
  let worker: string | undefined = "first";
  const send = vi.fn(async (method: string) => {
    if (method === "Target.autoAttachRelated") {
      attached = true;
      return {};
    }
    return {
      targetInfos: [
        parent,
        tab,
        foreign,
        ...(worker
          ? [
              {
                targetId: worker,
                type: "worker",
                url: attached ? `chrome-extension://${id}/worker.js` : "",
              },
            ]
          : []),
      ],
    };
  });
  const observe = createModelWorkerObserver(
    { send } as unknown as Pick<CDPSession, "send">,
    id,
  );
  expect(await observe()).toEqual(["first"]);
  worker = undefined;
  expect(await observe()).toEqual([]);
  worker = "second";
  expect(await observe()).toEqual(["second"]);
  expect(
    send.mock.calls.filter(([method]) => method === "Target.autoAttachRelated"),
  ).toHaveLength(1);
  expect(send).toHaveBeenCalledWith("Target.autoAttachRelated", {
    targetId: "parent",
    waitForDebuggerOnStart: false,
    filter: [{}],
  });
});
