import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const CURRENT_ARTIFACT_REL =
  "artifacts/scoped-idle-chromium159/4f8c74da483a729476276937c0882ec0bbc236cf";
export const EXPECTED_PREFLIGHT_SHA256 =
  "289b95a86c98195662086369b52d94e23b5db1431efeb8405d3fa4c5e906d9ab";
export const EXPECTED_PRESERVED_SHA256 =
  "1e21acf9257afaeef8a9c7efc4aafed31adac2f39b57339879e70190911f06e1";
export const EXPECTED_RECEIPT_COUNT = 14;
export const EXPECTED_PROTECTED_FILE_COUNT = 791;
export const MEMORY_SCOPE = "cdp-associated-browser-processes";

const SHA256 = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(`retention evidence: ${message}`);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  return value;
}

function assertSafeRelative(relative, label = "path") {
  if (
    typeof relative !== "string" ||
    relative.length === 0 ||
    relative.includes("\0") ||
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    /^[A-Za-z]:/.test(relative)
  )
    fail(`${label} is unsafe`);
  const parts = relative.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    fail(`${label} is unsafe`);
  return relative;
}

function resolveWithin(root, relative, label = "path") {
  const safe = assertSafeRelative(relative, label);
  const base = path.resolve(root);
  const candidate = path.resolve(base, safe);
  const relation = path.relative(base, candidate);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  )
    fail(`${label} is outside root`);
  return candidate;
}

function rejectSymlinkAncestors(base, candidate, label) {
  let current = path.resolve(candidate);
  const resolvedBase = path.resolve(base);
  while (true) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      stat = undefined;
    }
    if (stat?.isSymbolicLink()) fail(`${label} has a symlink ancestor`);
    if (current === resolvedBase) return;
    const parent = path.dirname(current);
    if (parent === current) fail(`${label} is outside root`);
    current = parent;
  }
}

