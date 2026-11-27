import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * @typedef {{pid: number, parentPid: number, creationIdentity: string}} ProcessRecord
 * @typedef {object} SupervisorResult
 * @property {boolean} accepted
 * @property {"passed"|"failed"|"timeout"|"unsupported"} status
 * @property {"normal"|"nonzero"|"signal"|"timeout"|"spawn-error"|"unsupported"} exitKind
 * @property {number|null} exitCode
 * @property {string|null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} stdoutTruncated
 * @property {boolean} stderrTruncated
 * @property {number} timeoutMs
 * @property {number|null} pid
 * @property {string|null} creationIdentity
 * @property {ProcessRecord[]} beforeSnapshot
 * @property {ProcessRecord[]} timeoutSnapshot
 * @property {ProcessRecord[]} afterSnapshot
 * @property {boolean} cleanupVerified
 * @property {string[]} unknownReasons
 */

function outputBuffers() {
  let remaining = MAX_OUTPUT_BYTES;
  const makeBuffer = () => {
    let value = "";
    let truncated = false;
    return {
      append(chunk) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        const bytes = Buffer.from(text);
        if (bytes.length > remaining) {
          value += bytes.subarray(0, remaining).toString();
          remaining = 0;
          truncated = true;
        } else {
          value += text;
          remaining -= bytes.length;
        }
      },
      value() {
        return value;
      },
      truncated() {
        return truncated;
      },
    };
  };
  return { stdout: makeBuffer(), stderr: makeBuffer() };
}

async function windowsSnapshot({
  timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
} = {}) {
  const script =
    "$ErrorActionPreference = 'Stop'; " +
    "$rows = Get-CimInstance Win32_Process -ErrorAction Stop | " +
    "Select-Object ProcessId,ParentProcessId,CreationDate; " +
    "if ($null -eq $rows) { '[]' } else { $rows | ConvertTo-Json -Compress }";
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(stdout.trim() || "[]");
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => {
    const pid = Number(row.ProcessId);
    const parentPid = Number(row.ParentProcessId);
    const creationIdentity = String(row.CreationDate ?? "");
    if (
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(parentPid) ||
      creationIdentity.length === 0
    )
      throw new Error("invalid CIM process snapshot");
    return { pid, parentPid, creationIdentity };
  });
}

function identity(record) {
  return `${record.pid}:${record.creationIdentity}`;
}

function normalizeSnapshot(records) {
  if (!Array.isArray(records))
    throw new Error("process snapshot must be an array");
  return records.map((record) => {
    if (
      !record ||
      !Number.isSafeInteger(record.pid) ||
      !Number.isSafeInteger(record.parentPid) ||
      typeof record.creationIdentity !== "string" ||
      record.creationIdentity.length === 0
    )
      throw new Error("invalid process snapshot record");
    return {
      pid: record.pid,
      parentPid: record.parentPid,
      creationIdentity: record.creationIdentity,
    };
  });
}

function processTree(records, rootPid) {
  const byParent = new Map();
  for (const record of records) {
    const children = byParent.get(record.parentPid) ?? [];
    children.push(record);
    byParent.set(record.parentPid, children);
  }
  const root = records.find((record) => record.pid === rootPid);
  if (!root) return [];
  const result = [];
  const pending = [rootPid];
  const seen = new Set();
  while (pending.length > 0) {
    const parentPid = pending.shift();
    if (seen.has(parentPid)) continue;
    seen.add(parentPid);
    for (const record of records.filter(
      (candidate) => candidate.pid === parentPid,
    )) {
      result.push(record);
      for (const child of byParent.get(record.pid) ?? [])
        pending.push(child.pid);
    }
  }
  return result;
}

function observedOwnedTree(records, rootPid, knownRecords) {
  const tree = processTree(records, rootPid);
  const knownIdentities = new Set(
    knownRecords.map((record) => identity(record)),
  );
  const knownPids = new Set(knownRecords.map((record) => record.pid));
  const selected = new Map(tree.map((record) => [identity(record), record]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (
        knownIdentities.has(identity(record)) ||
        knownPids.has(record.parentPid) ||
        [...selected.values()].some((parent) => parent.pid === record.parentPid)
      ) {
        const key = identity(record);
        if (!selected.has(key)) {
          selected.set(key, record);
          changed = true;
        }
      }
    }
  }
  return [...selected.values()];
}

function addUnknown(unknownReasons, reason) {
  if (!unknownReasons.includes(reason)) unknownReasons.push(reason);
}

