import { describe, expect, it } from "vitest";

import { estimateAmount, estimateBalancePreflightAmount } from "./proxy.js";

const HIGH_OUTPUT_MODELS = ["anthropic/claude-opus-5", "openai/gpt-5.2"];

describe("balance preflight estimate", () => {
  it.each(HIGH_OUTPUT_MODELS)(
    "caps huge max_tokens values for %s to avoid assuming worst-case model output",
    (modelId) => {
      const highCapEstimate = estimateBalancePreflightAmount(modelId, 100_000, 128_000);
      const cappedEstimate = estimateBalancePreflightAmount(modelId, 100_000, 4096);

      expect(highCapEstimate).toBe(cappedEstimate);
    },
  );

  it.each(HIGH_OUTPUT_MODELS)("honors smaller explicit output caps for %s", (modelId) => {
    const smallEstimate = estimateBalancePreflightAmount(modelId, 100_000, 1024);
    const cappedEstimate = estimateBalancePreflightAmount(modelId, 100_000, 4096);

    expect(Number(smallEstimate)).toBeLessThan(Number(cappedEstimate));
  });

  it.each(HIGH_OUTPUT_MODELS)("keeps the general estimator exact for %s", (modelId) => {
    const highCapEstimate = estimateAmount(modelId, 100_000, 128_000);
    const cappedEstimate = estimateAmount(modelId, 100_000, 4096);

    expect(Number(highCapEstimate)).toBeGreaterThan(Number(cappedEstimate));
  });
});