function regularFile(root, relative, label = "file") {
  const candidate = resolveWithin(root, relative, label);
  rejectSymlinkAncestors(root, candidate, label);
  let stat;
  try {
    stat = lstatSync(candidate);
  } catch {
    fail(`${label} is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} is not regular`);
  return candidate;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function descriptor(value, label) {
  const record = assertObject(value, label);
  if (
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 0 ||
    typeof record.sha256 !== "string" ||
    !SHA256.test(record.sha256)
  )
    fail(`${label} is malformed`);
  return { bytes: record.bytes, sha256: record.sha256 };
}

function descriptorMap(value, label) {
  const record = assertObject(value, label);
  const result = {};
  for (const [relative, value] of Object.entries(record)) {
    assertSafeRelative(relative, `${label} path`);
    if (Object.prototype.hasOwnProperty.call(result, relative))
      fail(`${label} contains duplicate path`);
    result[relative] = descriptor(value, `${label}/${relative}`);
  }
  return result;
}

function inventoryExpected(value) {
  if (!Array.isArray(value))
    return descriptorMap(value?.files ?? value, "expected inventory");
  const result = {};
  for (const [index, pair] of value.entries()) {
    if (!Array.isArray(pair) || pair.length !== 2)
      fail(`expected inventory entry ${index} is malformed`);
    const [relative, value] = pair;
    assertSafeRelative(relative, "expected inventory path");
    if (Object.prototype.hasOwnProperty.call(result, relative))
      fail(`expected inventory contains duplicate path: ${relative}`);
    result[relative] = descriptor(value, `expected inventory/${relative}`);
  }
  return result;
}

function readJson(root, relative, expectedSha, label) {
  const file = regularFile(root, relative, label);
  const bytes = readFileSync(file);
  const actualSha = sha256(bytes);
  if (expectedSha !== undefined && actualSha !== expectedSha)
    fail(`${label} SHA-256 mismatch`);
  try {
    return {
      value: JSON.parse(bytes.toString("utf8")),
      bytes,
      sha256: actualSha,
    };
  } catch {
    fail(`${label} is invalid JSON`);
  }
}

function verifyFileRecord(root, relative, expected, label) {
  const actual = readFileSync(regularFile(root, relative, label));
  if (actual.length !== expected.bytes || sha256(actual) !== expected.sha256)
    fail(`${label} content mismatch`);
}

function verifyReceiptFiles(root, receipt, label, union) {
  const files = descriptorMap(
    assertObject(receipt, label).files,
    `${label}.files`,
  );
  for (const [relative, expected] of Object.entries(files)) {
    const previous = union.get(relative);
    if (
      previous &&
      (previous.bytes !== expected.bytes || previous.sha256 !== expected.sha256)
    )
      fail(`duplicate receipt conflict for ${relative}`);
    union.set(relative, expected);
    verifyFileRecord(root, relative, expected, `${label}.files/${relative}`);
  }
  return files;
}

function assertFrozenProtection(frozen, expectedCounts) {
  const record = assertObject(frozen, "preflight.frozen");
  const maps = {
    oldChromeEvidence: expectedCounts.oldChromeEvidence,
    priorUnexecutedPreflight: expectedCounts.priorUnexecutedPreflight,
    assets: expectedCounts.assets,
    oldBrowserFiles: expectedCounts.oldBrowserFiles,
  };
  const counts = {};
  for (const [key, expectedCount] of Object.entries(maps)) {
    const value = descriptorMap(record[key], `preflight.frozen.${key}`);
    if (Object.keys(value).length !== expectedCount)
      fail(`preflight.frozen.${key} count mismatch`);
    counts[key] = expectedCount;
  }
  const browser = assertObject(record.browser, "preflight.frozen.browser");
  if (
    browser.fileCount !== expectedCounts.browser ||
    !Number.isSafeInteger(browser.totalBytes) ||
    browser.totalBytes < 0
  )
    fail("preflight.frozen.browser summary mismatch");
  const browserFiles = descriptorMap(
    browser.files,
    "preflight.frozen.browser.files",
  );
  if (Object.keys(browserFiles).length !== expectedCounts.browser)
    fail("browser file count mismatch");
  counts.browser = expectedCounts.browser;
  const executable = descriptor(
    browser.executable,
    "preflight.frozen.browser.executable",
  );
  const metadata = assertObject(
    browser.metadata,
    "preflight.frozen.browser.metadata",
  );
  if (typeof metadata.path !== "string")
    fail("browser metadata path is missing");
  assertSafeRelative(metadata.path, "browser metadata path");
  descriptor(metadata, "preflight.frozen.browser.metadata");
  if (
    !Number.isSafeInteger(record.protectedFileCount) ||
    record.protectedFileCount !== 759
  )
    fail("protectedFileCount mismatch");
  const native = assertObject(
    record.nativeConnectionHealth,
    "preflight.frozen.nativeConnectionHealth",
  );
  if (typeof native.path !== "string")
    fail("nativeConnectionHealth path is missing");
  assertSafeRelative(native.path, "nativeConnectionHealth path");
  descriptor(native, "preflight.frozen.nativeConnectionHealth");
  const priorPreflight = assertObject(
    record.priorPreflight,
    "preflight.frozen.priorPreflight",
  );
  const oldZip = assertObject(record.oldZip, "preflight.frozen.oldZip");
  assertSafeRelative(priorPreflight.path, "priorPreflight path");
  assertSafeRelative(oldZip.path, "oldZip path");
  descriptor(priorPreflight, "preflight.frozen.priorPreflight");
  descriptor(oldZip, "preflight.frozen.oldZip");
  counts.nativeConnectionHealthFields = 3;
  return {
    counts,
    protectedFileCount: record.protectedFileCount,
    maps: {
      oldChromeEvidence: descriptorMap(
        record.oldChromeEvidence,
        "oldChromeEvidence",
      ),
      priorUnexecutedPreflight: descriptorMap(
        record.priorUnexecutedPreflight,
        "priorUnexecutedPreflight",
      ),
      assets: descriptorMap(record.assets, "assets"),
      browser: browserFiles,
      oldBrowserFiles: descriptorMap(record.oldBrowserFiles, "oldBrowserFiles"),
      nativeConnectionHealth: native,
      priorPreflight,
      oldZip,
      browserExecutable: executable,
      browserMetadata: metadata,
    },
    browserRoot: browser.root,
  };
}

function verifyMapFromRoots(root, files, roots, label, exact = false) {
  const candidates = Array.isArray(roots) ? roots : [roots];
  if (candidates.length === 0) fail(`${label} roots are missing`);
  if (exact) {
    if (candidates.length !== 1) fail(`${label} requires one exact root`);
    const base = resolveWithin(root, candidates[0], `${label} root`);
    rejectSymlinkAncestors(root, base, label);
    verifyInventory(base, files);
    return;
  }
  for (const [relative, expected] of Object.entries(files)) {
    let found = false;
    for (const candidateRoot of candidates) {
      const base =
        candidateRoot === ""
          ? path.resolve(root)
          : resolveWithin(root, candidateRoot, `${label} root`);
      const candidate = path.resolve(base, relative);
      const relation = path.relative(base, candidate);
      if (
        relation === ".." ||
        relation.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relation)
      )
        fail(`${label}/${relative} escapes root`);
      rejectSymlinkAncestors(base, candidate, `${label}/${relative}`);
      let stat;
      try {
        stat = lstatSync(candidate);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink())
        fail(`${label}/${relative} is not regular`);
      const bytes = readFileSync(candidate);
      if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256)
        fail(`${label}/${relative} content mismatch`);
      found = true;
      break;
    }
    if (!found) fail(`${label}/${relative} is missing`);
  }
}

