import {
  mkdir,
  mkdtemp,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeBuildOutput,
  resolveBuildConfig,
  verifySourceAssets,
} from "./model_assets.mjs";

const temporaryDirectories: string[] = [];

describe("isolated preview build configuration", () => {
  it("rejects junction ancestors before output creation", async () => {
    const owner = await fixture();
    const outside = await fixture();
    const link = path.join(owner.root, "linked");
    await symlink(
      outside.root,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      assertSafeBuildOutput(path.join(owner.root, "new/output")),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeBuildOutput(path.join(link, "new/output")),
    ).rejects.toThrow(/symlink|junction/);
  });
  it("keeps defaults and selects an explicit local model/output", () => {
    const root = path.resolve("fixture-repo");
    expect(resolveBuildConfig(root, {}).outDir).toBe(
      path.join(root, "dist/extension"),
    );
    const config = resolveBuildConfig(root, {
      "out-dir": "artifacts/preview/source/extension",
      "model-source": "models/preview/source",
    });
    expect(config.outDir).toBe(
      path.join(root, "artifacts/preview/source/extension"),
    );
    expect(config.modelSource).toBe(path.join(root, "models/preview/source"));
    expect(config.isolated).toBe(true);
  });
  it.each([".", "../outside", ".git/new", "models/preview/source/out"])(
    "rejects destructive output %s",
    (out) => {
      expect(() =>
        resolveBuildConfig(path.resolve("fixture-repo"), { "out-dir": out }),
      ).toThrow(/build output/);
    },
  );
  it("rejects external model source and overlapping output/source", () => {
    expect(() =>
      resolveBuildConfig(path.resolve("fixture-repo"), {
        "model-source": "../outside",
      }),
    ).toThrow(/model source/);
    expect(() =>
      resolveBuildConfig(path.resolve("fixture-repo"), {
        "out-dir": "artifacts/preview/run",
        "model-source": "artifacts/preview/run/model",
      }),
    ).toThrow(/overlap/);
  });
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function artifact(bytes: Buffer) {
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kotoba-model-assets-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "onnx"), { recursive: true });
  const files = {
    "config.json": Buffer.from('{"ok":true}\n'),
    "tokenizer.json": Buffer.from("tokenizer\n"),
    "tokenizer_config.json": Buffer.from("config\n"),
    LICENSE: Buffer.from("MIT\n"),
    "onnx/model_quantized.onnx": Buffer.from("onnx\n"),
  };
  for (const [relative, bytes] of Object.entries(files)) {
    await writeFile(path.join(root, relative), bytes);
  }
  return {
    root: path.resolve(root),
    files,
    manifest: {
      artifacts: Object.fromEntries(
        Object.entries(files).map(([relative, bytes]) => [
          relative,
          artifact(bytes),
        ]),
      ),
    },
  };
}

describe("model source asset verification", () => {
  it("accepts every default bundled asset when bytes and SHA match", async () => {
    const value = await fixture();
    await expect(
      verifySourceAssets(value.root, value.manifest),
    ).resolves.toEqual(value.manifest.artifacts);
  });

  it("accepts an explicitly selected source directory reached through a link", async () => {
    const value = await fixture();
    const owner = await fixture();
    const linkedRoot = path.join(owner.root, "canonical");
    await symlink(
      value.root,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      verifySourceAssets(linkedRoot, value.manifest),
    ).resolves.toEqual(value.manifest.artifacts);
  });

  it.each(["config.json", "tokenizer_config.json", "LICENSE"] as const)(
    "rejects same-size changes to %s before it can be copied",
    async (relative) => {
      const value = await fixture();
      await writeFile(
        path.join(value.root, relative),
        Buffer.from("X".repeat(value.files[relative].length)),
      );
      await expect(
        verifySourceAssets(value.root, value.manifest),
      ).rejects.toThrow(
        new RegExp(`hash mismatch: ${relative.replace(".", "\\.")}`),
      );
    },
  );

  it("rejects a changed tokenizer before it can be copied", async () => {
    const value = await fixture();
    await writeFile(
      path.join(value.root, "tokenizer.json"),
      Buffer.from("X".repeat(value.files["tokenizer.json"].length)),
    );
    await expect(
      verifySourceAssets(value.root, value.manifest),
    ).rejects.toThrow(/hash mismatch: tokenizer\.json/);
  });

  it("rejects a missing source file", async () => {
    const value = await fixture();
    await rm(path.join(value.root, "LICENSE"));
    await expect(
      verifySourceAssets(value.root, value.manifest),
    ).rejects.toThrow(/source asset is missing: LICENSE/);
  });

  it("rejects a source size mismatch", async () => {
    const value = await fixture();
    value.manifest.artifacts.LICENSE = {
      ...artifact(value.files.LICENSE),
      bytes: value.files.LICENSE.length + 1,
    };
    await expect(
      verifySourceAssets(value.root, value.manifest),
    ).rejects.toThrow(/size mismatch: LICENSE/);
  });

  it("rejects invalid source metadata", async () => {
    const value = await fixture();
    value.manifest.artifacts.LICENSE = {
      ...artifact(value.files.LICENSE),
      sha256: "invalid",
    };
    await expect(
      verifySourceAssets(value.root, value.manifest),
    ).rejects.toThrow(/metadata is missing: LICENSE/);
  });

  it("rejects a source asset reached through an escaping directory link", async () => {
    const value = await fixture();
    const outside = await fixture();
    await rm(path.join(value.root, "onnx/model_quantized.onnx"));
    await rmdir(path.join(value.root, "onnx"));
    await symlink(
      path.join(outside.root, "onnx"),
      path.join(value.root, "onnx"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      verifySourceAssets(value.root, value.manifest),
    ).rejects.toThrow(/escapes source directory: onnx\/model_quantized\.onnx/);
  });
});
