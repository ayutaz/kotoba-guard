import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  isSuccessfulOffscreenIdleNotice,
  parseOffscreenIdleTrialEnvironment,
  validateOffscreenIdlePreflight,
  compareOffscreenProcessCohorts,
} from "../diagnostics/offscreen-recreation-contract";

const source = "a".repeat(40);
const model = "b".repeat(64);
const preflightSha = "c".repeat(64);
const output = path.resolve(
  "artifacts/offscreen-idle-recreation",
  source,
  "report.json",
);
const environment = {
  SOURCE_COMMIT: source,
  RUNTIME_SOURCE_COMMIT: source,
  KOTOBA_OFFSCREEN_IDLE_OUTPUT: output,
  KOTOBA_OFFSCREEN_IDLE_PREFLIGHT_SHA256: preflightSha,
};

describe("offscreen recreation contract", () => {
  it("compares only complete positive unique PID-role resume pairs", () => {
    const row = (phase: string) => ({
      phase,
      memory: {
        status: "measured",
        missingPids: [],
        rows: [
          {
            pid: 1,
            role: "renderer",
            currentBytes: phase === "resume-1" ? 100 : 240,
          },
        ],
      },
    });
    const first = row("resume-1"),
      second = row("resume-2");
    expect(compareOffscreenProcessCohorts([first, second])).toEqual({
      ratio: 2.4,
      cohortMatch: true,
    });
    for (const memory of [
      {
        ...second.memory,
        rows: [{ pid: 2, role: "renderer", currentBytes: 240 }],
      },
      { ...second.memory, rows: [{ pid: 1, role: "GPU", currentBytes: 240 }] },
      {
        ...second.memory,
        rows: [second.memory.rows[0]!, second.memory.rows[0]!],
      },
      {
        ...second.memory,
        rows: [{ pid: 1, role: "renderer", currentBytes: 0 }],
      },
      { ...second.memory, status: "partial" },
    ])
      expect(
        compareOffscreenProcessCohorts([first, { ...second, memory }]),
      ).toEqual({ ratio: null, cohortMatch: false });
    expect(compareOffscreenProcessCohorts([first, first, second])).toEqual({
      ratio: null,
      cohortMatch: false,
    });
  });
  it("requires a source-bound output and same runtime source", () => {
    expect(parseOffscreenIdleTrialEnvironment(environment)).toEqual({
      sourceCommit: source,
      runtimeSourceCommit: source,
      output,
      preflightSha256: preflightSha,
    });
    expect(() =>
      parseOffscreenIdleTrialEnvironment({
        ...environment,
        RUNTIME_SOURCE_COMMIT: "d".repeat(40),
      }),
    ).toThrow("invalid-offscreen-idle-trial");
  });

  it("requires all 81 clean assets and the pinned model hash", () => {
    const assets = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [
        `asset-${index}`,
        { bytes: 1, sha256: "d".repeat(64) },
      ]),
    );
    assets["models/onnx/model_quantized.onnx"] = {
      bytes: 1,
      sha256: model,
    };
    expect(
      validateOffscreenIdlePreflight(
        {
          source_commit: source,
          runtime_source_commit: source,
          source_clean: true,
          assets,
        },
        parseOffscreenIdleTrialEnvironment(environment),
        preflightSha,
        model,
      ),
    ).toEqual(assets);
    expect(() =>
      validateOffscreenIdlePreflight(
        {
          source_commit: source,
          runtime_source_commit: source,
          source_clean: true,
          assets: { ...assets, extra: { bytes: 1, sha256: "d".repeat(64) } },
        },
        parseOffscreenIdleTrialEnvironment(environment),
        preflightSha,
        model,
      ),
    ).toThrow("invalid-offscreen-idle-preflight");
  });

  it("accepts only exact release counts from the current document", () => {
    const valid = {
      documentId: "document-2",
      senderDocumentId: null,
      releases: { completed: 2, failed: 0, timedOut: 0, sendFailed: 0 },
    };
    expect(isSuccessfulOffscreenIdleNotice(valid, 2, "document-2")).toBe(true);
    expect(
      isSuccessfulOffscreenIdleNotice(
        { ...valid, senderDocumentId: "document-2" },
        2,
        "document-2",
      ),
    ).toBe(true);
    expect(isSuccessfulOffscreenIdleNotice(valid, 2, "document-1")).toBe(false);
    expect(
      isSuccessfulOffscreenIdleNotice(
        { ...valid, senderDocumentId: "document-1" },
        2,
        "document-2",
      ),
    ).toBe(false);
    expect(
      isSuccessfulOffscreenIdleNotice(
        { ...valid, documentId: "document-1" },
        2,
        "document-2",
      ),
    ).toBe(false);
    const missingDocumentId: Partial<typeof valid> = { ...valid };
    delete missingDocumentId.documentId;
    expect(
      isSuccessfulOffscreenIdleNotice(missingDocumentId, 2, "document-2"),
    ).toBe(false);
    const missingSenderDocumentId: Partial<typeof valid> = { ...valid };
    delete missingSenderDocumentId.senderDocumentId;
    expect(
      isSuccessfulOffscreenIdleNotice(missingSenderDocumentId, 2, "document-2"),
    ).toBe(false);
    expect(
      isSuccessfulOffscreenIdleNotice(
        { ...valid, releases: { ...valid.releases, failed: 1 } },
        2,
        "document-2",
      ),
    ).toBe(false);
    expect(
      isSuccessfulOffscreenIdleNotice(
        { ...valid, releases: { ...valid.releases, extra: 0 } },
        2,
        "document-2",
      ),
    ).toBe(false);
    expect(
      isSuccessfulOffscreenIdleNotice(
        { ...valid, extra: true },
        2,
        "document-2",
      ),
    ).toBe(false);
    expect(
      isSuccessfulOffscreenIdleNotice(
        { ...valid, releases: { ...valid.releases, completed: 0.5 } },
        0.5,
        "document-2",
      ),
    ).toBe(false);
  });
});
