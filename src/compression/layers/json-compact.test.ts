import { describe, it, expect } from "vitest";
import { compactJson, compactMessagesJson } from "./json-compact.js";
import { compressContext } from "../index.js";
import type { NormalizedMessage } from "../types.js";

describe("JSON Compaction Layer", () => {
  describe("compactJson", () => {
    it("preserves integers above Number.MAX_SAFE_INTEGER losslessly", () => {
      const input = '{ "ticket_id": 9007199254740993, "large_uint64": 18446744073709551615 }';
      const result = compactJson(input);
      expect(result).toBe('{"ticket_id":9007199254740993,"large_uint64":18446744073709551615}');
    });

    it("preserves arbitrarily large integer strings without converting to scientific notation", () => {
      const input = '{\n  "owner": 1234567890123456789012\n}';
      const result = compactJson(input);
      expect(result).toBe('{"owner":1234567890123456789012}');
    });

    it("preserves negative large integers losslessly", () => {
      const input = '{ "neg_id": -9007199254740993, "neg_big": -18446744073709551615 }';
      const result = compactJson(input);
      expect(result).toBe('{"neg_id":-9007199254740993,"neg_big":-18446744073709551615}');
    });

    it("preserves large exponents and floating point numbers beyond JS float limit", () => {
      const input = '{ "ratio": 1e400, "tiny": 1e-400 }';
      const result = compactJson(input);
      expect(result).toBe('{"ratio":1e400,"tiny":1e-400}');
    });

    it("preserves high-precision floating point numbers without rounding", () => {
      const input = '{\n  "pi": 3.1415926535897932384626433832795028841971\n}';
      const result = compactJson(input);
      expect(result).toBe('{"pi":3.1415926535897932384626433832795028841971}');
    });

    it("preserves whitespace inside strings while stripping formatting outside strings", () => {
      const input = '{\n  "message": "  hello   world  \\n  with   spaces  "\n}';
      const result = compactJson(input);
      expect(result).toBe('{"message":"  hello   world  \\n  with   spaces  "}');
    });

    it("correctly handles escaped quotes and backslashes in strings", () => {
      const input =
        '{\n  "quote": "hello \\"escaped\\" world",\n  "path": "C:\\\\Users\\\\name",\n  "mixed": "\\\\\\""\n}';
      const result = compactJson(input);
      expect(result).toBe(
        '{"quote":"hello \\"escaped\\" world","path":"C:\\\\Users\\\\name","mixed":"\\\\\\""}',
      );
    });

    it("minifies nested objects and arrays with mixed data types", () => {
      const input = JSON.stringify(
        {
          items: [
            { id: "9007199254740993", val: 1 },
            { id: "18446744073709551615", val: 2 },
          ],
          active: true,
          meta: null,
        },
        null,
        2,
      ).replace(/"(9007199254740993|18446744073709551615)"/g, "$1");

      const result = compactJson(input);
      expect(result).toBe(
        '{"items":[{"id":9007199254740993,"val":1},{"id":18446744073709551615,"val":2}],"active":true,"meta":null}',
      );
    });

    it("returns invalid JSON unchanged", () => {
      const invalidCases = [
        '{ unquoted_key: "value" }',
        '{"trailing": "comma",}',
        '{"unclosed": "brace"',
        "Not valid json at all",
        "",
      ];

      for (const invalid of invalidCases) {
        expect(compactJson(invalid)).toBe(invalid);
      }
    });
  });

  describe("compactMessagesJson", () => {
    it("compacts tool calls arguments and tool message content", () => {
      const messages: NormalizedMessage[] = [
        { role: "user", content: "Check status" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "lookup_ticket",
                arguments: '{\n  "ticket_id": 9007199254740993,\n  "ratio": 1e400\n}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: '{\n  "ticket_id": 9007199254740993,\n  "owner": 1234567890123456789012\n}',
        },
      ];

      const { messages: compacted, charsSaved } = compactMessagesJson(messages);

      expect(compacted[1].tool_calls?.[0].function.arguments).toBe(
        '{"ticket_id":9007199254740993,"ratio":1e400}',
      );
      expect(compacted[2].content).toBe(
        '{"ticket_id":9007199254740993,"owner":1234567890123456789012}',
      );
      expect(charsSaved).toBeGreaterThan(0);
    });

    it("leaves tool messages with plain non-JSON text untouched", () => {
      const messages: NormalizedMessage[] = [
        {
          role: "tool",
          tool_call_id: "call_2",
          content: "Plain text error: ticket not found",
        },
      ];

      const { messages: compacted, charsSaved } = compactMessagesJson(messages);
      expect(compacted[0].content).toBe("Plain text error: ticket not found");
      expect(charsSaved).toBe(0);
    });
  });

  describe("compressContext integration (Issue #593 repro)", () => {
    it("preserves big numbers, exponents, and precision in end-to-end compression", async () => {
      const messages: NormalizedMessage[] = [
        { role: "system", content: "x".repeat(6000) },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: {
                name: "close",
                arguments: '{ "ticket_id": 9007199254740993, "ratio": 1e400 }',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "c1",
          content: '{ "ticket_id": 9007199254740993, "owner": 1234567890123456789012 }',
        },
      ];

      const result = await compressContext(messages, {
        enabled: true,
        preserveRaw: false,
        layers: {
          deduplication: true,
          whitespace: true,
          dictionary: false,
          paths: false,
          jsonCompact: true,
          observation: false,
          dynamicCodebook: false,
        },
        dictionary: {
          maxEntries: 50,
          minPhraseLength: 15,
          includeCodebookHeader: false,
        },
      });

      expect(result.messages[1].tool_calls?.[0].function.arguments).toBe(
        '{"ticket_id":9007199254740993,"ratio":1e400}',
      );
      expect(result.messages[2].content).toBe(
        '{"ticket_id":9007199254740993,"owner":1234567890123456789012}',
      );
    });
  });
});
