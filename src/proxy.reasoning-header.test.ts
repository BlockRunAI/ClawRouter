import { validateHeaderValue } from "node:http";

import { describe, expect, it } from "vitest";

import { classifyByRules } from "./router/rules.js";
import { DEFAULT_ROUTING_CONFIG } from "./router/config.js";
import { debugHeadersEnabledFromEnv, sanitizeHeaderValue } from "./proxy.js";

describe("sanitizeHeaderValue", () => {
  it("leaves plain ASCII values untouched", () => {
    const value = "score=0.42 | code (function, class), technical (api, query) | agentic (tools)";
    expect(sanitizeHeaderValue(value)).toBe(value);
  });

  it("percent-encodes Cyrillic so Node accepts the header value", () => {
    const value = "score=0.55 | code (функция, класс, импорт)";
    const sanitized = sanitizeHeaderValue(value);
    expect(sanitized).not.toMatch(/[^\t\x20-\x7E]/);
    // Node's own validator is the ground truth: this must not throw
    expect(() => validateHeaderValue("x-clawrouter-reasoning", sanitized)).not.toThrow();
    // ASCII structure stays readable
    expect(sanitized).toContain("score=0.55 | code (");
    // Encoding is reversible for debugging
    expect(decodeURIComponent(sanitized)).toBe(value);
  });

  it("handles CJK and astral characters (emoji) without throwing", () => {
    const value = "code (函数, 関数) 🚀";
    const sanitized = sanitizeHeaderValue(value);
    expect(() => validateHeaderValue("x-clawrouter-reasoning", sanitized)).not.toThrow();
    expect(decodeURIComponent(sanitized)).toBe(value);
  });

  it("strips control characters that percent-encoding alone would not fix", () => {
    const sanitized = sanitizeHeaderValue("line1\r\nline2\x00end");
    expect(() => validateHeaderValue("x-clawrouter-reasoning", sanitized)).not.toThrow();
  });

  it("never throws on lone surrogates", () => {
    const sanitized = sanitizeHeaderValue(`bad ${String.fromCharCode(0xd800)} char`);
    expect(() => validateHeaderValue("x-clawrouter-reasoning", sanitized)).not.toThrow();
  });

  it("produces a valid header value for the real Russian-prompt repro", () => {
    // The exact failure path from the field report: a Russian coding prompt
    // matches the multilingual code keywords in router/config.ts, the matched
    // Cyrillic keywords land in the routing signals, and the joined reasoning
    // string used to go raw into the x-clawrouter-reasoning header.
    const prompt =
      "Напиши функция для сортировки. Каждый класс должен использовать импорт и вернуть результат. Запрос асинхронный.";
    const result = classifyByRules(prompt, undefined, 64, DEFAULT_ROUTING_CONFIG.scoring);
    const reasoning = `score=${result.score.toFixed(2)} | ${result.signals.join(", ")}`;
    // Precondition: the repro really does produce non-ASCII reasoning
    expect(Array.from(reasoning).some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f)).toBe(true);
    expect(() => validateHeaderValue("x-clawrouter-reasoning", reasoning)).toThrow();

    const sanitized = sanitizeHeaderValue(reasoning);
    expect(() => validateHeaderValue("x-clawrouter-reasoning", sanitized)).not.toThrow();
  });
});

describe("debugHeadersEnabledFromEnv", () => {
  it("is enabled by default", () => {
    expect(debugHeadersEnabledFromEnv({})).toBe(true);
  });

  it.each(["0", "false", "off", "FALSE", "Off"])(
    "is disabled by CLAWROUTER_DEBUG_HEADERS=%s",
    (v) => {
      expect(debugHeadersEnabledFromEnv({ CLAWROUTER_DEBUG_HEADERS: v })).toBe(false);
    },
  );

  it("treats other values as enabled", () => {
    expect(debugHeadersEnabledFromEnv({ CLAWROUTER_DEBUG_HEADERS: "1" })).toBe(true);
    expect(debugHeadersEnabledFromEnv({ CLAWROUTER_DEBUG_HEADERS: "on" })).toBe(true);
  });
});
