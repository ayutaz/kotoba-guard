// @vitest-environment node

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { superviseChild } from "./audit_process_supervisor.mjs";

type ProcessRecord = {
  pid: number;
  parentPid: number;
  creationIdentity: string;
};

class FakeChild extends EventEmitter {
  readonly pid = 501;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

function snapshot(...records: ProcessRecord[]) {
  let call = 0;
  return async () => {
    call += 1;
    return call === 1 ? records : [];
  };
}

describe("audit process supervisor", () => {
  it("never invokes PID tree termination after observing root close", async () => {
    const child = new FakeChild();
    let observations = 0;
    let pidKills = 0;
    const result = await superviseChild({
      command: "fixture-parent",
      platform: "win32",
      timeoutMs: 10,
      cleanupTimeoutMs: 20,
      spawnImpl: () => child,
      snapshotImpl: async () => {
        observations++;
        if (observations === 2) child.emit("close", 0, null);
        return observations < 3
          ? [{ pid: 501, parentPid: 1, creationIdentity: "root" }]
          : [];
      },
      taskkillImpl: async () => {
        pidKills++;
      },
    });
    expect(result.exitKind).toBe("timeout");
    expect(result.accepted).toBe(false);
    expect(pidKills).toBe(0);
  });
  it("bounds a hanging observation and stops only the owned handle", async () => {
    const child = new FakeChild();
    let handleKills = 0;
    Object.assign(child, {
      kill: () => {
        handleKills++;
        child.emit("close", null, "SIGTERM");
      },
    });
    const result = await superviseChild({
      command: "fixture-parent",
      platform: "win32",
      timeoutMs: 10,
      cleanupTimeoutMs: 10,
      spawnImpl: () => child,
      snapshotImpl: () => new Promise(() => {}),
      taskkillImpl: async () => {
        throw Error("PID kill must not run without identity");
      },
    });
    expect(result.accepted).toBe(false);
    expect(result.cleanupVerified).toBe(false);
    expect(result.exitKind).toBe("timeout");
    expect(handleKills).toBe(1);
  }, 1000);
  it("does not repeat a denied CIM observation", async () => {
    const child = new FakeChild();
    let observations = 0;
    const result = await superviseChild({
      command: "fixture-parent",
      platform: "win32",
      spawnImpl: () => {
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      },
      snapshotImpl: async () => {
        observations++;
        throw Error("access denied");
      },
    });
    expect(result.accepted).toBe(false);
    expect(result.cleanupVerified).toBe(false);
    expect(observations).toBe(2);
  });
  it("rejects a new direct child observed after the parent has exited", async () => {
    const child = new FakeChild();
    let observations = 0;
    const result = await superviseChild({
      command: "fixture-parent",
      platform: "win32",
      spawnImpl: () => {
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      },
      snapshotImpl: async () =>
        ++observations === 1
          ? [{ pid: 501, parentPid: 1, creationIdentity: "root" }]
          : [{ pid: 503, parentPid: 501, creationIdentity: "late-child" }],
    });
    expect(result.afterSnapshot.map((row) => row.pid)).toEqual([503]);
    expect(result.accepted).toBe(false);
    expect(result.cleanupVerified).toBe(false);
  });
  it("records a successful normal exit and captured output", async () => {
    const child = new FakeChild();
    const resultPromise = superviseChild({
      command: "fixture-parent",
      args: [],
      platform: "win32",
      spawnImpl: () => {
        queueMicrotask(() => {
          child.stdout.write("ok\n");
          child.emit("close", 0, null);
        });
        return child;
      },
      snapshotImpl: snapshot(
        {
          pid: 501,
          parentPid: 1,
          creationIdentity: "created-a",
        },
        {
          pid: 502,
          parentPid: 501,
          creationIdentity: "created-child",
        },
        {
          pid: 999,
          parentPid: 1,
          creationIdentity: "unrelated",
        },
      ),
    });

    const result = await resultPromise;
    expect(result).toMatchObject({
      accepted: true,
      status: "passed",
      exitKind: "normal",
      exitCode: 0,
      stdout: "ok\n",
      cleanupVerified: true,
    });
    expect(result.beforeSnapshot.map((record) => record.pid)).toEqual([
      501, 502,
    ]);
  });

  it("rejects nonzero exits and preserves stderr", async () => {
    const child = new FakeChild();
    const result = await superviseChild({
      command: "fixture-parent",
      args: [],
      platform: "win32",
      spawnImpl: () => {
        queueMicrotask(() => {
          child.stderr.write("failed\n");
          child.emit("close", 7, null);
        });
        return child;
      },
      snapshotImpl: snapshot({
        pid: 501,
        parentPid: 1,
        creationIdentity: "created-a",
      }),
    });

    expect(result).toMatchObject({
      accepted: false,
      status: "failed",
      exitKind: "nonzero",
      exitCode: 7,
      stderr: "failed\n",
    });
  });

  it("uses one combined 8 MiB output budget and fails closed on truncation", async () => {
    const child = new FakeChild();
    const result = await superviseChild({
      command: "fixture-parent",
      args: [],
      platform: "win32",
      spawnImpl: () => {
        queueMicrotask(() => {
          child.stdout.write("x".repeat(8 * 1024 * 1024));
          child.stderr.write("y");
          child.emit("close", 0, null);
        });
        return child;
      },
      snapshotImpl: snapshot({
        pid: 501,
        parentPid: 1,
        creationIdentity: "created-a",
      }),
    });

    expect(result.accepted).toBe(false);
    expect(result.stdoutTruncated || result.stderrTruncated).toBe(true);
    expect(result.unknownReasons).toContain("stderr-truncated");
    expect(Buffer.byteLength(result.stdout + result.stderr)).toBe(
      8 * 1024 * 1024,
    );
  });

  it("detects a child that remains after the root exits", async () => {
    const child = new FakeChild();
    let calls = 0;
    const result = await superviseChild({
      command: "fixture-parent",
      args: [],
      platform: "win32",
      spawnImpl: () => {
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      },
      snapshotImpl: async () => {
        calls += 1;
        return calls === 1
          ? [
              { pid: 501, parentPid: 1, creationIdentity: "created-a" },
              { pid: 502, parentPid: 501, creationIdentity: "created-child" },
            ]
          : [{ pid: 502, parentPid: 501, creationIdentity: "created-child" }];
      },
    });

    expect(result.accepted).toBe(false);
    expect(result.cleanupVerified).toBe(false);
    expect(result.afterSnapshot.map((record) => record.pid)).toEqual([502]);
    expect(result.unknownReasons).toContain("cleanup-unverified");
  });

  it("tree-kills only an identity-matched owned root on timeout", async () => {
    const child = new FakeChild();
    let taskkillArgs: string[] | undefined;
    let snapshots = 0;
    const result = await superviseChild({
      command: "fixture-parent",
      args: [],
      platform: "win32",
      timeoutMs: 10,
      cleanupTimeoutMs: 50,
      spawnImpl: () => child,
      snapshotImpl: async () => {
        snapshots += 1;
        return snapshots <= 2
          ? [
              { pid: 501, parentPid: 1, creationIdentity: "created-a" },
              { pid: 502, parentPid: 501, creationIdentity: "created-child" },
            ]
          : [];
      },
      taskkillImpl: async (args) => {
        taskkillArgs = args;
        child.emit("close", null, "SIGTERM");
      },
    });

    expect(result).toMatchObject({
      accepted: false,
      status: "timeout",
      exitKind: "timeout",
      cleanupVerified: true,
    });
    expect(taskkillArgs).toEqual(["/PID", "501", "/T", "/F"]);
  });

  it("retains timeout-discovered descendants in cleanup verification", async () => {
    const child = new FakeChild();
    let snapshots = 0;
    const result = await superviseChild({
      command: "fixture-parent",
      args: [],
      platform: "win32",
      timeoutMs: 10,
      cleanupTimeoutMs: 20,
      spawnImpl: () => child,
      snapshotImpl: async () => {
        snapshots += 1;
        if (snapshots === 1)
          return [{ pid: 501, parentPid: 1, creationIdentity: "created-a" }];
        if (snapshots === 2)
          return [
            { pid: 501, parentPid: 1, creationIdentity: "created-a" },
            { pid: 503, parentPid: 501, creationIdentity: "late-child" },
          ];
        return [{ pid: 503, parentPid: 501, creationIdentity: "late-child" }];
      },
      taskkillImpl: async () => child.emit("close", null, "SIGTERM"),
    });

    expect(result.accepted).toBe(false);
    expect(result.timeoutSnapshot.map((record) => record.pid)).toEqual([
      501, 503,
    ]);
    expect(result.afterSnapshot.map((record) => record.pid)).toEqual([503]);
    expect(result.cleanupVerified).toBe(false);
  });

  it("fails closed when the root creation identity changes", async () => {
    const child = new FakeChild();
    let taskkillCalled = false;
    let snapshots = 0;
    const result = await superviseChild({
      command: "fixture-parent",
      args: [],
      platform: "win32",
      timeoutMs: 10,
      cleanupTimeoutMs: 20,
      spawnImpl: () => child,
      snapshotImpl: async () => {
        const records =
          snapshots === 0
            ? [{ pid: 501, parentPid: 1, creationIdentity: "created-a" }]
            : [{ pid: 501, parentPid: 1, creationIdentity: "reused-pid" }];
        snapshots += 1;
        return records;
      },
      taskkillImpl: async () => {
        taskkillCalled = true;
      },
    });

    expect(result).toMatchObject({
      accepted: false,
      status: "timeout",
      cleanupVerified: false,
    });
    expect(taskkillCalled).toBe(false);
    expect(result.unknownReasons).toContain("root-identity-mismatch");
  });

  it("reports unsupported platforms without spawning", async () => {
    let spawned = false;
    const result = await superviseChild({
      command: "fixture-parent",
      args: [],
      platform: "linux",
      spawnImpl: () => {
        spawned = true;
        return new FakeChild();
      },
    });

    expect(result).toMatchObject({
      accepted: false,
      status: "unsupported",
      unknownReasons: ["windows-only"],
    });
    expect(spawned).toBe(false);
  });
});
