import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_TOKENS, resolveMaxTokens } from "./proxy.js";

/**
 * Regression cover for the output-token budget the proxy derives from a chat
 * request body.
 *
 * That single number drives four things: the routing decision, `estimateAmount`
 * (balance pre-check), the strict-mode `maxCostPerRun` cap, and the
 * `chargedOutputTokens` figure in `logUsage`. Under-reading it does not just
 * skew a log — it lets a request slip past a cost cap the user set.
 *
 * OpenAI deprecated `max_tokens` in favour of `max_completion_tokens`, and the
 * proxy only ever read the former, so any client on the newer field was priced
 * at the 4096 default no matter how much output it actually asked for.
 */
describe("resolveMaxTokens", () => {
  it("reads the legacy max_tokens field", () => {
    expect(resolveMaxTokens({ max_tokens: 512 })).toBe(512);
  });

  it("reads max_completion_tokens when max_tokens is absent", () => {
    // The bug: a caller on OpenAI's current field was silently priced at 4096.
    expect(resolveMaxTokens({ max_completion_tokens: 65536 })).toBe(65536);
  });

  it("takes the larger value when a client sends both", () => {
    // OpenAI rejects both-at-once, so there is no single "correct" reading.
    // Bias to the larger: over-estimating costs the user a bigger pre-check,
    // under-estimating walks them through a cost cap.
    expect(resolveMaxTokens({ max_tokens: 4096, max_completion_tokens: 65536 })).toBe(65536);
    expect(resolveMaxTokens({ max_tokens: 65536, max_completion_tokens: 4096 })).toBe(65536);
  });

  it("falls back to the default when neither field is present", () => {
    expect(resolveMaxTokens({})).toBe(DEFAULT_MAX_TOKENS);
    expect(resolveMaxTokens({ messages: [], model: "x" })).toBe(DEFAULT_MAX_TOKENS);
  });

  it("ignores values that cannot be a token budget", () => {
    // null/undefined/0 already fell back before this change — keep that.
    expect(resolveMaxTokens({ max_tokens: null })).toBe(DEFAULT_MAX_TOKENS);
    expect(resolveMaxTokens({ max_tokens: 0 })).toBe(DEFAULT_MAX_TOKENS);
    expect(resolveMaxTokens({ max_completion_tokens: 0 })).toBe(DEFAULT_MAX_TOKENS);
    // Garbage must not poison arithmetic downstream (NaN would make every
    // estimateAmount comparison false, silently disabling the cost cap).
    expect(resolveMaxTokens({ max_tokens: "lots" })).toBe(DEFAULT_MAX_TOKENS);
    expect(resolveMaxTokens({ max_completion_tokens: {} })).toBe(DEFAULT_MAX_TOKENS);
    expect(resolveMaxTokens({ max_tokens: Number.NaN })).toBe(DEFAULT_MAX_TOKENS);
    expect(resolveMaxTokens({ max_tokens: Number.POSITIVE_INFINITY })).toBe(DEFAULT_MAX_TOKENS);
    expect(resolveMaxTokens({ max_tokens: -1 })).toBe(DEFAULT_MAX_TOKENS);
  });

  it("keeps a valid field when the other one is garbage", () => {
    expect(resolveMaxTokens({ max_tokens: null, max_completion_tokens: 8192 })).toBe(8192);
    expect(resolveMaxTokens({ max_tokens: 8192, max_completion_tokens: "nope" })).toBe(8192);
  });
});
