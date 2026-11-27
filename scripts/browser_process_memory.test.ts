import { describe, expect, it } from "vitest";
import {
  sampleWindowsBrowserMemory,
  sampleLinuxBrowserMemory,
} from "./browser_process_memory.mjs";
import { startProcessSampler } from "./browser_security_audit.mjs";

it("waits for the initial process snapshot before exposing a running sampler", async () => {
  let releaseInitial: () => void = () => {
    throw new Error("initial sample not started");
  };
  const first = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  const samples: Array<{ label: string; durationMs: number }> = [];
  let calls = 0;
  let ready = false;
  const starting = startProcessSampler("unused-profile", samples, undefined, {
    sampleMemory: async () => {
      calls++;
      if (calls === 1) await first;
      return { rows: [], status: "unavailable", reason: "test-no-processes" };
    },
  }).then((stop: () => Promise<void>) => {
    ready = true;
    return stop;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(samples).toEqual([]);
  releaseInitial();
  const stop = await starting;
  try {
    expect(samples.map((sample) => sample.label)).toEqual(["initial"]);
    expect(samples[0]?.durationMs).toBeGreaterThanOrEqual(0);
  } finally {
    await stop();
  }
  expect(samples.map((sample) => sample.label)).toEqual(["initial", "final"]);
});

describe("Windows isolated browser process memory", () => {
  const processInfo = [
    { id: 100, type: "browser", cpuTime: 1 },
    { id: 101, type: "network.mojom.NetworkService", cpuTime: 0.5 },
  ];
  it("supports an explicitly selected PowerShell 7 executable without changing metrics", async () => {
    let executable = "";
    const report = await sampleWindowsBrowserMemory({
      powershell: "pwsh.exe",
      getProcessInfo: async () => ({ processInfo: [processInfo[0]] }),
      execute: async (file: string) => {
        executable = file;
        return {
          stdout: JSON.stringify({
            Id: 100,
            WorkingSet64: 4096,
            PeakWorkingSet64: 8192,
          }),
        };
      },
    });
    expect(executable).toBe("pwsh.exe");
    expect(report.status).toBe("measured");
    expect(report.rows[0]?.currentBytes).toBe(4096);
  });
  it("rejects an arbitrary sampler executable before running it", async () => {
    let executed = false;
    const report = await sampleWindowsBrowserMemory({
      powershell: "untrusted.exe",
      getProcessInfo: async () => ({ processInfo }),
      execute: async () => {
        executed = true;
        return { stdout: "[]" };
      },
    });
    expect(executed).toBe(false);
    expect(report.status).toBe("unavailable");
  });

  it("queries only browser-reported PIDs and keeps byte units", async () => {
    let command = "";
    const report = await sampleWindowsBrowserMemory({
      getProcessInfo: async () => ({ processInfo }),
      execute: async (_file: string, args: string[]) => {
        command = args.at(-1) ?? "";
        return {
          stdout: JSON.stringify([
            { Id: 100, WorkingSet64: 4096, PeakWorkingSet64: 8192 },
            { Id: 101, WorkingSet64: 1024, PeakWorkingSet64: 2048 },
          ]),
        };
      },
    });
    expect(report.status).toBe("measured");
    expect(report.rows).toEqual([
      { pid: 100, role: "browser", currentBytes: 4096, peakBytes: 8192 },
      {
        pid: 101,
        role: "network.mojom.NetworkService",
        currentBytes: 1024,
        peakBytes: 2048,
      },
    ]);
    expect(command).toContain("Get-Process -Id 100,101");
    expect(command).not.toMatch(/CimInstance|CommandLine/);
  });

  it("reports a disappearing process as partial instead of zero memory", async () => {
    const report = await sampleWindowsBrowserMemory({
      getProcessInfo: async () => ({ processInfo }),
      execute: async () => ({
        stdout: JSON.stringify({
          Id: 100,
          WorkingSet64: 4096,
          PeakWorkingSet64: 8192,
        }),
      }),
    });
    expect(report.status).toBe("partial");
    expect(report.missingPids).toEqual([101]);
    expect(report.rows).toHaveLength(1);
  });

  it.each([
    { processInfo: [] },
    { processInfo: [null, { id: 100, type: "browser" }] },
    {
      processInfo: [
        { id: 100, type: "browser" },
        { id: 101, type: "invalid\nrole" },
      ],
    },
    { processInfo: [{ id: -1, type: "browser" }] },
    { processInfo: [{ id: "100; secret", type: "browser" }] },
    { processInfo: [{ id: 100, type: "renderer" }] },
    {
      processInfo: [
        { id: 100, type: "browser" },
        { id: 100, type: "renderer" },
      ],
    },
  ])(
    "rejects invalid or unbound PID inventories before shell execution",
    async ({ processInfo }) => {
      let executed = false;
      const report = await sampleWindowsBrowserMemory({
        getProcessInfo: async () => ({ processInfo }),
        execute: async () => {
          executed = true;
          return { stdout: "[]" };
        },
      });
      expect(report.status).toBe("unavailable");
      expect(executed).toBe(false);
    },
  );

  it.each([
    { rows: [{ Id: 999, WorkingSet64: 1, PeakWorkingSet64: 2 }] },
    { rows: [{ Id: 100, WorkingSet64: -1, PeakWorkingSet64: 2 }] },
    { rows: [{ Id: 100, WorkingSet64: 4096, PeakWorkingSet64: 1024 }] },
  ])("rejects unrequested PIDs and invalid memory values", async ({ rows }) => {
    const report = await sampleWindowsBrowserMemory({
      getProcessInfo: async () => ({ processInfo }),
      execute: async () => ({ stdout: JSON.stringify(rows) }),
    });
    expect(report.status).toBe("unavailable");
    expect(report.rows).toEqual([]);
  });

  it("retains only a fixed reason when OS sampling fails", async () => {
    const report = await sampleWindowsBrowserMemory({
      getProcessInfo: async () => ({ processInfo }),
      execute: async () => {
        throw new Error("private command line");
      },
    });
    expect(report.status).toBe("unavailable");
    expect(report.reason).toBe("os-memory-query-failed");
    expect(JSON.stringify(report)).not.toContain("private");
  });
});

describe("Linux browser process memory completeness", () => {
  const inventory = async () => ({
    processInfo: [
      { id: 100, type: "browser" },
      { id: 101, type: "renderer" },
    ],
  });
  const status = "PPid:\t1\nVmRSS:\t2 kB\nVmHWM:\t3 kB\n";

  it("measures only the browser inventory and preserves process parents", async () => {
    const requested: string[] = [];
    const result = await sampleLinuxBrowserMemory({
      getProcessInfo: inventory,
      readStatus: async (path: string) => {
        requested.push(path);
        return status;
      },
    });
    expect(result.status).toBe("measured");
    expect(requested.sort()).toEqual(["/proc/100/status", "/proc/101/status"]);
    expect(result.rows).toEqual([
      {
        pid: 100,
        parentPid: 1,
        role: "browser",
        currentBytes: 2048,
        peakBytes: 3072,
      },
      {
        pid: 101,
        parentPid: 1,
        role: "renderer",
        currentBytes: 2048,
        peakBytes: 3072,
      },
    ]);
  });

  it("marks a disappeared known browser child partial", async () => {
    const result = await sampleLinuxBrowserMemory({
      getProcessInfo: inventory,
      readStatus: async (path: string) => {
        if (path.includes("101")) throw new Error("exited");
        return status;
      },
    });
    expect(result.status).toBe("partial");
    expect(result.missingPids).toEqual([101]);
    expect(result.rows).toHaveLength(1);
  });

  it("does not convert missing RSS/HWM fields to a measured zero", async () => {
    const result = await sampleLinuxBrowserMemory({
      getProcessInfo: inventory,
      readStatus: async () => "PPid:\t1\n",
    });
    expect(result.status).toBe("unavailable");
    expect(result.rows).toEqual([]);
    expect(result.missingPids).toEqual([100, 101]);
  });
});
