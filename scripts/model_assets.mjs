import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export const BUNDLED_MODEL_ASSETS = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "LICENSE",
  "onnx/model_quantized.onnx",
];

export async function assertSafeBuildOutput(output) {
  let current = path.resolve(output);
  for (;;) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("build output must not traverse symlink or junction");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function resolveBuildConfig(rootDir, values = {}) {
  const root = path.resolve(rootDir);
  const modelSource = path.resolve(
    root,
    values["model-source"] ??
      "models/converted/8d640720bddeb64c89dc1fa7780c3ea29fa523e8",
  );
  const outDir = path.resolve(root, values["out-dir"] ?? "dist/extension");
  const inside = (parent, child) => {
    const relative = path.relative(parent, child);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  if (!inside(root, modelSource))
    throw new Error("model source must stay inside repository");
  if (
    !inside(path.join(root, "dist"), outDir) &&
    !inside(path.join(root, "artifacts/preview"), outDir)
  ) {
    throw new Error("build output must be inside dist or artifacts/preview");
  }
  if (
    outDir === modelSource ||
    inside(outDir, modelSource) ||
    inside(modelSource, outDir)
  ) {
    throw new Error("build output must not overlap model source");
  }
  return { outDir, modelSource, isolated: values["out-dir"] !== undefined };
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function resolveAsset(root, relative) {
  if (
    typeof relative !== "string" ||
    relative.length === 0 ||
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    relative.split("/").includes("..")
  ) {
    throw new Error(`invalid model source asset path: ${relative}`);
  }
  const resolved = path.resolve(root, relative);
  const within = path.relative(root, resolved);
  if (
    within === ".." ||
    within.startsWith(`..${path.sep}`) ||
    path.isAbsolute(within)
  ) {
    throw new Error(`model source asset escapes source directory: ${relative}`);
  }
  return resolved;
}

/**
 * Verify source bytes against the canonical conversion manifest before any
 * model asset is copied into a distribution directory.
 */
export async function verifySourceAssets(
  sourceDir,
  manifest,
  relativePaths = BUNDLED_MODEL_ASSETS,
) {
  let root;
  try {
    root = await realpath(path.resolve(sourceDir));
  } catch (error) {
    throw new Error("canonical model source directory is missing", {
      cause: error,
    });
  }
  const artifacts = manifest?.artifacts;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    throw new Error("canonical model manifest artifacts are missing");
  }
  const verified = {};
  for (const relative of relativePaths) {
    const expected = artifacts[relative];
    if (
      !expected ||
      !Number.isSafeInteger(expected.bytes) ||
      expected.bytes < 0 ||
      !isSha256(expected.sha256)
    ) {
      throw new Error(
        `canonical source asset metadata is missing: ${relative}`,
      );
    }
    const absolute = resolveAsset(root, relative);
    let resolvedAsset;
    try {
      resolvedAsset = await realpath(absolute);
    } catch (error) {
      throw new Error(`canonical source asset is missing: ${relative}`, {
        cause: error,
      });
    }
    const within = path.relative(root, resolvedAsset);
    if (
      within === ".." ||
      within.startsWith(`..${path.sep}`) ||
      path.isAbsolute(within)
    ) {
      throw new Error(
        `model source asset escapes source directory: ${relative}`,
      );
    }
    const bytes = await readFile(resolvedAsset);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== expected.bytes) {
      throw new Error(`canonical source asset size mismatch: ${relative}`);
    }
    if (sha256 !== expected.sha256.toLowerCase()) {
      throw new Error(`canonical source asset hash mismatch: ${relative}`);
    }
    verified[relative] = { bytes: bytes.length, sha256 };
  }
  return verified;
}
