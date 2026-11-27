import { describe, expect, it } from "vitest";
import { readSourceIdentity } from "../e2e/source-identity";

describe("browser evidence source identity", () => {
  const source = "a".repeat(40);
  const runtime = "b".repeat(40);
  it("keeps test source separate from reused runtime assets", () => {
    expect(
      readSourceIdentity({
        SOURCE_COMMIT: source,
        RUNTIME_SOURCE_COMMIT: runtime,
      }),
    ).toEqual({ sourceCommit: source, runtimeSourceCommit: runtime });
  });
  it("uses the same source for an ordinary same-checkout build", () => {
    expect(readSourceIdentity({ SOURCE_COMMIT: source })).toEqual({
      sourceCommit: source,
      runtimeSourceCommit: source,
    });
  });
  it("marks an unbound local run explicitly", () => {
    expect(readSourceIdentity({})).toEqual({
      sourceCommit: "working-tree",
      runtimeSourceCommit: "working-tree",
    });
  });
  it("rejects malformed explicit source or runtime identities", () => {
    for (const invalid of ["", "main", "a".repeat(39), "A".repeat(40)]) {
      expect(() => readSourceIdentity({ SOURCE_COMMIT: invalid })).toThrow();
      expect(() =>
        readSourceIdentity({
          SOURCE_COMMIT: source,
          RUNTIME_SOURCE_COMMIT: invalid,
        }),
      ).toThrow();
    }
  });
  it("rejects a runtime binding without a fixed test source", () => {
    expect(() =>
      readSourceIdentity({ RUNTIME_SOURCE_COMMIT: runtime }),
    ).toThrow();
  });
});
