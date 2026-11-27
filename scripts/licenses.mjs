import { mkdir, readFile, readdir, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

/** Preserve license texts from the locked production dependency graph. */
export function nativeImageExclusion(name, sources) {
  if (name !== "sharp" && !name.startsWith("@img/sharp-")) return undefined;
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    sources.some(
      (source) =>
        typeof source !== "string" ||
        /(?:^|\/)node_modules\/(?:sharp\/|@img\/sharp-)/.test(
          source.replaceAll("\\", "/"),
        ),
    )
  )
    throw new Error(
      "Native image bundle audit requires a clean, nonempty core source map",
    );
  return "Node-only Sharp/libvips image processing is absent from the actual core bundle source map; no code or native binaries from this package are distributed.";
}

export async function writeLicenses(target, coreAudit) {
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  const ortSource = JSON.parse(
    await readFile("third_party/onnxruntime/sources.json", "utf8"),
  );
  const result = [];
  const browserMap = await readFile(
    "node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs.map",
  );
  const browserSources = JSON.parse(browserMap).sources;
  if (
    !Array.isArray(browserSources) ||
    browserSources.some((source) => /guid-typescript|\/onnxjs\//.test(source))
  )
    throw new Error(
      "Review GUID license: legacy WebGL code must not enter the browser runtime",
    );
  for (const [relative, entry] of Object.entries(lock.packages)) {
    if (!relative.includes("node_modules/") || entry.dev || entry.link)
      continue;
    const lockedName = relative.split("node_modules/").at(-1);
    const nativeImageReason = nativeImageExclusion(
      lockedName,
      coreAudit?.sources,
    );
    if (nativeImageReason) {
      // Excluded native packages are provenance, not distributed code. Record
      // the production lock graph, independent of this OS's optional installs.
      if (typeof entry.version !== "string" || entry.version.length === 0)
        throw new Error(`Missing locked native package version: ${lockedName}`);
      result.push({
        name: lockedName,
        version: entry.version,
        license: entry.license ?? "UNKNOWN",
        files: [],
        notBundledReason: nativeImageReason,
      });
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(path.join(relative, "package.json"), "utf8"),
      );
    } catch (error) {
      if (entry.optional && error.code === "ENOENT") continue;
      throw error;
    }
    const directory = `${manifest.name.replaceAll("/", "__")}@${manifest.version}`;
    const files = [];
    for (const file of await readdir(relative)) {
      if (!/^(licen[sc]e|copying|notice)(\.|$)/i.test(file)) continue;
      await mkdir(path.join(target, "licenses", directory), {
        recursive: true,
      });
      await cp(
        path.join(relative, file),
        path.join(target, "licenses", directory, file),
        { recursive: true },
      );
      files.push(`licenses/${directory}/${file}`);
    }
    const isOrt = manifest.name.startsWith("onnxruntime-");
    const excludedGuid = manifest.name === "guid-typescript";
    const bundledOrt =
      isOrt &&
      (relative === "node_modules/onnxruntime-web" ||
        relative ===
          "node_modules/onnxruntime-web/node_modules/onnxruntime-common");
    if (bundledOrt) {
      if (manifest.version !== ortSource.resolvedPackages[0].version)
        throw new Error(
          "Refresh pinned ONNX Runtime notices for the new locked version",
        );
      for (const file of ortSource.files) {
        const bytes = await readFile(
          path.join("third_party/onnxruntime", file.path),
        );
        if (
          bytes.length !== file.bytes ||
          createHash("sha256").update(bytes).digest("hex") !== file.sha256
        )
          throw new Error("ONNX Runtime license provenance mismatch");
        const destination = `licenses/${directory}/${file.path}`;
        await mkdir(path.dirname(path.join(target, destination)), {
          recursive: true,
        });
        await writeFile(path.join(target, destination), bytes);
        if (!files.includes(destination)) files.push(destination);
      }
    }
    if (files.length === 0 && ((!isOrt && !excludedGuid) || bundledOrt))
      throw new Error(`Missing license text: ${manifest.name}`);
    result.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? entry.license ?? "UNKNOWN",
      files,
      ...(isOrt && !bundledOrt
        ? {
            notBundledReason:
              "Node runtime and Transformers.js nested ORT are externalized to the root bundled browser ORT; no code or binaries from this package are distributed.",
          }
        : {}),
      ...(excludedGuid
        ? {
            notBundledReason:
              "Used only by legacy ONNX.js/WebGL, excluded from the shipped ort.webgpu runtime; audited against its locked package source map.",
          }
        : {}),
    });
  }
  await writeFile(
    path.join(target, "dependency-licenses.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  await writeFile(
    path.join(target, "bundled-runtime-audit.json"),
    JSON.stringify(
      {
        runtime: "onnxruntime-web/dist/ort.webgpu.min.mjs",
        sourceMapSha256: createHash("sha256").update(browserMap).digest("hex"),
        sourceCount: browserSources.length,
        coreSourceMapSha256: coreAudit.sha256,
        coreSourceCount: coreAudit.sources.length,
        excludedNativeImagePackages: result
          .filter((item) =>
            item.notBundledReason?.startsWith("Node-only Sharp/"),
          )
          .map((item) => item.name),
        excluded: ["guid-typescript", "onnxjs"],
        ortImportsExternalizedBy: "scripts/build.mjs",
      },
      null,
      2,
    ) + "\n",
  );
}
