import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { parseLinuxProcessStatus } from "./browser_security_audit_helpers.mjs";

const execFileAsync = promisify(execFile);
const scope = "cdp-associated-browser-processes";
const unavailable = (reason) => ({
  status: "unavailable",
  scope,
  reason,
  rows: [],
  missingPids: [],
});

// The browser endpoint supplies its own process IDs. No process command lines,
// user input, or machine-wide process inventory enter the report or shell.
async function browserInventory(getProcessInfo) {
  let processInfo;
  try {
    ({ processInfo } = await getProcessInfo());
  } catch {
    return unavailable("browser-process-inventory-unavailable");
  }
  if (
    !Array.isArray(processInfo) ||
    processInfo.length === 0 ||
    processInfo.length > 256 ||
    !processInfo.some((row) => row?.type === "browser") ||
    processInfo.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        !Number.isSafeInteger(row.id) ||
        row.id <= 0 ||
        typeof row.type !== "string" ||
        row.type.length === 0 ||
        row.type.length > 128 ||
        Array.from(row.type).some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    ) ||
    new Set(processInfo.map((row) => row.id)).size !== processInfo.length
  )
    return unavailable("invalid-browser-process-inventory");
  return { processInfo };
}

/** @param {{ getProcessInfo: () => Promise<{ processInfo: unknown }>, execute?: (file: string, args: string[], options: object) => Promise<{ stdout: string }>, powershell?: string }} options */
export async function sampleWindowsBrowserMemory({
  getProcessInfo,
  execute = execFileAsync,
  powershell = "powershell.exe",
}) {
  if (!["powershell.exe", "pwsh.exe"].includes(powershell))
    return unavailable("unsupported-powershell-executable");
  const inventory = await browserInventory(getProcessInfo);
  if ("status" in inventory) return inventory;
  const { processInfo } = inventory;

  const requested = new Map(processInfo.map((row) => [row.id, row.type]));
  const command = `Get-Process -Id ${[...requested.keys()].join(",")} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PeakWorkingSet64 | ConvertTo-Json -Compress`;
  let raw;
  try {
    const { stdout } = await execute(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    );
    raw = JSON.parse(stdout || "[]");
  } catch (error) {
    return {
      ...unavailable(
        error?.killed ? "os-memory-query-timeout" : "os-memory-query-failed",
      ),
      ...(Number.isSafeInteger(error?.code)
        ? { queryExitCode: error.code }
        : {}),
    };
  }
  const observed = Array.isArray(raw) ? raw : [raw];
  const rows = [];
  const seen = new Set();
  for (const item of observed) {
    if (
      !item ||
      !requested.has(item.Id) ||
      seen.has(item.Id) ||
      !Number.isSafeInteger(item.WorkingSet64) ||
      item.WorkingSet64 <= 0 ||
      !Number.isSafeInteger(item.PeakWorkingSet64) ||
      item.PeakWorkingSet64 < item.WorkingSet64
    )
      return unavailable("invalid-os-memory-snapshot");
    seen.add(item.Id);
    rows.push({
      pid: item.Id,
      role: requested.get(item.Id),
      currentBytes: item.WorkingSet64,
      peakBytes: item.PeakWorkingSet64,
    });
  }
  const missingPids = [...requested.keys()].filter((pid) => !seen.has(pid));
  return {
    status:
      rows.length === 0
        ? "unavailable"
        : missingPids.length
          ? "partial"
          : "measured",
    scope,
    rows,
    missingPids,
    requestedProcessCount: requested.size,
    ...(missingPids.length ? { reason: "process-exited-or-inaccessible" } : {}),
  };
}

/** @param {{ getProcessInfo: () => Promise<{ processInfo: unknown }>, readStatus?: (path: string) => Promise<string> }} options */
export async function sampleLinuxBrowserMemory({
  getProcessInfo,
  readStatus = (path) => readFile(path, "utf8"),
}) {
  const inventory = await browserInventory(getProcessInfo);
  if ("status" in inventory) return inventory;
  const rows = [];
  const missingPids = [];
  for (const info of inventory.processInfo) {
    try {
      const text = await readStatus(`/proc/${info.id}/status`);
      const value = parseLinuxProcessStatus(text);
      if (
        !/^VmRSS:/m.test(text) ||
        !/^VmHWM:/m.test(text) ||
        value.parentPid === undefined ||
        value.currentBytes <= 0 ||
        value.peakBytes < value.currentBytes
      )
        throw new Error("missing-memory-metrics");
      rows.push({ pid: info.id, role: info.type, ...value });
    } catch {
      missingPids.push(info.id);
    }
  }
  return {
    status:
      rows.length === 0
        ? "unavailable"
        : missingPids.length
          ? "partial"
          : "measured",
    scope,
    rows,
    missingPids,
    requestedProcessCount: inventory.processInfo.length,
    ...(missingPids.length ? { reason: "process-exited-or-inaccessible" } : {}),
  };
}
