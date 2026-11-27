import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const MANIFEST = "distribution-manifest.json";
const RETENTION_VALUES = new Set([0, 60_000]);
const EXPECTED_ASSET_COUNT = 78;
const REBUILD_OUTPUTS = new Set(["worker.js", "offscreen.js"]);
const RETAINED_ENTRY_RELATIVE = "scripts/retained-offscreen.entry.ts";
const CONTROL_ENTRY_SOURCE =
  'import { installOffscreenRuntime } from "./runtime";\n\ninstallOffscreenRuntime();\n';
const RETAINED_ENTRY_SOURCE =
  'import { installOffscreenRuntime } from "../extension/src/offscreen/runtime";\n\ninstallOffscreenRuntime({ retainWorkerMs: 60000 });\n';

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function assertCommit(sourceCommit) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? ""))
    throw new Error("sourceCommit must be lower-case 40-hex");
}

function assertWithin(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error(`${label} is outside the source root`);
}

async function ensureRegularDirectory(directory, label) {
  const info = await lstat(directory).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink())
    throw new Error(`${label} must be a real directory`);
}

async function ensureNoSymlinkAncestors(root, candidate, label) {
  let current = candidate;
  while (true) {
    const info = await lstat(current).catch(() => null);
    if (info?.isSymbolicLink())
      throw new Error(`${label} has a symlink or junction ancestor`);
    if (current === root) return;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`${label} has an invalid ancestor`);
    current = parent;
  }
}

async function inventory(directory) {
  await ensureRegularDirectory(directory, "inventory root");
  const result = {};
  async function visit(current, prefix = "") {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new Error(`symlink in inventory: ${relative}`);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!entry.isFile())
        throw new Error(`non-regular inventory entry: ${relative}`);
      const bytes = await readFile(absolute);
      result[relative.replaceAll(path.sep, "/")] = {
        bytes: bytes.length,
        sha256: sha256(bytes),
      };
    }
  }
  await visit(directory);
  return result;
}

function withoutManifest(files) {
  const result = { ...files };
  delete result[MANIFEST];
  return result;
}

function sameRecord(left, right) {
  return left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
}

function sameInventory(left, right) {
  const leftNames = Object.keys(left ?? {}).sort();
  const rightNames = Object.keys(right ?? {}).sort();
  return (
    JSON.stringify(leftNames) === JSON.stringify(rightNames) &&
    leftNames.every((name) => sameRecord(left[name], right[name]))
  );
}

function changedFiles(before, after) {
  return Object.keys({ ...before, ...after })
    .filter((name) => !sameRecord(before[name], after[name]))
    .sort();
}

async function verifySource(sourceRoot, sourceCommit) {
  const git = async (...args) => {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", `safe.directory=${sourceRoot.replaceAll("\\", "/")}`, ...args],
      { cwd: sourceRoot, encoding: "utf8" },
    );
    return stdout.trim();
  };
  if ((await git("rev-parse", "HEAD")) !== sourceCommit)
    throw new Error("source HEAD does not match sourceCommit");
  if (await git("status", "--porcelain=v1", "--untracked-files=all"))
    throw new Error("source checkout is not clean");
}

async function verifyBaseline(baseline) {
  const files = await inventory(baseline);
  if (Object.keys(files).length !== EXPECTED_ASSET_COUNT)
    throw new Error(`baseline must contain ${EXPECTED_ASSET_COUNT} files`);
  const manifestBytes = await readFile(path.join(baseline, MANIFEST));
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error("baseline distribution manifest is invalid", {
      cause: error,
    });
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("baseline distribution manifest must be an object");
  const declared = manifest.files;
  const actual = withoutManifest(files);
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    throw new Error("baseline distribution manifest files are missing");
  if (!sameInventory(declared, actual))
    throw new Error("baseline distribution manifest does not match its files");
  return files;
}

async function copyBaseline(baseline, output, files) {
  await mkdir(output, { recursive: true });
  for (const name of Object.keys(withoutManifest(files))) {
    const destination = path.join(output, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(baseline, name), destination, {
      errorOnExist: true,
      force: false,
    });
  }
}

