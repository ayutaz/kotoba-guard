import { describe, expect, it } from "vitest";
import { originFromUrl } from "./state";
import { isHttpOrigin } from "../shared/security";

describe("site origin boundaries", () => {
  it("accepts only HTTP(S) origins and rejects credentials or paths", () => {
    expect(originFromUrl("https://example.test/writer")).toBe(
      "https://example.test",
    );
    expect(originFromUrl("chrome://settings")).toBeUndefined();
    expect(isHttpOrigin("https://example.test")).toBe(true);
    expect(isHttpOrigin("https://user:pass@example.test")).toBe(false);
    expect(isHttpOrigin("https://example.test/path")).toBe(false);
  });
});
