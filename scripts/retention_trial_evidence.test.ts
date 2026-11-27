// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  inventory,
  loadProtectedEvidence,
  memoryComparison,
  verifyInventory,
} from "./retention_trial_evidence.mjs";

const roots: string[] = [];

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function makeProtectedFixture() {
  const root = await mkdtemp(
    path.join(process.cwd(), ".cache", "retention-protected-"),
  );
  roots.push(root);
  const artifactRel = "fixture-artifact";
  const writeTracked = async (relative: string, value: string) => {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, value);
    return { bytes: Buffer.byteLength(value), sha256: hash(value) };
  };
  const receiptFiles: Record<string, { bytes: number; sha256: string }> = {};
  for (let index = 0; index < 791; index += 1) {
    const relative = `protected/file-${String(index).padStart(3, "0")}.bin`;
    receiptFiles[relative] = await writeTracked(relative, `file-${index}`);
  }
  const makeMap = async (rootName: string, count: number) => {
    const result: Record<string, { bytes: number; sha256: string }> = {};
    for (let index = 0; index < count; index += 1) {
      const relative = `${rootName}-${String(index).padStart(3, "0")}.bin`;
      result[relative] = await writeTracked(
        `frozen/${rootName}/${relative}`,
        relative,
      );
    }
    return result;
  };
  const oldChromeEvidence = await makeMap("old-chrome", 27);
  const priorUnexecutedPreflight = await makeMap("prior", 8);
  const assets = await makeMap("asset", 78);
  const oldBrowserFiles = await makeMap("old-browser", 3);
  const browserFiles = await makeMap("browser", 304);
  const browserExecutable = await writeTracked(
    "frozen/browser/chrome.exe",
    "x",
  );
  browserFiles["chrome.exe"] = browserExecutable;
  const browserMetadata = await writeTracked("metadata.json", "x");
  const native = await writeTracked("native.json", "native");
  const priorPreflight = await writeTracked("frozen/prior-preflight.json", "x");
  const oldZip = await writeTracked("frozen/old.zip", "x");
  const priorReceipts: Array<{ path: string; sha256: string }> = [];
  const frozen = {
    priorReceipts,
    protectedFileCount: 759,
    priorPreflight: { path: "frozen/prior-preflight.json", ...priorPreflight },
    oldChromeEvidence,
    priorUnexecutedPreflight,
    oldZip: { path: "frozen/old.zip", ...oldZip },
    assets,
    browser: {
      root: "frozen/browser",
      revision: "fixture",
      browserVersion: "fixture",
      fileCount: 305,
      totalBytes: Object.values(browserFiles).reduce(
        (sum, value) => sum + value.bytes,
        0,
      ),
      executable: browserExecutable,
      metadata: { path: "metadata.json", ...browserMetadata },
      files: browserFiles,
    },
    oldBrowserFiles,
    nativeConnectionHealth: { path: "native.json", ...native },
  };
  const entries = Object.entries(receiptFiles);
  await mkdir(path.join(root, artifactRel), { recursive: true });
  for (let index = 0; index < 13; index += 1) {
    const relative = `${artifactRel}/prior-${index}.json`;
    const receipt = {
      sourceCommit: "f".repeat(40),
      files: Object.fromEntries(
        entries.slice(index * 59, Math.min((index + 1) * 59, 759)),
      ),
    };
    const text = `${JSON.stringify(receipt)}\n`;
    await writeFile(path.join(root, relative), text);
    priorReceipts.push({ path: relative, sha256: hash(text) });
  }
  const preservedText = `${JSON.stringify({ sourceCommit: "f".repeat(40), files: Object.fromEntries(entries.slice(759)) })}\n`;
  await writeFile(
    path.join(root, `${artifactRel}/preserved-evidence.json`),
    preservedText,
  );
  const preflight = {
    source: { commit: "f".repeat(40) },
    runtimeAssetSourceCommit: "e".repeat(40),
    frozen,
  };
  const preflightText = `${JSON.stringify(preflight)}\n`;
  await writeFile(
    path.join(root, `${artifactRel}/preflight.json`),
    preflightText,
  );
  return {
    root,
    options: {
      artifactRel,
      preflightSha256: hash(preflightText),
      preservedSha256: hash(preservedText),
      frozenCounts: {
        oldChromeEvidence: 27,
        priorUnexecutedPreflight: 8,
        assets: 78,
        browser: 305,
        oldBrowserFiles: 3,
      },
      frozenRoots: {
        oldChromeEvidence: ["frozen/old-chrome"],
        priorUnexecutedPreflight: ["frozen/prior"],
        assets: ["frozen/asset"],
        browser: ["frozen/browser"],
        browserMetadata: [""],
        oldBrowserFiles: ["frozen/old-browser"],
        nativeConnectionHealth: [""],
      },
      receiptCount: 14,
      uniqueFileCount: 791,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("retention evidence inventory", () => {
  it("records regular files and verifies an unchanged exact inventory", async () => {
    const root = await mkdtemp(
      path.join(process.cwd(), ".cache", "retention-evidence-"),
    );
    roots.push(root);
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "a.txt"), "a");
    await writeFile(path.join(root, "nested", "b.txt"), "bb");
    const expected = await inventory(root);
    expect(Object.keys(expected)).toEqual(["a.txt", "nested/b.txt"]);
    expect(verifyInventory(root, expected)).toEqual({
      ok: true,
      files: expected,
    });
  });

  it.each([
    ["path traversal", { "../outside": { bytes: 0, sha256: "0".repeat(64) } }],
    [
      "duplicate conflict",
      [
        ["a", { bytes: 1, sha256: "0".repeat(64) }],
        ["a", { bytes: 2, sha256: "1".repeat(64) }],
      ],
    ],
  ])("rejects unsafe expected inventory: %s", async (_label, expected) => {
    const root = await mkdtemp(
      path.join(process.cwd(), ".cache", "retention-evidence-"),
    );
    roots.push(root);
    await expect(() => verifyInventory(root, expected)).toThrow();
  });

  it("rejects symlinked and non-regular inventory entries", async () => {
    const root = await mkdtemp(
      path.join(process.cwd(), ".cache", "retention-evidence-"),
    );
    roots.push(root);
    await writeFile(path.join(root, "target"), "x");
    await symlink(path.join(root, "target"), path.join(root, "link"));
    expect(() => inventory(root)).toThrow(/symlink/);
  });
});