function defaultBuilder({ outDir, entry, workerEntry }) {
  return (async () => {
    const { build } = await import("vite");
    const buildOne = (source, outputName) =>
      build({
        configFile: false,
        publicDir: false,
        build: {
          outDir,
          emptyOutDir: false,
          target: "chrome116",
          lib: {
            entry: source,
            formats: ["es"],
            fileName: () => outputName,
            name: "KotobaGuard",
          },
          rollupOptions: {
            external: (id) =>
              /^onnxruntime-web(?:\/|$)/.test(id) ||
              id === "@kotoba-guard/core",
            output: {
              codeSplitting: false,
              paths: (id) =>
                id === "@kotoba-guard/core"
                  ? "./core.js"
                  : /^onnxruntime-web(?:\/|$)/.test(id)
                    ? "./wasm/ort.webgpu.min.mjs"
                    : id,
            },
          },
        },
      });
    await buildOne(workerEntry, "worker.js");
    await buildOne(entry, "offscreen.js");
  })();
}

/**
 * @typedef {object} RetentionTrialOptions
 * @property {string} baseline
 * @property {string} outDir
 * @property {string} [entry]
 * @property {string} sourceCommit
 * @property {0|60000} retainWorkerMs
 * @property {string} [sourceRoot]
 * @property {boolean} [fixtureMode]
 * @property {() => Promise<void>} [verifySource]
 * @property {(options: {root: string, outDir: string, entry: string, workerEntry: string, retainWorkerMs: 0|60000}) => Promise<void>|void} [build]
 */

