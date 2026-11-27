import { build } from "vite";
import { cp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { writeLicenses } from "./licenses.mjs";
import {
  BUNDLED_MODEL_ASSETS,
  assertSafeBuildOutput,
  resolveBuildConfig,
  verifySourceAssets,
} from "./model_assets.mjs";

const root = process.cwd();
const { values } = parseArgs({
  options: {
    "out-dir": { type: "string" },
    "model-source": { type: "string" },
  },
});
const { outDir, modelSource, isolated } = resolveBuildConfig(root, values);
await assertSafeBuildOutput(outDir);
if (isolated) {
  await mkdir(path.dirname(outDir), { recursive: true });
  await mkdir(outDir);
} else {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
}
await cp("extension/public", outDir, { recursive: true });
await cp("extension/manifest.json", path.join(outDir, "manifest.json"));

for (const [entry, name, format] of [
  ["../../packages/core/src/index.ts", "core.js", "es"],
  ["background/background.ts", "background.js", "es"],
  ["content/index.ts", "content.js", "iife"],
  ["offscreen/offscreen.ts", "offscreen.js", "es"],
  ["worker/worker.ts", "worker.js", "es"],
  ["popup/popup.ts", "popup.js", "es"],
]) {
  await build({
    configFile: false,
    publicDir: false,
    build: {
      outDir,
      emptyOutDir: false,
      target: "chrome116",
      sourcemap: name === "core.js" ? "hidden" : false,
      minify: true,
      lib: {
        entry: path.join(root, "extension/src", entry),
        formats: [format],
        fileName: () => name,
        name: "KotobaGuard",
        cssFileName: "popup",
      },
      rollupOptions: {
        external: (id) =>
          /^onnxruntime-web(?:\/|$)/.test(id) || id === "@kotoba-guard/core",
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
}
const popupHtml = await readFile("extension/src/popup/index.html", "utf8");
await writeFile(path.join(outDir, "popup.html"), popupHtml);

// ORT loads its companion module and WASM from extension-local URLs.
const ortDist = path.join(root, "node_modules/onnxruntime-web/dist");
await mkdir(path.join(outDir, "wasm"), { recursive: true });
for (const file of await readdir(ortDist)) {
  if (file === "ort.webgpu.min.mjs" || /^ort-wasm.*\.(wasm|mjs)$/.test(file)) {
    await cp(path.join(ortDist, file), path.join(outDir, "wasm", file));
  }
}

const source = modelSource;
try {
  const manifest = JSON.parse(
    await readFile(path.join(source, "manifest.json"), "utf8"),
  );
  const target = path.join(outDir, "models");
  const verifiedSourceAssets = await verifySourceAssets(
    source,
    manifest,
    BUNDLED_MODEL_ASSETS,
  );
  await mkdir(target, { recursive: true });
  const inventory = {};
  let sanitization;
  const crypto = await import("node:crypto");
  for (const relative of BUNDLED_MODEL_ASSETS) {
    const dest = path.join(target, relative);
    await mkdir(path.dirname(dest), { recursive: true });
    if (relative.endsWith(".onnx")) {
      sanitization = JSON.parse(
        execFileSync(
          "uv",
          [
            "run",
            "--locked",
            "python",
            "scripts/sanitize_model.py",
            path.join(source, relative),
            dest,
            "--verify",
          ],
          { encoding: "utf8" },
        ),
      );
      sanitization.sourceSha256 = verifiedSourceAssets[relative].sha256;
    } else {
      await cp(path.join(source, relative), dest);
    }
    const bytes = await readFile(dest);
    inventory[relative] = {
      bytes: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  }
  await writeFile(
    path.join(target, "manifest.json"),
    JSON.stringify({ ...manifest, sanitization, files: inventory }, null, 2) +
      "\n",
  );
} catch (error) {
  if (
    isolated ||
    values["model-source"] !== undefined ||
    error.code !== "ENOENT"
  )
    throw error;
  console.warn(
    "Model assets unavailable: development build only; package verification will reject it.",
  );
}
const coreMap = await readFile(path.join(outDir, "core.js.map"));
const coreSources = JSON.parse(coreMap).sources;
await rm(path.join(outDir, "core.js.map"));
await writeLicenses(outDir, {
  sources: coreSources,
  sha256: createHash("sha256").update(coreMap).digest("hex"),
});
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "PRIVACY.md"])
  await cp(file, path.join(outDir, file));
const files = {};
for (const relative of (await readdir(outDir, { recursive: true })).sort()) {
  const absolute = path.join(outDir, relative);
  const { stat } = await import("node:fs/promises");
  if (!(await stat(absolute)).isFile()) continue;
  const bytes = await readFile(absolute);
  files[relative.replaceAll(path.sep, "/")] = {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
await writeFile(
  path.join(outDir, "distribution-manifest.json"),
  JSON.stringify({ files }, null, 2) + "\n",
);
console.log(`Built extension in ${path.relative(root, outDir)}`);
