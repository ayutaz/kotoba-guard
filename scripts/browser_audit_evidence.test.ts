// @vitest-environment node
import { afterAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Server } from "node:net";
import { chromium } from "@playwright/test";
import {
  captureSourceIdentity,
  collectDistributionInventory,
  reserveAuditReport,
  prepareAuditEvidence,
  verifyAuditIdentity,
} from "./browser_audit_evidence.mjs";
import { main, runExtensionInference } from "./browser_security_audit.mjs";

const cache = resolve(".cache");
await mkdir(cache, { recursive: true });
const temporary = await mkdtemp(join(cache, "audit-evidence-test-"));
afterAll(async () => {
  expect(dirname(temporary)).toBe(cache);
  expect(basename(temporary)).toMatch(/^audit-evidence-test-/);
  await rm(temporary, { recursive: true });
});
let sequence = 0;
async function directory() {
  const path = join(temporary, String(sequence++));
  await mkdir(path);
  return path;
}
const identity = (bytes: string) => ({
  bytes: Buffer.byteLength(bytes),
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
async function distribution() {
  const root = await directory();
  const files = {
    "core.js": identity("bundled-code"),
    "licenses/tiny/LICENSE": identity("MIT text"),
  };
  await mkdir(join(root, "licenses/tiny"), { recursive: true });
  await writeFile(join(root, "core.js"), "bundled-code");
  await writeFile(join(root, "licenses/tiny/LICENSE"), "MIT text");
  await writeFile(
    join(root, "distribution-manifest.json"),
    JSON.stringify({ files }),
  );
  return { root, files };
}

describe("fresh audit evidence", () => {
  it.each([true, false])(
    "rejects CLI preflight before network/browser startup (existing=%s)",
    async (existing) => {
      const root = await directory();
      const output = join(root, "cli.json");
      if (existing) await writeFile(output, "existing evidence");
      const launch = vi
        .spyOn(chromium, "launchPersistentContext")
        .mockRejectedValue(new Error("Browser startup forbidden"));
      const listen = vi
        .spyOn(Server.prototype, "listen")
        .mockImplementation(() => {
          throw new Error("Network startup forbidden");
        });
      try {
        await expect(
          main([
            "--output",
            output,
            "--extension-dir",
            join(root, "missing-distribution"),
          ]),
        ).rejects.toThrow();
        expect(launch).not.toHaveBeenCalled();
        expect(listen).not.toHaveBeenCalled();
        const text = await readFile(output, "utf8");
        if (existing) expect(text).toBe("existing evidence");
        else expect(JSON.parse(text)).toMatchObject({ status: "failed" });
      } finally {
        launch.mockRestore();
        listen.mockRestore();
      }
    },
  );
  it("preserves existing output bytes", async () => {
    const root = await directory();
    const path = join(root, "report.json");
    await writeFile(path, "old evidence");
    await expect(reserveAuditReport(path)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("old evidence");
  });
  it("atomically permits only one writer", async () => {
    const path = join(await directory(), "new/report.json");
    const outcomes = await Promise.allSettled([
      reserveAuditReport(path),
      reserveAuditReport(path),
    ]);
    expect(
      outcomes.filter((value) => value.status === "rejected"),
    ).toHaveLength(1);
    for (const value of outcomes) {
      if (value.status === "fulfilled") {
        await value.value.writeFile("new evidence");
        await value.value.close();
      }
    }
    expect(await readFile(path, "utf8")).toBe("new evidence");
  });
  it("rejects an output directory", async () => {
    await expect(reserveAuditReport(await directory())).rejects.toThrow();
  });
  it("rejects symlink parents without touching their destination", async () => {
    const root = await directory();
    const destination = await directory();
    await symlink(destination, join(root, "link"), "junction");
    await expect(
      reserveAuditReport(join(root, "link/report.json")),
    ).rejects.toThrow(/symlink/i);
    await expect(readFile(join(destination, "report.json"))).rejects.toThrow();
  });
  it("writes a sanitized receipt when source preflight fails", async () => {
    const root = await directory();
    const output = join(root, "failed.json");
    await expect(
      prepareAuditEvidence({
        output,
        extensionDir: join(root, "absent"),
        sourceOptions: {
          root,
          git: () => {
            throw new Error("secret-canary https://private.invalid");
          },
        },
      }),
    ).rejects.toThrow();
    const text = await readFile(output, "utf8");
    expect(JSON.parse(text)).toMatchObject({
      status: "failed",
      stage: "source-preflight",
    });
    expect(text).not.toContain("secret-canary");
    expect(text).not.toContain("private.invalid");
    expect(text).not.toContain(root);
  });
  it("does not run preflight operations when output already exists", async () => {
    const output = join(await directory(), "exists.json");
    await writeFile(output, "keep original");
    const git = vi.fn(() => {
      throw new Error("must not run");
    });
    await expect(
      prepareAuditEvidence({
        output,
        extensionDir: "absent",
        sourceOptions: { git },
      }),
    ).rejects.toThrow();
    expect(git).not.toHaveBeenCalled();
    expect(await readFile(output, "utf8")).toBe("keep original");
  });
});

describe("complete distribution binding", () => {
  it("hashes nested assets and the manifest itself", async () => {
    const { root, files } = await distribution();
    const inventory = await collectDistributionInventory(root);
    expect(inventory["core.js"]).toEqual(files["core.js"]);
    expect(inventory["licenses/tiny/LICENSE"]).toEqual(
      files["licenses/tiny/LICENSE"],
    );
    expect(Object.keys(inventory).sort()).toEqual([
      "core.js",
      "distribution-manifest.json",
      "licenses/tiny/LICENSE",
    ]);
  });
  it.each(["missing", "extra", "changed", "empty", "escape"])(
    "rejects %s distribution evidence",
    async (fault) => {
      const { root, files } = await distribution();
      if (fault === "missing") await rm(join(root, "core.js"));
      if (fault === "extra") await writeFile(join(root, "extra.js"), "extra");
      if (fault === "changed")
        await writeFile(join(root, "core.js"), "tampered");
      if (fault === "empty")
        await writeFile(join(root, "distribution-manifest.json"), "{}");
      if (fault === "escape")
        await writeFile(
          join(root, "distribution-manifest.json"),
          JSON.stringify({ files: { ...files, "../outside": identity("x") } }),
        );
      await expect(collectDistributionInventory(root)).rejects.toThrow();
    },
  );
  it("rejects a junction in the asset tree", async () => {
    const { root } = await distribution();
    await symlink(await directory(), join(root, "linked-assets"), "junction");
    await expect(collectDistributionInventory(root)).rejects.toThrow(
      /symlink/i,
    );
  });
});

async function gitFixture() {
  const root = await directory();
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  git(["init", "--quiet"]);
  await writeFile(join(root, "control.mjs"), "export const value = 1;\n");
  git(["add", "control.mjs"]);
  git([
    "-c",
    "user.name=Kotoba Guard Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return { root, git, options: { root, controlFiles: ["control.mjs"] } };
}

describe("source identity", () => {
  it("binds real clean HEAD, tree and control blobs", async () => {
    const { options, git } = await gitFixture();
    const result = await captureSourceIdentity(options);
    expect(result.commit).toBe(git(["rev-parse", "HEAD"]).trim());
    expect(result.tree).toBe(git(["rev-parse", "HEAD^{tree}"]).trim());
    expect(result.clean).toBe(true);
    expect(result.controls["control.mjs"]?.worktreeSha256).toBe(
      identity("export const value = 1;\n").sha256,
    );
  });
  it("rejects a dirty or untracked source", async () => {
    const { root, options } = await gitFixture();
    await writeFile(join(root, "untracked"), "not committed");
    await expect(captureSourceIdentity(options)).rejects.toThrow(/clean/i);
  });
  it("rejects a supplied commit different from HEAD", async () => {
    const { options } = await gitFixture();
    await expect(
      captureSourceIdentity({ ...options, expectedCommit: "a".repeat(40) }),
    ).rejects.toThrow(/commit/i);
  });
  it("verifies control bytes even if Git status reports clean", async () => {
    const { root, options, git } = await gitFixture();
    await writeFile(join(root, "control.mjs"), "modified\n");
    await expect(
      captureSourceIdentity({
        ...options,
        git: (args: string[]) => (args[0] === "status" ? "" : git(args)),
      }),
    ).rejects.toThrow(/blob/i);
  });
  it("sanitizes unavailable Git diagnostics", async () => {
    const { options } = await gitFixture();
    await expect(
      captureSourceIdentity({
        ...options,
        git: () => {
          throw new Error("secret-canary");
        },
      }),
    ).rejects.toThrow(/^Source Git command failed$/);
  });
});

describe("postflight identity", () => {
  const before = {
    source: { commit: "abc", tree: "tree" },
    distribution: { asset: identity("bytes") },
  };
  it("accepts unchanged source and all assets", () => {
    expect(() =>
      verifyAuditIdentity(before, structuredClone(before)),
    ).not.toThrow();
  });
  it.each(["source", "distribution"] as const)(
    "rejects changed %s",
    (field) => {
      const after = { ...before, [field]: {} };
      expect(() => verifyAuditIdentity(before, after)).toThrow(/changed/i);
    },
  );
});

function inferenceFixture(retainedMarks = 0) {
  const calls: string[] = [];
  const field = {
    fill: vi.fn(),
    count: async () => retainedMarks,
    evaluate: vi.fn(async () => ({
      value: "fixture",
      selectionStart: 0,
      selectionEnd: 0,
    })),
    filter: () => ({ count: async () => 1 }),
  };
  const page = {
    bringToFront: async () => {
      calls.push("front");
    },
    locator: () => field,
    evaluate: async () => undefined,
  };
  const popup = {
    goto: async () => {
      calls.push("popup-goto");
    },
    evaluate: vi
      .fn()
      .mockResolvedValueOnce(7)
      .mockResolvedValue({ ok: true, modelReady: true, backend: "wasm" }),
    close: vi.fn(async () => undefined),
  };
  const context = {
    setOffline: async () => {
      calls.push("offline");
    },
    newPage: async () => {
      calls.push("new-page");
      return popup;
    },
  };
  const cdp = {
    send: async (method: string) => {
      if (method === "Target.getTargets")
        return {
          targetInfos: [{ url: "http://fixture/", targetId: "fixture" }],
        };
      calls.push(method);
      return {};
    },
  };
  return {
    calls,
    popup,
    args: {
      context,
      page,
      cdp,
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      origin: "http://fixture",
      jsHeapSamples: [],
    },
  };
}
it("enables offline before action activation and the first extension page", async () => {
  const { calls, args } = inferenceFixture();
  await runExtensionInference(args);
  expect(calls.indexOf("offline")).toBeLessThan(
    calls.indexOf("Extensions.triggerAction"),
  );
  expect(calls.indexOf("offline")).toBeLessThan(calls.indexOf("new-page"));
  expect(calls.indexOf("offline")).toBeLessThan(calls.indexOf("popup-goto"));
});
it("rejects a retained mark instead of accepting it as a new inference", async () => {
  await expect(runExtensionInference(inferenceFixture(1).args)).rejects.toThrow(
    /previous marks/i,
  );
});
it("retains popup cleanup failure alongside the original inference error", async () => {
  const { args, popup } = inferenceFixture(1);
  popup.close.mockRejectedValue(new Error("cleanup failed"));
  const cleanup: Record<string, boolean> = {};
  await expect(
    runExtensionInference({ ...args, cleanupEvidence: cleanup }),
  ).rejects.toThrow(/previous marks/i);
  expect(cleanup.popup).toBe(false);
});