async function writeExclusive(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

/**
 * Copy a verified extension and rebuild only the Worker/offscreen entries.
 * This never mutates the baseline or an existing trial output.
 * @param {RetentionTrialOptions} options
 */
export async function prepareRetentionTrial({
  baseline,
  outDir,
  entry,
  sourceCommit,
  retainWorkerMs,
  sourceRoot = process.cwd(),
  fixtureMode = false,
  verifySource: verifySourceOverride,
  build: buildOverride,
}) {
  assertCommit(sourceCommit);
  if (!RETENTION_VALUES.has(retainWorkerMs))
    throw new Error("retainWorkerMs must be 0 or 60000");
  const root = path.resolve(sourceRoot);
  const baselinePath = path.resolve(baseline);
  const output = path.resolve(outDir);
  assertWithin(root, baselinePath, "baseline");
  const expectedRoot = path.join(
    root,
    "artifacts",
    "retention-trial-build",
    sourceCommit,
  );
  const mode = path.basename(output);
  if (mode !== "control" && mode !== "retained")
    throw new Error("output must end in control or retained");
  if (path.dirname(output) !== expectedRoot)
    throw new Error("output is outside the retention trial directory");
  await ensureNoSymlinkAncestors(root, baselinePath, "baseline");
  await ensureNoSymlinkAncestors(root, output, "output");
  if (output === baselinePath) throw new Error("output cannot equal baseline");
  const outputStat = await lstat(output).catch(() => null);
  if (outputStat) throw new Error("output already exists");
  const provenance = path.join(expectedRoot, `${mode}-provenance.json`);
  if (await lstat(provenance).catch(() => null))
    throw new Error("provenance output already exists");
  await ensureRegularDirectory(baselinePath, "baseline");
  const workerEntry = path.resolve(root, "extension/src/worker/worker.ts");
  const retainedEntry = path.resolve(root, RETAINED_ENTRY_RELATIVE);
  const offscreenEntry = path.resolve(
    root,
    entry ??
      (retainWorkerMs === 60_000
        ? RETAINED_ENTRY_RELATIVE
        : "extension/src/offscreen/offscreen.ts"),
  );
  const defaultOffscreenEntry = path.resolve(
    root,
    "extension/src/offscreen/offscreen.ts",
  );
  if (retainWorkerMs === 60_000 && offscreenEntry !== retainedEntry)
    throw new Error("retained mode requires the fixed retained entry path");
  if (retainWorkerMs === 0 && offscreenEntry !== defaultOffscreenEntry)
    throw new Error("control mode requires the default offscreen entry");
  assertWithin(root, workerEntry, "worker entry");
  assertWithin(root, offscreenEntry, "offscreen entry");
  await ensureNoSymlinkAncestors(root, workerEntry, "worker entry");
  await ensureNoSymlinkAncestors(root, offscreenEntry, "offscreen entry");
  if (!(await lstat(workerEntry).catch(() => null))?.isFile())
    throw new Error("worker entry is missing");
  if (!(await lstat(offscreenEntry).catch(() => null))?.isFile())
    throw new Error("offscreen entry is missing");
  if (retainWorkerMs === 60_000) {
    const source = await readFile(offscreenEntry, "utf8");
    if (source.replaceAll("\r\n", "\n") !== RETAINED_ENTRY_SOURCE)
      throw new Error("retained mode requires the fixed 60000ms entry");
  } else {
    const source = await readFile(offscreenEntry, "utf8");
    if (source.replaceAll("\r\n", "\n") !== CONTROL_ENTRY_SOURCE)
      throw new Error("control entry must match the fixed default entry");
  }
  if (Boolean(verifySourceOverride) !== fixtureMode)
    throw new Error(
      fixtureMode
        ? "fixture mode requires an explicit source verifier"
        : "source verifier override requires explicit fixture mode",
    );
  if (verifySourceOverride) await verifySourceOverride();
  else await verifySource(root, sourceCommit);

  const baselineFiles = await verifyBaseline(baselinePath);
  await mkdir(expectedRoot, { recursive: true });
  await copyBaseline(baselinePath, output, baselineFiles);
  const build = buildOverride ?? defaultBuilder;
  await build({
    root,
    outDir: output,
    entry: offscreenEntry,
    workerEntry,
    retainWorkerMs,
  });
  const baselineAfterBuild = await inventory(baselinePath);
  if (!sameInventory(baselineAfterBuild, baselineFiles))
    throw new Error("baseline changed during retention build");
  const outputBeforeManifest = await inventory(output);
  const sourceComparable = withoutManifest(baselineFiles);
  const outputComparable = withoutManifest(outputBeforeManifest);
  const changedBeforeManifest = changedFiles(
    sourceComparable,
    outputComparable,
  );
  if (
    JSON.stringify(changedBeforeManifest) !==
    JSON.stringify([...REBUILD_OUTPUTS].sort())
  )
    throw new Error("retention build changed files outside worker/offscreen");
  await writeExclusive(path.join(output, MANIFEST), {
    files: outputComparable,
  });
  const outputFiles = await inventory(output);
  if (Object.keys(outputFiles).length !== EXPECTED_ASSET_COUNT)
    throw new Error(
      `retention output must contain ${EXPECTED_ASSET_COUNT} files`,
    );
  const finalManifest = JSON.parse(
    (await readFile(path.join(output, MANIFEST))).toString("utf8"),
  );
  if (!sameInventory(finalManifest.files, withoutManifest(outputFiles)))
    throw new Error("retention distribution manifest does not match output");
  const changed = changedFiles(baselineFiles, outputFiles);
  const expectedChanged = [...REBUILD_OUTPUTS, MANIFEST].sort();
  if (JSON.stringify(changed) !== JSON.stringify(expectedChanged))
    throw new Error("retention output changed unexpected assets");
  await writeExclusive(provenance, {
    sourceCommit,
    sourceBound: !fixtureMode,
    verification: fixtureMode ? "fixture-override" : "git-clean-head",
    retainWorkerMs,
    entry: path.relative(root, offscreenEntry).replaceAll(path.sep, "/"),
    workerEntry: path.relative(root, workerEntry).replaceAll(path.sep, "/"),
    baseline: path.relative(root, baselinePath).replaceAll(path.sep, "/"),
    output: path.relative(root, output).replaceAll(path.sep, "/"),
    assetCount: Object.keys(outputFiles).length,
    changedFiles: changed,
    baselineFiles,
    outputFiles,
  });
  return {
    sourceCommit,
    sourceBound: !fixtureMode,
    retainWorkerMs,
    output,
    provenance,
    assetCount: Object.keys(outputFiles).length,
    changedFiles: changed,
  };
}

function cliOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || argv[index + 1] === undefined)
      throw new Error("invalid CLI arguments");
    values[key.slice(2)] = argv[++index];
  }
  const sourceCommit = values["source-commit"];
  assertCommit(sourceCommit);
  const retainWorkerMs = Number(values["retain-worker-ms"]);
  if (!RETENTION_VALUES.has(retainWorkerMs))
    throw new Error("retain-worker-ms must be 0 or 60000");
  const root = process.cwd();
  return {
    baseline: values.baseline ?? path.join(root, "dist/extension"),
    outDir:
      values["out-dir"] ??
      path.join(
        root,
        "artifacts",
        "retention-trial-build",
        sourceCommit,
        retainWorkerMs ? "retained" : "control",
      ),
    entry: values.entry,
    sourceCommit,
    retainWorkerMs,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    await prepareRetentionTrial(cliOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "retention trial preparation failed",
    );
    process.exitCode = 1;
  }
}
