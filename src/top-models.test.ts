import { describe, expect, it } from "vitest";

import topModelsJson from "./top-models.json";
import { TOP_MODELS } from "./top-models.js";

describe("TOP_MODELS", () => {
  it("loads the shared curated allowlist from top-models.json", () => {
    expect(TOP_MODELS).toEqual(topModelsJson);
    expect(new Set(TOP_MODELS).size).toBe(TOP_MODELS.length);
    expect(TOP_MODELS).toContain("openai/gpt-5.5");
    expect(TOP_MODELS).toContain("xai/grok-4.5");
    expect(TOP_MODELS).toContain("anthropic/claude-fable-5");
    expect(TOP_MODELS).toContain("deepseek/deepseek-reasoner");
    expect(TOP_MODELS).toContain("free/step-3.7-flash");
    // Retired from the advertised catalog 2026-07 — must not reappear.
    expect(TOP_MODELS).not.toContain("xai/grok-4-0709");
    expect(TOP_MODELS).not.toContain("xai/grok-3");
    expect(TOP_MODELS).not.toContain("free/gpt-oss-120b");
  });
});
