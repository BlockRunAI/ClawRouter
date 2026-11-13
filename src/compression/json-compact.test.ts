import { describe, expect, it } from "vitest";
import { compactMessagesJson } from "./layers/json-compact.js";
import type { NormalizedMessage } from "./types.js";

function toolResult(content: string): NormalizedMessage {
  return { role: "tool", tool_call_id: "c1", content };
}

function compact(content: string): string {
  return compactMessagesJson([toolResult(content)]).messages[0].content as string;
}

describe("compactMessagesJson", () => {
  it("removes whitespace between tokens", () => {
    expect(compact('{\n  "a": [1, 2,\t3],\r\n  "b": { "c": null }\n}')).toBe(
      '{"a":[1,2,3],"b":{"c":null}}',
    );
  });

  it("keeps whitespace, escapes and quotes inside strings", () => {
    const src = '{ "k": "a  b\\" , \\\\", "e": "\\u00e9\\/" }';
    expect(compact(src)).toBe('{"k":"a  b\\" , \\\\","e":"\\u00e9\\/"}');
  });

  it("keeps integers above 2^53 and out-of-range numbers as written", () => {
    expect(compact('{ "id": 9007199254740993, "n": 1234567890123456789012, "x": 1e400 }')).toBe(
      '{"id":9007199254740993,"n":1234567890123456789012,"x":1e400}',
    );
  });

  it("keeps number spelling such as 1.0 and 1E2", () => {
    expect(compact("[ 1.0, 1E2, -0 ]")).toBe("[1.0,1E2,-0]");
  });

  it("leaves invalid JSON alone", () => {
    const bad = "{ 'a': 1, }";
    expect(compact(bad)).toBe(bad);
  });

  it("compacts tool_call arguments without changing big integers", () => {
    const msg: NormalizedMessage = {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "close", arguments: '{ "ticket_id": 9007199254740993 }' },
        },
      ],
    };
    const out = compactMessagesJson([msg]).messages[0];
    expect(out.tool_calls?.[0].function.arguments).toBe('{"ticket_id":9007199254740993}');
  });

  it("leaves non-string tool_call arguments alone", () => {
    for (const args of [null, 5, true]) {
      const msg = {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: args } }],
      } as unknown as NormalizedMessage;
      expect(compactMessagesJson([msg]).messages[0].tool_calls?.[0].function.arguments).toBe(args);
    }
  });

  it("random JSON: same value as the source and no whitespace left outside strings", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
    const str = () =>
      JSON.stringify(
        Array.from({ length: Math.floor(rnd() * 6) }, () =>
          pick(["a", " ", "  ", '"', "\\", "\n", "\t", "é", "\u{1F600}", "/", "{", "]"]),
        ).join(""),
      );
    const num = () => pick(["0", "-0", "1.5", "1e5", "1E-2", "12345678901234567890", "1e400", "7"]);
    const ws = () => pick(["", " ", "\n", "\t ", "\r\n  "]);
    const gen = (d: number): string => {
      const k = Math.floor(rnd() * (d > 3 ? 3 : 5));
      if (k === 0) return str();
      if (k === 1) return num();
      if (k === 2) return pick(["true", "false", "null"]);
      const n = Math.floor(rnd() * 4);
      if (k === 3) {
        const items = Array.from({ length: n }, () => ws() + gen(d + 1) + ws());
        return "[" + ws() + items.join(",") + ws() + "]";
      }
      const items = Array.from(
        { length: n },
        (_, i) => `${ws()}"k${i}"${ws()}:${ws()}${gen(d + 1)}${ws()}`,
      );
      return "{" + ws() + items.join(",") + ws() + "}";
    };
    const outsideStrings = /"(?:[^"\\]|\\.)*"|\s+/g;
    for (let i = 0; i < 3000; i++) {
      const body = rnd() < 0.5 ? "[" + gen(1) + "]" : '{"r":' + gen(1) + "}";
      const src = pick(["", " ", "\n"]) + body + pick(["", " ", "\n"]);
      const out = compact(src);
      expect(JSON.parse(out)).toEqual(JSON.parse(src));
      expect(out).toBe(src.replace(outsideStrings, (m) => (m[0] === '"' ? m : "")));
    }
  });
});