/** Return a deterministic SHA-256/byte inventory for a real directory. */
export function inventory(root) {
  const base = path.resolve(root);
  let rootStat;
  try {
    rootStat = lstatSync(base);
  } catch {
    fail("inventory root is missing");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    fail("inventory root must be a real directory");
  const result = {};
  function visit(current, prefix = "") {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertSafeRelative(relative, "inventory path");
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) fail(`symlink in inventory: ${relative}`);
      if (entry.isDirectory()) {
        visit(absolute, relative);
        continue;
      }
      if (!entry.isFile()) fail(`non-regular inventory entry: ${relative}`);
      const bytes = readFileSync(absolute);
      if (Object.prototype.hasOwnProperty.call(result, relative))
        fail(`duplicate inventory path: ${relative}`);
      result[relative] = { bytes: bytes.length, sha256: sha256(bytes) };
    }
  }
  visit(base);
  return result;
}

/** Compare an exact expected inventory; no extra or missing entries are accepted. */
export function verifyInventory(root, expected) {
  const expectedFiles = inventoryExpected(expected);
  const actual = inventory(root);
  const names = new Set([
    ...Object.keys(expectedFiles),
    ...Object.keys(actual),
  ]);
  for (const name of names) {
    const left = expectedFiles[name];
    const right = actual[name];
    if (
      !left ||
      !right ||
      left.bytes !== right.bytes ||
      left.sha256 !== right.sha256
    )
      fail(`inventory mismatch: ${name}`);
  }
  return { ok: true, files: actual };
}

/**
 * Load and verify the frozen 159 trial receipt chain and return an immutable
 * summary. The function never runs a browser or starts a new trial.
 */
