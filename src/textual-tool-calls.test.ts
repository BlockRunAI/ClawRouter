import { describe, expect, it } from "vitest";

import { extractTextualToolCalls } from "./textual-tool-calls.js";

describe("extractTextualToolCalls", () => {
  describe("OpenClaw <tool_call><arg_key>/<arg_value> format", () => {
    it("extracts a single tool call with one arg", () => {
      const content =
        "<tool_call>web_search<arg_key>query</arg_key><arg_value>hello world</arg_value></tool_call>";
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.function.name).toBe("web_search");
      expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({
        query: "hello world",
      });
      expect(result.cleanedContent).toBe("");
    });

    it("extracts a tool call with multiple args (transcript format)", () => {
      const content =
        "<tool_call>web_search<arg_key>count</arg_key><arg_value>5</arg_value><arg_key>query</arg_key><arg_value>Alpha Degen YouTube contact email crypto</arg_value></tool_call>";
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.function.name).toBe("web_search");
      const args = JSON.parse(result.toolCalls[0]!.function.arguments) as Record<string, unknown>;
      expect(args.count).toBe(5); // numeric coerced
      expect(args.query).toBe("Alpha Degen YouTube contact email crypto");
    });

    it("extracts multiple back-to-back tool calls", () => {
      const content =
        "<tool_call>a<arg_key>q</arg_key><arg_value>1</arg_value></tool_call>" +
        "<tool_call>b<arg_key>q</arg_key><arg_value>2</arg_value></tool_call>";
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0]?.function.name).toBe("a");
      expect(result.toolCalls[1]?.function.name).toBe("b");
      expect(result.cleanedContent).toBe("");
    });

    it("strips the tool call from surrounding prose, keeping prose intact", () => {
      const content =
        "Sure, let me search.\n<tool_call>web_search<arg_key>query</arg_key><arg_value>x</arg_value></tool_call>\nDone.";
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.cleanedContent.trim()).toBe("Sure, let me search.\n\nDone.".trim());
    });

    it("coerces numeric and boolean arg values via JSON-parse fallback", () => {
      const content =
        "<tool_call>fn<arg_key>n</arg_key><arg_value>42</arg_value><arg_key>b</arg_key><arg_value>true</arg_value><arg_key>s</arg_key><arg_value>hello</arg_value></tool_call>";
      const result = extractTextualToolCalls(content);
      const args = JSON.parse(result.toolCalls[0]!.function.arguments) as Record<string, unknown>;
      expect(args.n).toBe(42);
      expect(args.b).toBe(true);
      expect(args.s).toBe("hello");
    });

    it("generates a unique OpenAI-shaped tool_call id", () => {
      const content =
        "<tool_call>x<arg_key>q</arg_key><arg_value>1</arg_value></tool_call>" +
        "<tool_call>y<arg_key>q</arg_key><arg_value>2</arg_value></tool_call>";
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls[0]?.id).toMatch(/^call_[A-Za-z0-9_-]+$/);
      expect(result.toolCalls[0]?.id).not.toBe(result.toolCalls[1]?.id);
      expect(result.toolCalls[0]?.type).toBe("function");
    });
  });

  describe("Anthropic <function_calls><invoke> format", () => {
    it("extracts a single invoke with one parameter", () => {
      const content =
        '<function_calls>\n<invoke name="web_search">\n<parameter name="query">hello</parameter>\n</invoke>\n</function_calls>';
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.function.name).toBe("web_search");
      expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({ query: "hello" });
      expect(result.cleanedContent).toBe("");
    });

    it("extracts multiple invokes inside one function_calls block", () => {
      const content =
        "<function_calls>" +
        '<invoke name="a"><parameter name="q">1</parameter></invoke>' +
        '<invoke name="b"><parameter name="q">2</parameter></invoke>' +
        "</function_calls>";
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls.map((c) => c.function.name)).toEqual(["a", "b"]);
    });

    it("handles single quotes around attribute names", () => {
      const content =
        "<function_calls><invoke name='ws'><parameter name='q'>hi</parameter></invoke></function_calls>";
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls[0]?.function.name).toBe("ws");
    });
  });

  describe('Gemini [Called function "NAME" with args: {...}] transcript format', () => {
    it("extracts a single tool call (issue #189 repro)", () => {
      const content = '[Called function "terminal" with args: {"command":"whoami"}]';
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.function.name).toBe("terminal");
      expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({ command: "whoami" });
      expect(result.cleanedContent).toBe("");
    });

    it("extracts a call with multiple args", () => {
      const content =
        '[Called function "search_files" with args: {"pattern":"*","target":"files"}]';
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.function.name).toBe("search_files");
      expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({
        pattern: "*",
        target: "files",
      });
    });

    it("extracts an empty-args call", () => {
      const content = '[Called function "list" with args: {}]';
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.function.name).toBe("list");
      expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({});
    });

    it("handles nested JSON objects and brackets in args without truncating", () => {
      const content =
        '[Called function "write" with args: {"path":"a]b","data":{"k":[1,2,{"x":"}"}]}}]';
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls).toHaveLength(1);
      expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({
        path: "a]b",
        data: { k: [1, 2, { x: "}" }] },
      });
      expect(result.cleanedContent).toBe("");
    });

    it("extracts multiple transcripts and strips surrounding prose", () => {
      const content =
        'Let me check.\n[Called function "a" with args: {"q":1}]\nThen:\n[Called function "b" with args: {"q":2}]';
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls.map((c) => c.function.name)).toEqual(["a", "b"]);
      expect(result.cleanedContent).not.toContain("Called function");
      expect(result.cleanedContent).toContain("Let me check.");
      expect(result.cleanedContent).toContain("Then:");
    });

    it("generates OpenAI-shaped ids", () => {
      const content = '[Called function "x" with args: {"q":1}]';
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls[0]?.id).toMatch(/^call_[A-Za-z0-9_-]+$/);
      expect(result.toolCalls[0]?.type).toBe("function");
    });

    it("does NOT mis-fire without a closing bracket", () => {
      const content = '[Called function "x" with args: {"q":1}';
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls).toHaveLength(0);
      expect(result.cleanedContent).toBe(content);
    });

    it("does NOT mis-fire when args is not a JSON object", () => {
      const content = '[Called function "x" with args: "whoami"]';
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls).toHaveLength(0);
      expect(result.cleanedContent).toBe(content);
    });
  });

  describe("Negative cases (must NOT mis-fire)", () => {
    it("returns empty toolCalls when no tool-call XML present", () => {
      const result = extractTextualToolCalls("Just a normal sentence.");
      expect(result.toolCalls).toHaveLength(0);
      expect(result.cleanedContent).toBe("Just a normal sentence.");
    });

    it("ignores prose mentioning `<tool_call>` with no args (treated as documentation)", () => {
      const content =
        "The format `<tool_call>name</tool_call>` is what some models use, but I'm not calling one.";
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls).toHaveLength(0);
      expect(result.cleanedContent).toBe(content);
    });

    it("ignores a single unclosed <tool_call> tag", () => {
      const content = "Open: <tool_call>name<arg_key>q</arg_key><arg_value>v</arg_value>";
      const result = extractTextualToolCalls(content);
      expect(result.toolCalls).toHaveLength(0);
      expect(result.cleanedContent).toBe(content);
    });

    it("ignores empty content", () => {
      const result = extractTextualToolCalls("");
      expect(result.toolCalls).toHaveLength(0);
      expect(result.cleanedContent).toBe("");
    });
  });
});
