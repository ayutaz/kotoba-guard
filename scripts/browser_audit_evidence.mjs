import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const controlFiles = [
  "scripts/browser_security_audit.mjs",
  "scripts/browser_security_audit_helpers.mjs",
  "scripts/browser_audit_evidence.mjs",
  "scripts/browser_process_memory.mjs",
  "scripts/build.mjs",
  "scripts/licenses.mjs",
  "package-lock.json",
  "uv.lock",
  "extension/manifest.json",
];

async function rejectSymlinkAncestors(path) {
  let current = resolve(path);
  for (;;) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("Audit evidence must not traverse a symlink");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return (
    rel !== ".." &&
    !rel.startsWith("../") &&
    !rel.startsWith("..\\") &&
    !isAbsolute(rel)
  );
}

export async function reserveAuditReport(path) {
  const absolute = resolve(path);
  if (!inside(process.cwd(), absolute))
    throw new Error("Audit output must stay inside the project workspace");
  await rejectSymlinkAncestors(absolute);
  await mkdir(dirname(absolute), { recursive: true });
  await rejectSymlinkAncestors(absolute);
  return open(absolute, "wx");
}

export async function prepareAuditEvidence({
  output,
  extensionDir,
  sourceOptions = {},
}) {
  if (inside(extensionDir, resolve(output)))
    throw new Error(
      "Audit output must not be inside the selected distribution",
    );
  const reportFile = await reserveAuditReport(output);
  let stage = "source-preflight";
  try {
    const source = await captureSourceIdentity(sourceOptions);
    stage = "distribution-preflight";
    const distribution = await collectDistributionInventory(extensionDir);
    return { reportFile, binding: { source, distribution } };
  } catch {
    try {
      await reportFile.writeFile(
        JSON.stringify(
          {
            schemaVersion: 2,
            status: "failed",
            stage,
            error: "Audit preflight could not be verified",
          },
          null,
          2,
        ) + "\n",
      );
    } finally {
      await reportFile.close();
    }
    throw new Error("Audit preflight failed; failure receipt preserved");
  }
}

async function fileIdentity(path) {
  const bytes = await readFile(path);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function verifyAuditIdentity(before, after) {
  if (JSON.stringify(canonical(before)) !== JSON.stringify(canonical(after)))
    throw new Error("Audit source or distribution changed during execution");
}

export async function collectDistributionInventory(directory) {
  const root = resolve(directory);
  await rejectSymlinkAncestors(root);
  if (!(await lstat(root)).isDirectory())
    throw new Error("Audit extension directory is not a directory");
  const rows = [];
  const walk = async (path) => {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const child = join(path, entry.name);
      const stat = await lstat(child);
      if (stat.isSymbolicLink())
        throw new Error("Audit assets contain a symlink");
      if (stat.isDirectory()) await walk(child);
      else if (stat.isFile())
        rows.push([
          relative(root, child).replaceAll("\\", "/"),
          await fileIdentity(child),
        ]);
      else throw new Error("Audit assets contain a non-regular file");
    }
  };
  await walk(root);
  const inventory = Object.fromEntries(rows);
  const manifest = JSON.parse(
    await readFile(join(root, "distribution-manifest.json"), "utf8"),
  );
  const declared = manifest?.files;
  if (
    !declared ||
    typeof declared !== "object" ||
    Array.isArray(declared) ||
    Object.keys(declared).length === 0
  )
    throw new Error("Audit distribution manifest is missing file declarations");
  for (const [path, value] of Object.entries(declared)) {
    if (
      path.includes("\\") ||
      path.startsWith("/") ||
      path.includes(":") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      path === "distribution-manifest.json"
    )
      throw new Error("Audit distribution manifest contains an invalid path");
    if (
      !value ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(value.sha256 ?? "")
    )
      throw new Error(
        "Audit distribution manifest contains invalid file metadata",
      );
  }
  const actual = Object.fromEntries(
    rows.filter(([path]) => path !== "distribution-manifest.json"),
  );
  verifyAuditIdentity(declared, actual);
  return inventory;
}

export async function captureSourceIdentity(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const run =
    options.git ??
    ((args) =>
      execFileSync(
        "git",
        ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ));
  const git = (args) => {
    try {
      return run(args).trim();
    } catch {
      throw new Error("Source Git command failed");
    }
  };
  if (git(["status", "--porcelain=v1", "--untracked-files=all"]))
    throw new Error("Audit requires a clean source checkout");
  const commit = git(["rev-parse", "HEAD"]);
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree))
    throw new Error("Source commit or tree identity is invalid");
  if (options.expectedCommit !== undefined && options.expectedCommit !== commit)
    throw new Error("Source commit does not match the requested commit");
  /** @type {Record<string, {gitBlob: string, worktreeSha256: string}>} */
  const controls = {};
  for (const path of options.controlFiles ?? controlFiles) {
    if (
      typeof path !== "string" ||
      !inside(root, join(root, path)) ||
      path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Source control path is invalid");
    await rejectSymlinkAncestors(join(root, path));
    const blob = git(["rev-parse", `HEAD:${path}`]);
    if (git(["hash-object", `--path=${path}`, path]) !== blob)
      throw new Error("Source control blob mismatch");
    controls[path] = {
      gitBlob: blob,
      worktreeSha256: (await fileIdentity(join(root, path))).sha256,
    };
  }
  return { commit, tree, clean: true, controls };
}
