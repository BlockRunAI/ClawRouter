/**
 * Docs that show `"alias" → "model-id"` examples must match what
 * resolveModelAlias() actually returns. These examples rot silently when an
 * alias is promoted (issue #530: opus/grok/deepseek/sonnet had all drifted).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveModelAlias } from "./models.js";

const DOCS = ["docs/clawrouter-vs-openrouter-llm-routing-comparison.md"];

const ARROW_LINE = /^"([^"]+)"\s+→\s+"([^"]+)"\s*$/gm;

describe("doc alias examples match MODEL_ALIASES", () => {
  for (const doc of DOCS) {
    const text = readFileSync(fileURLToPath(new URL(`../${doc}`, import.meta.url)), "utf8");
    const pairs = [...text.matchAll(ARROW_LINE)].map((m) => [m[1], m[2]] as const);

    it(`${doc} has alias examples to check`, () => {
      expect(pairs.length).toBeGreaterThan(0);
    });

    for (const [alias, documented] of pairs) {
      it(`${doc}: "${alias}" → "${documented}"`, () => {
        expect(resolveModelAlias(alias)).toBe(documented);
      });
    }
  }
});
