import { describe, expect, it } from "vitest";

import { resolveModelAlias } from "./models.js";

describe("resolveModelAlias", () => {
  it("maps Claude aliases to newest 4.6 versions", () => {
    // Use newest versions (4.6) with full provider prefix
    expect(resolveModelAlias("claude")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelAlias("sonnet")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelAlias("opus")).toBe("anthropic/claude-opus-4.6");
    expect(resolveModelAlias("haiku")).toBe("anthropic/claude-haiku-4.5");
  });

  it("resolves aliases even when sent with blockrun/ prefix", () => {
    expect(resolveModelAlias("blockrun/claude")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelAlias("blockrun/sonnet-4.6")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelAlias("blockrun/opus")).toBe("anthropic/claude-opus-4.6");
  });

  it("maps legacy Claude IDs to 4.6", () => {
    expect(resolveModelAlias("anthropic/claude-sonnet-4")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelAlias("anthropic/claude-opus-4")).toBe("anthropic/claude-opus-4.6");
    expect(resolveModelAlias("anthropic/claude-opus-4.5")).toBe("anthropic/claude-opus-4.6");
  });

  it("strips openai/ prefix from virtual routing profiles (issue #78)", () => {
    // OpenClaw sends virtual profiles as "openai/eco", "openai/free", etc.
    expect(resolveModelAlias("openai/eco")).toBe("eco");
    expect(resolveModelAlias("openai/free")).toBe("free");
    expect(resolveModelAlias("openai/auto")).toBe("auto");
    expect(resolveModelAlias("openai/premium")).toBe("premium");
  });

  it("strips openai/ prefix from aliases", () => {
    expect(resolveModelAlias("openai/claude")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveModelAlias("openai/sonnet")).toBe("anthropic/claude-sonnet-4.6");
  });

  it("redirects delisted grok-code-fast-1 IDs to deepseek", () => {
    expect(resolveModelAlias("xai/grok-code-fast-1")).toBe("deepseek/deepseek-chat");
    expect(resolveModelAlias("blockrun/xai/grok-code-fast-1")).toBe("deepseek/deepseek-chat");
    expect(resolveModelAlias("grok-code-fast-1")).toBe("deepseek/deepseek-chat");
  });

  it("resolves Novita AI aliases", () => {
    expect(resolveModelAlias("novita")).toBe("novita/kimi-k2.5");
    expect(resolveModelAlias("novita-kimi")).toBe("novita/kimi-k2.5");
    expect(resolveModelAlias("novita-glm")).toBe("novita/glm-5");
    expect(resolveModelAlias("novita-minimax")).toBe("novita/minimax-m2.5");
  });

  it("passes through novita/ model IDs unchanged", () => {
    expect(resolveModelAlias("novita/kimi-k2.5")).toBe("novita/kimi-k2.5");
    expect(resolveModelAlias("novita/glm-5")).toBe("novita/glm-5");
    expect(resolveModelAlias("novita/minimax-m2.5")).toBe("novita/minimax-m2.5");
  });

  it("resolves Novita aliases with blockrun/ prefix", () => {
    expect(resolveModelAlias("blockrun/novita-kimi")).toBe("novita/kimi-k2.5");
    expect(resolveModelAlias("blockrun/novita")).toBe("novita/kimi-k2.5");
  });
});
