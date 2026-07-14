import { describe, expect, it } from "vitest";

import topModelsJson from "./top-models.json";
import { TOP_MODELS } from "./top-models.js";

describe("TOP_MODELS", () => {
  it("loads the shared curated allowlist from top-models.json", () => {
    expect(TOP_MODELS).toEqual(topModelsJson);
    expect(new Set(TOP_MODELS).size).toBe(TOP_MODELS.length);
    expect(TOP_MODELS).toContain("openai/gpt-5.6-sol");
    expect(TOP_MODELS).toContain("openai/gpt-5.6-terra");
    expect(TOP_MODELS).toContain("openai/gpt-5.6-luna");
    expect(TOP_MODELS).toContain("xai/grok-4-0709");
    expect(TOP_MODELS).toContain("deepseek/deepseek-reasoner");
  });
});