describe("protected 159 evidence", () => {
  it("verifies the frozen receipts and protected metadata without a new trial", async () => {
    const fixture = await makeProtectedFixture();
    const result = loadProtectedEvidence(fixture.root, fixture.options);
    expect(result.preflightSha256).toBe(fixture.options.preflightSha256);
    expect(result.preservedEvidenceSha256).toBe(
      fixture.options.preservedSha256,
    );
    expect(result.receiptCount).toBe(14);
    expect(result.uniqueFileCount).toBe(791);
    expect(result.frozenCounts).toEqual({
      oldChromeEvidence: 27,
      priorUnexecutedPreflight: 8,
      assets: 78,
      browser: 305,
      oldBrowserFiles: 3,
      nativeConnectionHealthFields: 3,
    });
    await writeFile(
      path.join(fixture.root, "frozen/browser/unlisted.dll"),
      "extra",
    );
    expect(() => loadProtectedEvidence(fixture.root, fixture.options)).toThrow(
      /inventory mismatch/,
    );
  }, 20_000);

  it("fails closed when the protected artifact root is missing", () => {
    expect(() =>
      loadProtectedEvidence(
        path.join(process.cwd(), ".cache", "missing-evidence"),
      ),
    ).toThrow(/missing/);
  });
});

function memorySnapshot(
  phase: string,
  rows: Array<{ pid: number; role: string; currentBytes: number }>,
) {
  return {
    phase,
    memory: {
      status: "measured",
      scope: "cdp-associated-browser-processes",
      rows: rows.map((row) => ({ ...row, peakBytes: row.currentBytes })),
      missingPids: [],
      requestedProcessCount: rows.length,
    },
  };
}

describe("retention memory comparison", () => {
  it("computes ratio and signed delta only for a stable PID/role cohort", () => {
    expect(
      memoryComparison([
        memorySnapshot("resume-1", [
          { pid: 10, role: "browser", currentBytes: 100 },
        ]),
        memorySnapshot("resume-2", [
          { pid: 10, role: "browser", currentBytes: 125 },
        ]),
      ]),
    ).toMatchObject({
      scope: "cdp-associated-browser-processes",
      cohortMatch: true,
      ratio: 1.25,
      delta: 25,
      countExact: true,
      largeIncrease: false,
    });
  });

  it("classifies only a ratio strictly above 1.25 as a large increase", () => {
    const atBoundary = memoryComparison([
      memorySnapshot("resume-1", [
        { pid: 10, role: "browser", currentBytes: 400 },
      ]),
      memorySnapshot("resume-2", [
        { pid: 10, role: "browser", currentBytes: 500 },
      ]),
    ]);
    expect(atBoundary.largeIncrease).toBe(false);
    const above = memoryComparison([
      memorySnapshot("resume-1", [
        { pid: 10, role: "browser", currentBytes: 400 },
      ]),
      memorySnapshot("resume-2", [
        { pid: 10, role: "browser", currentBytes: 501 },
      ]),
    ]);
    expect(above.largeIncrease).toBe(true);
  });

  it("returns null comparison fields after PID churn", () => {
    expect(
      memoryComparison([
        memorySnapshot("resume-1", [
          { pid: 10, role: "browser", currentBytes: 100 },
        ]),
        memorySnapshot("resume-2", [
          { pid: 11, role: "browser", currentBytes: 125 },
        ]),
      ]),
    ).toMatchObject({ cohortMatch: false, ratio: null, delta: null });
  });

  it.each([
    ["unavailable status", { status: "partial" }],
    ["missing PID list", { missingPids: [10] }],
    ["inexact count", { requestedProcessCount: 2 }],
    ["non-exact count flag", { countExact: false }],
    [
      "missing peak",
      { rows: [{ pid: 10, role: "browser", currentBytes: 100 }] },
    ],
    [
      "negative bytes",
      { rows: [{ pid: 10, role: "browser", currentBytes: -1, peakBytes: 0 }] },
    ],
  ])("rejects invalid memory scope: %s", (_label, override) => {
    const base = memorySnapshot("resume-1", [
      { pid: 10, role: "browser", currentBytes: 100 },
    ]);
    const invalid = { ...base, memory: { ...base.memory, ...override } };
    expect(() =>
      memoryComparison([
        invalid,
        memorySnapshot("resume-2", [
          { pid: 10, role: "browser", currentBytes: 100 },
        ]),
      ]),
    ).toThrow();
  });

  it("rejects totals that overflow a safe integer", () => {
    const first = memorySnapshot("resume-1", [
      { pid: 10, role: "browser", currentBytes: Number.MAX_SAFE_INTEGER },
      { pid: 11, role: "renderer", currentBytes: 1 },
    ]);
    const second = memorySnapshot("resume-2", [
      { pid: 10, role: "browser", currentBytes: Number.MAX_SAFE_INTEGER },
      { pid: 11, role: "renderer", currentBytes: 1 },
    ]);
    expect(() => memoryComparison([first, second])).toThrow(/overflow/);
  });
});
