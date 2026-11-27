import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTransformersTokenizer } from "../src/tokenizer.js";

const root = "models/upstream/8d640720bddeb64c89dc1fa7780c3ea29fa523e8";
const fixturePath = "tests/fixtures/tokenizer-reference.json";

describe("upstream tokenizer reference corpus", () => {
  it("matches native token IDs and UTF-16 offsets", async () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      cases: Array<{
        text: string;
        special: boolean;
        ids: number[];
        offsets: [number, number][];
      }>;
    };
    const tokenizer = await createTransformersTokenizer(root);
    for (const expected of fixture.cases) {
      const actual = await tokenizer.encode(expected.text, {
        addSpecialTokens: expected.special,
      });
      expect(actual.inputIds, "token IDs differ").toEqual(expected.ids);
      expect(actual.offsets, "UTF-16 offsets differ").toEqual(expected.offsets);
    }
  });
});