export function loadProtectedEvidence(root, options = {}) {
  const base = path.resolve(root);
  const artifactRel = options.artifactRel ?? CURRENT_ARTIFACT_REL;
  assertSafeRelative(artifactRel, "artifact root");
  const expectedPreflightSha =
    options.preflightSha256 ?? EXPECTED_PREFLIGHT_SHA256;
  const expectedPreservedSha =
    options.preservedSha256 ?? EXPECTED_PRESERVED_SHA256;
  const expectedReceiptCount = options.receiptCount ?? EXPECTED_RECEIPT_COUNT;
  const expectedUniqueFileCount =
    options.uniqueFileCount ?? EXPECTED_PROTECTED_FILE_COUNT;
  const expectedCounts = {
    oldChromeEvidence: options.frozenCounts?.oldChromeEvidence ?? 27,
    priorUnexecutedPreflight:
      options.frozenCounts?.priorUnexecutedPreflight ?? 8,
    assets: options.frozenCounts?.assets ?? 78,
    browser: options.frozenCounts?.browser ?? 305,
    oldBrowserFiles: options.frozenCounts?.oldBrowserFiles ?? 3,
  };
  const preflightRel = `${artifactRel}/preflight.json`;
  const preservedRel = `${artifactRel}/preserved-evidence.json`;
  const preflight = readJson(
    base,
    preflightRel,
    expectedPreflightSha,
    "preflight.json",
  ).value;
  const preserved = readJson(
    base,
    preservedRel,
    expectedPreservedSha,
    "preserved-evidence.json",
  ).value;
  const frozen = assertObject(preflight.frozen, "preflight.frozen");
  const frozenProtection = assertFrozenProtection(frozen, expectedCounts);
  const frozenRoots = options.frozenRoots ?? {
    oldChromeEvidence: ["artifacts/compatibility/chrome116"],
    priorUnexecutedPreflight: [
      "artifacts/current-runtime-chrome116/2adeee54f8b906cf41b242ebe6dc803ded15c980",
    ],
    assets: [
      "artifacts/license-packaging/0ba36301cdb1b2b9759ce81dbdc8fb6837648bbe/windows-extension",
    ],
    browser: [frozenProtection.browserRoot],
    browserMetadata: [""],
    oldBrowserFiles: [".cache/chrome-for-testing-116.0.5845.96"],
    nativeConnectionHealth: [""],
  };
  verifyMapFromRoots(
    base,
    frozenProtection.maps.oldChromeEvidence,
    frozenRoots.oldChromeEvidence,
    "oldChromeEvidence",
    true,
  );
  verifyMapFromRoots(
    base,
    frozenProtection.maps.priorUnexecutedPreflight,
    frozenRoots.priorUnexecutedPreflight,
    "priorUnexecutedPreflight",
    true,
  );
  verifyMapFromRoots(
    base,
    frozenProtection.maps.assets,
    frozenRoots.assets,
    "assets",
    true,
  );
  verifyMapFromRoots(
    base,
    frozenProtection.maps.browser,
    frozenRoots.browser,
    "browser",
    true,
  );
  verifyMapFromRoots(
    base,
    { "chrome.exe": frozenProtection.maps.browserExecutable },
    frozenRoots.browser,
    "browser executable",
  );
  verifyMapFromRoots(
    base,
    {
      [frozenProtection.maps.browserMetadata.path]:
        frozenProtection.maps.browserMetadata,
    },
    frozenRoots.browserMetadata ?? [""],
    "browser metadata",
  );
  verifyMapFromRoots(
    base,
    frozenProtection.maps.oldBrowserFiles,
    frozenRoots.oldBrowserFiles,
    "oldBrowserFiles",
  );
  verifyFileRecord(
    base,
    frozenProtection.maps.nativeConnectionHealth.path,
    frozenProtection.maps.nativeConnectionHealth,
    "nativeConnectionHealth",
  );
  verifyFileRecord(
    base,
    frozenProtection.maps.priorPreflight.path,
    frozenProtection.maps.priorPreflight,
    "priorPreflight",
  );
  verifyFileRecord(
    base,
    frozenProtection.maps.oldZip.path,
    frozenProtection.maps.oldZip,
    "oldZip",
  );
  const union = new Map();
  const priorReceipts = Array.isArray(frozen.priorReceipts)
    ? frozen.priorReceipts
    : fail("priorReceipts missing");
  if (priorReceipts.length + 1 !== expectedReceiptCount)
    fail("priorReceipts count mismatch");
  for (const [index, entry] of priorReceipts.entries()) {
    const record = assertObject(entry, `priorReceipts[${index}]`);
    const relative = record.path;
    assertSafeRelative(relative, `priorReceipts[${index}].path`);
    if (typeof record.sha256 !== "string" || !SHA256.test(record.sha256))
      fail(`priorReceipts[${index}] SHA is malformed`);
    const receipt = readJson(
      base,
      relative,
      record.sha256,
      `priorReceipts[${index}]`,
    ).value;
    verifyReceiptFiles(base, receipt, `priorReceipts[${index}]`, union);
  }
  if (union.size !== frozenProtection.protectedFileCount)
    fail("prior receipt union count mismatch");
  verifyReceiptFiles(base, preserved, "latest preserved-evidence", union);
  if (union.size !== expectedUniqueFileCount)
    fail(`unique protected file count mismatch: ${union.size}`);
  return {
    artifact: artifactRel,
    preflightSha256: expectedPreflightSha,
    preservedEvidenceSha256: expectedPreservedSha,
    receiptCount: priorReceipts.length + 1,
    uniqueFileCount: union.size,
    frozenCounts: frozenProtection.counts,
    protectedFileCount: frozenProtection.protectedFileCount,
    sourceCommit: preflight.source?.commit ?? null,
    runtimeAssetSourceCommit: preflight.runtimeAssetSourceCommit ?? null,
  };
}

