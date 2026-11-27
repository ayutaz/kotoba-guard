import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import {
  classifyProbeTargets,
  readVisibilityEnvironment,
  visibilityFixtureFiles,
  visibilityDeadline,
  findProbeParents,
} from "../diagnostics/worker-visibility";

describe("model-free Worker visibility evidence", () => {
  it("selects the inspectable parent rather than a same-URL tab wrapper", () => {
    const id = "abcdefghijklmnopabcdefghijklmnop";
    const page = {
      targetId: "page",
      type: "page",
      url: `chrome-extension://${id}/offscreen.html`,
    };
    const tab = { ...page, targetId: "tab", type: "tab" };
    const foreign = {
      ...page,
      targetId: "foreign",
      url: "chrome-extension://other/offscreen.html",
    };
    expect(findProbeParents([page, tab, foreign], id)).toEqual([page]);
    expect(findProbeParents([tab], id)).toEqual([]);
    expect(
      findProbeParents([page, { ...page, targetId: "other-page" }], id),
    ).toHaveLength(2);
  });
  it("clears deadlines after early success or failure", async () => {
    vi.useFakeTimers();
    try {
      await expect(visibilityDeadline(async () => 7)).resolves.toBe(7);
      await expect(
        visibilityDeadline(async () => {
          throw new Error("expected failure");
        }),
      ).rejects.toThrow("expected failure");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds an uncancellable observation and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      const result = visibilityDeadline(() => new Promise(() => {}), 50);
      const assertion = expect(result).rejects.toThrow(
        "Visibility operation timed out",
      );
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  const id = "abcdefghijklmnopabcdefghijklmnop";
  it("distinguishes exact owned files, URL variants and unknown target types", () => {
    expect(
      classifyProbeTargets(
        [
          {
            targetId: "a",
            type: "other",
            url: `chrome-extension://${id}/offscreen.html`,
          },
          {
            targetId: "b",
            type: "iframe",
            url: `chrome-extension://${id}/worker.js?x=secret`,
          },
          {
            targetId: "c",
            type: "unexpected-secret",
            url: `chrome-extension://${id}/popup.html`,
          },
        ],
        id,
      ),
    ).toEqual([
      {
        role: "offscreen",
        type: "other",
        targetId: "a",
        exactLocation: true,
        hasParent: false,
      },
      {
        role: "worker",
        type: "iframe",
        targetId: "b",
        exactLocation: false,
        hasParent: false,
      },
      {
        role: "extension-other",
        type: "unknown",
        targetId: "c",
        exactLocation: false,
        hasParent: false,
      },
    ]);
  });
  it("never retains foreign IDs, URLs, query values or raw unknown types", () => {
    const result = classifyProbeTargets(
      [
        {
          targetId: "private-id",
          type: "private-type",
          url: "https://private.example/secret",
        },
        { targetId: "hidden-id", type: "worker", url: "" },
        {
          targetId: "foreign-extension",
          type: "page",
          url: "chrome-extension://other/offscreen.html",
        },
        { targetId: "invalid-url", type: "page", url: "secret-invalid" },
      ],
      id,
    );
    expect(result.map((t) => t.role)).toEqual([
      "foreign",
      "empty-url",
      "foreign",
      "foreign",
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /private|secret|hidden-id|foreign-extension|invalid-url/,
    );
  });
  it("rejects malformed inventories and ownership IDs", () => {
    expect(() => classifyProbeTargets([], "bad")).toThrow();
    expect(() =>
      classifyProbeTargets(
        [
          {
            targetId: "bad id",
            type: "page",
            url: `chrome-extension://${id}/popup.html`,
          },
        ],
        id,
      ),
    ).toThrow();
  });
  it("requires a fixed source, absolute executable and source-specific fresh output path", () => {
    const source = "a".repeat(40);
    const env = {
      SOURCE_COMMIT: source,
      KOTOBA_GUARD_BROWSER_EXECUTABLE: path.resolve(".cache/chrome.exe"),
      KOTOBA_VISIBILITY_OUTPUT: path.resolve(
        "artifacts/chrome116-worker-visibility",
        source,
        "report.json",
      ),
    };
    expect(readVisibilityEnvironment(env)).toEqual({
      sourceCommit: source,
      executablePath: env.KOTOBA_GUARD_BROWSER_EXECUTABLE,
      output: env.KOTOBA_VISIBILITY_OUTPUT,
    });
    for (const bad of [
      { ...env, SOURCE_COMMIT: "main" },
      { ...env, KOTOBA_GUARD_BROWSER_EXECUTABLE: "chrome" },
      { ...env, KOTOBA_VISIBILITY_OUTPUT: path.resolve("artifacts/old.json") },
      { ...env, KOTOBA_VISIBILITY_OUTPUT: "relative.json" },
    ]) {
      expect(() => readVisibilityEnvironment(bad)).toThrow();
    }
  });
  it("creates only six local fixture files without a model or remote runtime", () => {
    const files = visibilityFixtureFiles();
    expect(Object.keys(files).sort()).toEqual([
      "background.js",
      "manifest.json",
      "offscreen.html",
      "offscreen.js",
      "popup.html",
      "worker.js",
    ]);
    const manifest = JSON.parse(files["manifest.json"]!);
    expect(manifest.permissions).toEqual(["offscreen"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(Object.values(files).join("\n")).not.toMatch(
      /https?:|fetch\(|onnx|safetensors|eval\(/i,
    );
  });
});
