import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import * as contract from "../diagnostics/resource-contract";
import {
  createResourceCdp,
  parseResourceTrialEnvironment,
  isSuccessfulRelease,
} from "../diagnostics/resource-contract";

const source = "a".repeat(40);
const runtime = "0f99811fb1a78a0a40c86ada6bda1fa5a42b10f7";
const environment = {
  SOURCE_COMMIT: source,
  RUNTIME_SOURCE_COMMIT: runtime,
  KOTOBA_RESOURCE_OUTPUT: path.resolve(
    "artifacts/related-attachment-memory",
    source,
    "report.json",
  ),
  KOTOBA_RESOURCE_PREFLIGHT_SHA256: "b".repeat(64),
};

describe("resource diagnostic contract", () => {
  it("binds the report to the preflight source, runtime and full asset identity", () => {
    const identity = {
      sourceCommit: source,
      runtimeSourceCommit: runtime,
      output: environment.KOTOBA_RESOURCE_OUTPUT,
      preflightSha256: "b".repeat(64),
    };
    const preflight = {
      source_commit: source,
      runtime_source_commit: runtime,
      source_clean: true,
      reused_runtime_assets: true,
      assets: Object.fromEntries(
        Array.from({ length: 81 }, (_, i) => [
          `asset${i}`,
          { bytes: 1, sha256: "c".repeat(64) },
        ]),
      ),
    };
    expect(
      contract.validateResourcePreflight(preflight, identity, "b".repeat(64)),
    ).toBeUndefined();
    for (const invalid of [
      null,
      { ...preflight, source_commit: runtime },
      { ...preflight, runtime_source_commit: source },
      { ...preflight, source_clean: false },
      { ...preflight, assets: {} },
    ]) {
      expect(() =>
        contract.validateResourcePreflight(invalid, identity, "b".repeat(64)),
      ).toThrow("invalid-resource-preflight");
    }
    expect(() =>
      contract.validateResourcePreflight(preflight, identity, "c".repeat(64)),
    ).toThrow("invalid-resource-preflight");
  });
  it("requires separate fixed diagnostic/runtime identities and an absolute output", () => {
    expect(parseResourceTrialEnvironment(environment)).toEqual({
      sourceCommit: source,
      runtimeSourceCommit: runtime,
      output: environment.KOTOBA_RESOURCE_OUTPUT,
      preflightSha256: "b".repeat(64),
    });
    for (const invalid of [undefined, "working-tree", "1234", "A".repeat(40)]) {
      expect(() =>
        parseResourceTrialEnvironment({
          ...environment,
          SOURCE_COMMIT: invalid,
        }),
      ).toThrow("invalid-resource-trial");
    }
    for (const invalid of [undefined, source, "0f99811"]) {
      expect(() =>
        parseResourceTrialEnvironment({
          ...environment,
          RUNTIME_SOURCE_COMMIT: invalid,
        }),
      ).toThrow("invalid-resource-trial");
    }
    for (const invalid of [undefined, "", "relative/report.json"]) {
      expect(() =>
        parseResourceTrialEnvironment({
          ...environment,
          KOTOBA_RESOURCE_OUTPUT: invalid,
        }),
      ).toThrow("invalid-resource-trial");
    }
    for (const invalid of [undefined, "", "b".repeat(63), "B".repeat(64)]) {
      expect(() =>
        parseResourceTrialEnvironment({
          ...environment,
          KOTOBA_RESOURCE_PREFLIGHT_SHA256: invalid,
        }),
      ).toThrow("invalid-resource-trial");
    }
  });

  it("forwards only process memory and nonattaching discovery, rejecting target attachment", async () => {
    const send = vi.fn().mockResolvedValue({ processInfo: [] });
    const cdp = createResourceCdp(send);
    await expect(cdp.send("SystemInfo.getProcessInfo")).resolves.toEqual({
      processInfo: [],
    });
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    for (const method of [
      "Target.autoAttachRelated",
      "Target.setAutoAttach",
      "Target.attachToTarget",
      "Target.getTargets",
      "Runtime.evaluate",
      "HeapProfiler.collectGarbage",
    ]) {
      await expect(cdp.send(method, {})).rejects.toThrow(
        "forbidden-resource-cdp",
      );
    }
    await expect(
      cdp.send("Target.setDiscoverTargets", { discover: false }),
    ).rejects.toThrow("forbidden-resource-cdp");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("accepts only the expected successful release and no failure counts", () => {
    const valid = {
      ready: false,
      releases: { completed: 2, failed: 0, timedOut: 0, sendFailed: 0 },
    };
    expect(isSuccessfulRelease(valid, 2)).toBe(true);
    for (const invalid of [
      null,
      {},
      { ...valid, ready: true },
      { ...valid, releases: { ...valid.releases, completed: 1 } },
      { ...valid, releases: { ...valid.releases, failed: 1 } },
      { ...valid, releases: { ...valid.releases, timedOut: 1 } },
      { ...valid, releases: { ...valid.releases, sendFailed: 1 } },
      { ...valid, releases: { ...valid.releases, completed: "2" } },
    ]) {
      expect(isSuccessfulRelease(invalid, 2)).toBe(false);
    }
  });
});