async function boundedOperation(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(
          () => reject(new Error("observation-deadline-exceeded")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function safeSnapshot(
  snapshotImpl,
  unknownReasons,
  timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
) {
  try {
    return normalizeSnapshot(
      await boundedOperation(() => snapshotImpl({ timeoutMs }), timeoutMs),
    );
  } catch (error) {
    addUnknown(
      unknownReasons,
      `snapshot-error:${error instanceof Error ? error.message : "unknown"}`,
    );
    return [];
  }
}

function resultBase(timeoutMs, platform) {
  return {
    accepted: false,
    status: platform === "win32" ? "failed" : "unsupported",
    exitKind: platform === "win32" ? "spawn-error" : "unsupported",
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timeoutMs,
    pid: null,
    creationIdentity: null,
    beforeSnapshot: [],
    timeoutSnapshot: [],
    afterSnapshot: [],
    cleanupVerified: false,
    unknownReasons: platform === "win32" ? [] : ["windows-only"],
  };
}

/**
 * Run a newly spawned Windows process with identity-bound timeout cleanup.
 * @param {object} options
 * @param {string} options.command
 * @param {string[]} [options.args]
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.cleanupTimeoutMs]
 * @param {string} [options.platform]
 * @param {(command: string, args: string[], options: object) => any} [options.spawnImpl]
 * @param {() => Promise<ProcessRecord[]>} [options.snapshotImpl]
 * @param {(args: string[], options?: {timeout: number}) => Promise<unknown>} [options.taskkillImpl]
 * @returns {Promise<SupervisorResult>}
 */
export async function superviseChild({
  command,
  args = [],
  cwd,
  env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
  platform = process.platform,
  spawnImpl = spawn,
  snapshotImpl = windowsSnapshot,
  taskkillImpl = async (taskkillArgs) => {
    await execFileAsync("taskkill.exe", taskkillArgs, {
      encoding: "utf8",
      windowsHide: true,
      timeout: cleanupTimeoutMs,
    });
  },
}) {
  const result = resultBase(timeoutMs, platform);
  if (platform !== "win32") return result;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(cleanupTimeoutMs) ||
    cleanupTimeoutMs <= 0
  ) {
    result.unknownReasons.push("invalid-timeout");
    return result;
  }

  const startedAt = Date.now();
  let child;
  try {
    child = spawnImpl(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    result.unknownReasons.push(
      `spawn-error:${error instanceof Error ? error.message : "unknown"}`,
    );
    return result;
  }
  result.pid = Number.isSafeInteger(child?.pid) ? child.pid : null;
  if (result.pid === null) result.unknownReasons.push("missing-child-pid");
  const { stdout, stderr } = outputBuffers();
  child?.stdout?.on("data", (chunk) => stdout.append(chunk));
  child?.stderr?.on("data", (chunk) => stderr.append(chunk));
  const closeState = { done: false };
  const close = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        closeState.done = true;
        resolve(value);
      }
    };
    child?.once("close", (code, signal) => finish({ code, signal }));
    child?.once("error", (error) =>
      finish({ error: error instanceof Error ? error.message : "spawn-error" }),
    );
  });
  let timeoutHandle;
  let executionTimedOut = false;
  const timed = new Promise((resolve) => {
    timeoutHandle = globalThis.setTimeout(
      () => {
        executionTimedOut = true;
        resolve({ timeout: true });
      },
      Math.max(1, timeoutMs - (Date.now() - startedAt)),
    );
  });
  const beforeAllSnapshot = await safeSnapshot(
    snapshotImpl,
    result.unknownReasons,
    Math.max(
      1,
      Math.min(cleanupTimeoutMs, timeoutMs - (Date.now() - startedAt)),
    ),
  );
  const rootBefore = beforeAllSnapshot.find(
    (record) => record.pid === result.pid,
  );
  const beforeSnapshot = processTree(beforeAllSnapshot, result.pid);
  result.beforeSnapshot = beforeSnapshot;
  if (!rootBefore)
    addUnknown(result.unknownReasons, "root-identity-unconfirmed");
  else result.creationIdentity = rootBefore.creationIdentity;
  const outcome = executionTimedOut
    ? { timeout: true }
    : await Promise.race([close, timed]);
  globalThis.clearTimeout(timeoutHandle);
  if (outcome?.timeout === true) {
    result.status = "timeout";
    result.exitKind = "timeout";
    const timeoutAllSnapshot = await safeSnapshot(
      snapshotImpl,
      result.unknownReasons,
      cleanupTimeoutMs,
    );
    result.timeoutSnapshot = observedOwnedTree(
      timeoutAllSnapshot,
      result.pid,
      beforeSnapshot,
    );
    const rootAfter = timeoutAllSnapshot.find(
      (record) => record.pid === result.pid,
    );
    const identityMatches =
      rootBefore && rootAfter && identity(rootBefore) === identity(rootAfter);
    if (!identityMatches) {
      addUnknown(result.unknownReasons, "root-identity-mismatch");
      if (typeof child.kill === "function") {
        try {
          child.kill();
        } catch (error) {
          addUnknown(
            result.unknownReasons,
            `handle-kill-error:${error instanceof Error ? error.message : "unknown"}`,
          );
        }
      }
    } else if (
      !closeState.done &&
      child.exitCode == null &&
      child.signalCode == null
    ) {
      try {
        await boundedOperation(
          () =>
            taskkillImpl(["/PID", String(result.pid), "/T", "/F"], {
              timeout: cleanupTimeoutMs,
            }),
          cleanupTimeoutMs,
        );
      } catch (error) {
        addUnknown(
          result.unknownReasons,
          `taskkill-error:${error instanceof Error ? error.message : "unknown"}`,
        );
        try {
          child.kill?.();
        } catch (fallbackError) {
          addUnknown(
            result.unknownReasons,
            `handle-kill-error:${fallbackError instanceof Error ? fallbackError.message : "unknown"}`,
          );
        }
      }
    }
    try {
      await boundedOperation(() => close, cleanupTimeoutMs);
    } catch {
      addUnknown(result.unknownReasons, "child-close-deadline-exceeded");
    }
    if (!closeState.done && typeof child.kill === "function") {
      try {
        child.kill();
      } catch (error) {
        addUnknown(
          result.unknownReasons,
          `handle-kill-error:${error instanceof Error ? error.message : "unknown"}`,
        );
      }
      try {
        await boundedOperation(() => close, cleanupTimeoutMs);
      } catch {
        addUnknown(result.unknownReasons, "child-close-deadline-exceeded");
      }
    }
  } else if (outcome?.error) {
    result.status = "failed";
    result.exitKind = "spawn-error";
    result.unknownReasons.push(`child-error:${outcome.error}`);
  } else {
    result.exitCode = outcome?.code ?? null;
    result.signal = outcome?.signal ?? null;
    result.exitKind = result.signal
      ? "signal"
      : result.exitCode === 0
        ? "normal"
        : "nonzero";
    result.status = result.exitKind === "normal" ? "passed" : "failed";
  }

  const afterAllSnapshot = await safeSnapshot(
    snapshotImpl,
    result.unknownReasons,
    cleanupTimeoutMs,
  );
  const knownRecords = [...beforeSnapshot, ...result.timeoutSnapshot];
  result.afterSnapshot = observedOwnedTree(
    afterAllSnapshot,
    result.pid,
    knownRecords,
  );
  const remainingOwned = result.afterSnapshot;
  const reusedPids = afterAllSnapshot.some((record) =>
    knownRecords.some(
      (before) =>
        before.pid === record.pid && identity(before) !== identity(record),
    ),
  );
  if (reusedPids) addUnknown(result.unknownReasons, "pid-reuse-detected");
  const afterSnapshotHadError = result.unknownReasons.some((reason) =>
    reason.startsWith("snapshot-error:"),
  );
  result.cleanupVerified =
    !afterSnapshotHadError &&
    remainingOwned.length === 0 &&
    !reusedPids &&
    !result.unknownReasons.includes("root-identity-unconfirmed") &&
    !result.unknownReasons.includes("root-identity-mismatch");
  if (!result.cleanupVerified)
    addUnknown(result.unknownReasons, "cleanup-unverified");
  if (stdout.truncated()) {
    result.stdoutTruncated = true;
    addUnknown(result.unknownReasons, "stdout-truncated");
  }
  if (stderr.truncated()) {
    result.stderrTruncated = true;
    addUnknown(result.unknownReasons, "stderr-truncated");
  }
  result.stdout = stdout.value();
  result.stderr = stderr.value();
  result.accepted =
    result.status === "passed" &&
    result.exitKind === "normal" &&
    result.exitCode === 0 &&
    result.cleanupVerified &&
    result.unknownReasons.length === 0;
  if (result.status === "timeout") result.accepted = false;
  return result;
}
