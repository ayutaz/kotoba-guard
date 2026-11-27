// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareRetentionTrial } from "./prepare_retention_trial.mjs";

const SOURCE = "a".repeat(40);
const ASSET_NAMES = [
  "core.js",
  "worker.js",
  "offscreen.js",
  "manifest.json",
  "distribution-manifest.json",
  ...Array.from({ length: 73 }, (_, index) => `asset-${index}.bin`),
];

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(
    path.join(process.cwd(), ".cache", "retention-unit-"),
  );
  roots.push(root);
  await mkdir(path.join(root, "extension", "src", "offscreen"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "extension", "src", "offscreen", "offscreen.ts"),
    'import { installOffscreenRuntime } from "./runtime";\n\ninstallOffscreenRuntime();\n',
  );
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(
    path.join(root, "scripts", "retained-offscreen.entry.ts"),
    'import { installOffscreenRuntime } from "../extension/src/offscreen/runtime";\n\ninstallOffscreenRuntime({ retainWorkerMs: 60000 });\n',
  );
  await writeFile(
    path.join(root, "extension", "src", "offscreen", "runtime.ts"),
    "export function installOffscreenRuntime(options = {}) { void options; }\n",
  );
  await mkdir(path.join(root, "extension", "src", "worker"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "extension", "src", "worker", "worker.ts"),
    "export {};\n",
  );
  const baseline = path.join(root, "dist", "extension");
  await mkdir(baseline, { recursive: true });
  for (const name of ASSET_NAMES) {
    if (name === "distribution-manifest.json") continue;
    const value =
      name === "manifest.json" ? '{"manifest_version":3}\n' : `${name}\n`;
    await mkdir(path.dirname(path.join(baseline, name)), { recursive: true });
    await writeFile(path.join(baseline, name), value);
  }
  const files: Record<string, { bytes: number; sha256: string }> = {};
  const { createHash } = await import("node:crypto");
  for (const name of ASSET_NAMES.filter(
    (value) => value !== "distribution-manifest.json",
  )) {
    const bytes = await readFile(path.join(baseline, name));
    files[name] = {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  await writeFile(
    path.join(baseline, "distribution-manifest.json"),
    JSON.stringify({ files }),
  );
  return { root, baseline, files };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("prepareRetentionTrial", () => {
  it("runs the CLI guard on Windows and rejects missing source arguments", () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/prepare_retention_trial.mjs")],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sourceCommit must be lower-case 40-hex");
  });
  it("copies a frozen baseline and records only the two rebuilt entries", async () => {
    const { root, baseline } = await fixture();
    const outDir = path.join(
      root,
      "artifacts",
      "retention-trial-build",
      SOURCE,
      "control",
    );
    const result = await prepareRetentionTrial({
      baseline,
      outDir,
      sourceCommit: SOURCE,
      retainWorkerMs: 0,
      sourceRoot: root,
      fixtureMode: true,
      verifySource: async () => undefined,
      build: async ({ outDir: target }) => {
        await writeFile(path.join(target, "worker.js"), "rebuilt-worker\n");
        await writeFile(
          path.join(target, "offscreen.js"),
          "rebuilt-offscreen\n",
        );
      },
    });
    expect(result.changedFiles).toEqual([
      "distribution-manifest.json",
      "offscreen.js",
      "worker.js",
    ]);
    expect(result.assetCount).toBe(78);
    expect(result.sourceBound).toBe(false);
    expect(
      JSON.parse(
        await readFile(path.join(outDir, "distribution-manifest.json"), "utf8"),
      ).files,
    ).toBeTruthy();
    expect(
      await readFile(
        path.join(
          root,
          "artifacts",
          "retention-trial-build",
          SOURCE,
          "control-provenance.json",
        ),
        "utf8",
      ),
    ).toContain(SOURCE);
  });

  it.each([
    ["invalid source", "z".repeat(40), /sourceCommit/],
    ["outside output", SOURCE, /output/],
  ])("rejects %s before building", async (_name, sourceCommit, error) => {
    const { root, baseline } = await fixture();
    const outDir =
      _name === "outside output"
        ? path.join(root, "outside")
        : path.join(
            root,
            "artifacts",
            "retention-trial-build",
            SOURCE,
            "control",
          );
    await expect(
      prepareRetentionTrial({
        baseline,
        outDir,
        sourceCommit,
        retainWorkerMs: 60000,
        sourceRoot: root,
        fixtureMode: true,
        verifySource: async () => undefined,
        build: async () => {
          throw new Error("builder must not run");
        },
      }),
    ).rejects.toThrow(error);
  });

  it("rejects an existing output and same baseline/output", async () => {
    const { root, baseline } = await fixture();
    const outDir = path.join(
      root,
      "artifacts",
      "retention-trial-build",
      SOURCE,
      "retained",
    );
    await mkdir(outDir, { recursive: true });
    await expect(
      prepareRetentionTrial({
        baseline,
        outDir,
        sourceCommit: SOURCE,
        retainWorkerMs: 60000,
        sourceRoot: root,
        verifySource: async () => undefined,
      }),
    ).rejects.toThrow(/exists/);
    await expect(
      prepareRetentionTrial({
        baseline,
        outDir: baseline,
        sourceCommit: SOURCE,
        retainWorkerMs: 0,
        sourceRoot: root,
        fixtureMode: true,
        verifySource: async () => undefined,
      }),
    ).rejects.toThrow(/same|baseline|output/);
  });

  it("rejects a non-fixed retained entry path", async () => {
    const { root, baseline } = await fixture();
    const outDir = path.join(
      root,
      "artifacts",
      "retention-trial-build",
      SOURCE,
      "retained",
    );
    await expect(
      prepareRetentionTrial({
        baseline,
        outDir,
        entry: path.join(root, "extension", "src", "offscreen", "offscreen.ts"),
        sourceCommit: SOURCE,
        retainWorkerMs: 60000,
        sourceRoot: root,
        fixtureMode: true,
        verifySource: async () => undefined,
        build: async () => {
          throw new Error("builder must not run");
        },
      }),
    ).rejects.toThrow(/fixed retained entry/);
  });

  it("accepts only the fixed retained entry shape", async () => {
    const { root, baseline } = await fixture();
    const outDir = path.join(
      root,
      "artifacts",
      "retention-trial-build",
      SOURCE,
      "retained",
    );
    const result = await prepareRetentionTrial({
      baseline,
      outDir,
      sourceCommit: SOURCE,
      retainWorkerMs: 60000,
      sourceRoot: root,
      fixtureMode: true,
      verifySource: async () => undefined,
      build: async ({ outDir: target }) => {
        await writeFile(path.join(target, "worker.js"), "rebuilt-worker\n");
        await writeFile(
          path.join(target, "offscreen.js"),
          "rebuilt-offscreen\n",
        );
      },
    });
    expect(result.sourceBound).toBe(false);
  });

  it("rejects a retained invocation in the control entry", async () => {
    const { root, baseline } = await fixture();
    await writeFile(
      path.join(root, "extension", "src", "offscreen", "offscreen.ts"),
      'import { installOffscreenRuntime } from "./runtime";\n\ninstallOffscreenRuntime({ retainWorkerMs: 60000 });\n',
    );
    const outDir = path.join(
      root,
      "artifacts",
      "retention-trial-build",
      SOURCE,
      "control",
    );
    await expect(
      prepareRetentionTrial({
        baseline,
        outDir,
        sourceCommit: SOURCE,
        retainWorkerMs: 0,
        sourceRoot: root,
        fixtureMode: true,
        verifySource: async () => undefined,
        build: async () => {
          throw new Error("builder must not run");
        },
      }),
    ).rejects.toThrow(/control entry/);
  });

  it("builds the fixed retained entry with Vite in a tiny fixture", async () => {
    const { root, baseline } = await fixture();
    const outDir = path.join(
      root,
      "artifacts",
      "retention-trial-build",
      SOURCE,
      "retained",
    );
    const result = await prepareRetentionTrial({
      baseline,
      outDir,
      sourceCommit: SOURCE,
      retainWorkerMs: 60000,
      sourceRoot: root,
      fixtureMode: true,
      verifySource: async () => undefined,
    });
    expect(result.changedFiles).toEqual([
      "distribution-manifest.json",
      "offscreen.js",
      "worker.js",
    ]);
    expect(result.sourceBound).toBe(false);
  });
});
