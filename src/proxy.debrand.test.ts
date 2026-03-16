import { describe, expect, it } from "vitest";

import { debrandSystemMessages } from "./proxy.js";

describe("debrandSystemMessages", () => {
  it("replaces blockrun/auto with the resolved model in system messages", () => {
    const messages = [
      {
        role: "system",
        content:
          "You are a personal assistant.\n\n## Runtime\nRuntime: model=blockrun/auto | default_model=blockrun/auto",
      },
      { role: "user", content: "Hello" },
    ];

    const result = debrandSystemMessages(messages, "deepseek/deepseek-chat");

    expect(result[0].content).toBe(
      "You are a personal assistant.\n\n## Runtime\nRuntime: model=deepseek/deepseek-chat | default_model=deepseek/deepseek-chat",
    );
    // User message untouched
    expect(result[1].content).toBe("Hello");
  });

  it("replaces blockrun/eco and blockrun/premium profiles", () => {
    const messages = [
      {
        role: "system",
        content: "model=blockrun/eco | default_model=blockrun/premium",
      },
    ];

    const result = debrandSystemMessages(messages, "google/gemini-2.5-flash");

    expect(result[0].content).toBe(
      "model=google/gemini-2.5-flash | default_model=google/gemini-2.5-flash",
    );
  });

  it("strips blockrun/ prefix from explicit model names", () => {
    const messages = [
      {
        role: "system",
        content: "model=blockrun/openai/gpt-4o | default_model=blockrun/auto",
      },
    ];

    const result = debrandSystemMessages(messages, "openai/gpt-4o");

    expect(result[0].content).toBe(
      "model=openai/gpt-4o | default_model=openai/gpt-4o",
    );
  });

  it("does not modify non-system messages", () => {
    const messages = [
      { role: "user", content: "I use blockrun/auto for my tasks" },
      { role: "assistant", content: "I'm Blockrun!" },
    ];

    const result = debrandSystemMessages(messages, "deepseek/deepseek-chat");

    expect(result[0].content).toBe("I use blockrun/auto for my tasks");
    expect(result[1].content).toBe("I'm Blockrun!");
  });

  it("returns same array reference when no changes needed", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hi" },
    ];

    const result = debrandSystemMessages(messages, "deepseek/deepseek-chat");

    expect(result).toBe(messages); // same reference = no copy
  });

  it("handles non-string system content gracefully", () => {
    const messages = [
      { role: "system", content: [{ type: "text", text: "blockrun/auto" }] },
    ];

    const result = debrandSystemMessages(messages, "deepseek/deepseek-chat");

    // Array content is not modified (only string content)
    expect(result).toBe(messages);
  });

  it("is case-insensitive for blockrun prefix", () => {
    const messages = [
      { role: "system", content: "model=Blockrun/Auto" },
    ];

    const result = debrandSystemMessages(messages, "deepseek/deepseek-chat");

    expect(result[0].content).toBe("model=deepseek/deepseek-chat");
  });

  it("replaces blockrun/free profile", () => {
    const messages = [
      { role: "system", content: "default_model=blockrun/free" },
    ];

    const result = debrandSystemMessages(messages, "nvidia/gpt-oss-120b");

    expect(result[0].content).toBe("default_model=nvidia/gpt-oss-120b");
  });
});