function memoryRows(snapshot, label) {
  const memory = assertObject(snapshot?.memory, `${label}.memory`);
  if (memory.status !== "measured" || memory.scope !== MEMORY_SCOPE)
    fail(`${label} memory is not measured in the expected scope`);
  if (!Array.isArray(memory.missingPids) || memory.missingPids.length !== 0)
    fail(`${label} memory has missing PIDs`);
  if (
    !Number.isSafeInteger(memory.requestedProcessCount) ||
    memory.requestedProcessCount < 1
  )
    fail(`${label} memory count is invalid`);
  if (memory.countExact !== undefined && memory.countExact !== true)
    fail(`${label} memory count is not exact`);
  if (
    !Array.isArray(memory.rows) ||
    memory.rows.length !== memory.requestedProcessCount
  )
    fail(`${label} memory row count is not exact`);
  const rows = memory.rows.map((row, index) => {
    const value = assertObject(row, `${label}.memory.rows[${index}]`);
    const role = value.role ?? value.type;
    if (
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof role !== "string" ||
      role.length === 0 ||
      !Number.isSafeInteger(value.currentBytes) ||
      value.currentBytes < 0 ||
      !Number.isSafeInteger(value.peakBytes) ||
      value.peakBytes < value.currentBytes
    )
      fail(`${label}.memory.rows[${index}] is malformed`);
    return {
      pid: value.pid,
      role,
      currentBytes: value.currentBytes,
    };
  });
  const ids = new Set(rows.map((row) => row.pid));
  if (ids.size !== rows.length) fail(`${label} memory has duplicate PIDs`);
  return { rows, count: rows.length };
}

/** Compare only a stable resume-1/resume-2 PID and role cohort. */
export function memoryComparison(snapshots) {
  const list = Array.isArray(snapshots) ? snapshots : snapshots?.snapshots;
  if (!Array.isArray(list) || list.length === 0)
    fail("snapshots must be a non-empty array");
  const validated = list.map((snapshot, index) =>
    memoryRows(snapshot, `snapshot[${index}]`),
  );
  const firstIndex = list.findIndex(
    (snapshot) => snapshot?.phase === "resume-1",
  );
  const secondIndex = list.findIndex(
    (snapshot) => snapshot?.phase === "resume-2",
  );
  if (firstIndex < 0 || secondIndex < 0)
    fail("resume-1 and resume-2 snapshots are required");
  const first = validated[firstIndex];
  const second = validated[secondIndex];
  const cohort = (rows) => new Map(rows.map((row) => [row.pid, row.role]));
  const left = cohort(first.rows);
  const right = cohort(second.rows);
  const cohortMatch =
    left.size === right.size &&
    [...left.entries()].every(([pid, role]) => right.get(pid) === role);
  const firstTotal = first.rows.reduce((sum, row) => sum + row.currentBytes, 0);
  const secondTotal = second.rows.reduce(
    (sum, row) => sum + row.currentBytes,
    0,
  );
  if (!Number.isSafeInteger(firstTotal) || !Number.isSafeInteger(secondTotal))
    fail("memory totals overflow safe integer range");
  const ratio = cohortMatch && firstTotal > 0 ? secondTotal / firstTotal : null;
  return {
    scope: MEMORY_SCOPE,
    countExact: true,
    resume1Count: first.count,
    resume2Count: second.count,
    resume1TotalBytes: firstTotal,
    resume2TotalBytes: secondTotal,
    cohortMatch,
    beforeBytes: cohortMatch ? firstTotal : null,
    afterBytes: cohortMatch ? secondTotal : null,
    ratio,
    delta: cohortMatch ? secondTotal - firstTotal : null,
    largeIncrease: ratio === null ? null : ratio > 1.25,
  };
}
