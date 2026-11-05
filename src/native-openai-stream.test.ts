import { describe, expect, it } from "vitest";
import { extractTextualToolCalls } from "./textual-tool-calls.js";
import {
  pumpNativeOpenAIStream,
  readSseEvents,
  TextualToolCallStream,
  ThinkingTokenStripper,
} from "./native-openai-stream.js";

function readable(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

function frame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

describe("native OpenAI SSE stream helpers", () => {
  it.each([
    "<tool_call>lookup<arg_key>query</arg_key><arg_value>x</arg_value></tool_call>",
    '<function_calls><invoke name="lookup"><parameter name="query">x</parameter></invoke></function_calls>',
    '[Called function "lookup" with args: {"query":"x"}]',
    'lookup(parameters={"query":"x"})',
    '{\n "type":"function", "name":"lookup", "parameters":{"query":"x"}}',
    '{"query":"x"}',
  ])("recovers supported tool syntax across arbitrary token boundaries: %s", (content) => {
    const tools = [
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: { type: "object", properties: { query: {} }, required: ["query"] },
        },
      },
    ];
    const expected = extractTextualToolCalls(content, { tools });
    expect(expected.toolCalls).toHaveLength(1);
    for (let split = 1; split < content.length; split++) {
      const recovery = new TextualToolCallStream(tools);
      const pieces = [
        recovery.push(content.slice(0, split)),
        recovery.push(content.slice(split)),
        recovery.push("", true),
      ];
      expect(pieces.flatMap((piece) => piece.toolCalls).map((call) => call.function)).toEqual(
        expected.toolCalls.map((call) => call.function),
      );
      expect(
        pieces
          .map((piece) => piece.content)
          .join("")
          .trim(),
      ).toBe(expected.cleanedContent.trim());
    }
  });

  it("forwards a one-character delta immediately", async () => {
    const output: string[] = [];
    await pumpNativeOpenAIStream(
      readable([
        frame({ choices: [{ index: 0, delta: { content: "a" }, finish_reason: null }] }),
        frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ]),
      { model: "fixture", tools: undefined, onChunk: (chunk) => output.push(chunk) },
    );
    expect(output[0]).toContain('"content":"a"');
  });

  it("preserves the tool-call prose suppression setting even when a tool arrives later", async () => {
    const output: string[] = [];
    const result = await pumpNativeOpenAIStream(
      readable([
        frame({
          choices: [{ index: 0, delta: { content: "do not disclose" }, finish_reason: null }],
        }),
        frame({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "lookup", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        "data: [DONE]\n\n",
      ]),
      {
        model: "fixture",
        tools: undefined,
        forwardToolCallProse: false,
        onChunk: (chunk) => output.push(chunk),
      },
    );
    expect(result.content).toBe("");
    expect(output.join("")).not.toContain("do not disclose");
    expect(output.join("")).toContain('"name":"lookup"');
  });

  it("cancels an open source on an in-band error", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame({ error: "fixture failed" })));
      },
      cancel() {
        cancelled++;
      },
    });
    const result = await pumpNativeOpenAIStream(body, {
      model: "fixture",
      tools: undefined,
      onChunk() {},
    });
    expect(result.error).toBe("fixture failed");
    expect(cancelled).toBe(1);
  });

  it("handles an already-aborted signal without leaving a body reader running", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++;
      },
    });
    const abort = new AbortController();
    abort.abort(new Error("fixture abort"));
    await expect(
      pumpNativeOpenAIStream(body, {
        signal: abort.signal,
        model: "fixture",
        tools: undefined,
        onChunk() {},
      }),
    ).rejects.toThrow("fixture abort");
    expect(cancelled).toBe(1);
  });

  it("requires every choice to finish before accepting the done marker", async () => {
    const result = await pumpNativeOpenAIStream(
      readable([
        frame({
          choices: [
            { index: 0, delta: {}, finish_reason: "stop" },
            { index: 1, delta: { content: "unfinished" }, finish_reason: null },
          ],
        }),
        "data: [DONE]\n\n",
      ]),
      { model: "fixture", tools: undefined, onChunk() {} },
    );
    expect(result.sawDone).toBe(true);
    expect(result.sawFinish).toBe(false);
  });

  it("parses event fields across byte boundaries and ignores SSE comments", async () => {
    const text = `: keepalive\n\nevent: message\ndata: {"ok":\ndata: true}\n\n`;
    const events = [];
    for await (const event of readSseEvents(readable([text.slice(0, 9), text.slice(9)]))) {
      events.push(event);
    }
    expect(events).toEqual([{ event: "message", data: '{"ok":\ntrue}' }]);
  });

  it("strips standard and Kimi thinking tags when they cross chunk boundaries", () => {
    const stripper = new ThinkingTokenStripper();
    expect(stripper.push("shown<thi")).toBe("shown");
    expect(stripper.push("nk>private</think>also <｜begin▁of▁thinking｜>secret")).toBe("also ");
    expect(stripper.push("<｜end▁of▁thinking｜>answer", true)).toBe("answer");
    expect(
      new ThinkingTokenStripper().push(
        "<think>secret<think>nested</think>still hidden</think>shown",
        true,
      ),
    ).toBe("shown");
  });

  it("recovers a text-encoded tool call without forwarding its markup", () => {
    const recovery = new TextualToolCallStream(undefined);
    expect(recovery.push("Before <tool_ca")).toEqual({ content: "Before ", toolCalls: [] });
    recovery.push(
      "ll>lookup<arg_key>query</arg_key><arg_value>weather</arg_value></tool_call> after",
    );
    const completed = recovery.push("", true);
    expect(completed.content).toBe(" after");
    expect(completed.toolCalls).toHaveLength(1);
    expect(completed.toolCalls[0]).toMatchObject({
      type: "function",
      function: { name: "lookup", arguments: '{"query":"weather"}' },
    });
  });

  it("streams content, hides reasoning, preserves structured tool deltas and usage", async () => {
    const events = [
      frame({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
      frame({ choices: [{ index: 0, delta: { content: "hello " }, finish_reason: null }] }),
      frame({
        choices: [{ index: 0, delta: { reasoning_content: "private" }, finish_reason: null }],
      }),
      frame({
        choices: [
          {
            index: 0,
            delta: {
              content: "<think>hidden</think>world",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup", arguments: "{" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      frame({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } }),
      "data: [DONE]\n\n",
    ];
    const output: string[] = [];
    const result = await pumpNativeOpenAIStream(readable(events), {
      model: "test-model",
      tools: undefined,
      onChunk: (chunk) => output.push(chunk),
    });

    expect(result).toMatchObject({
      content: "hello world",
      inputTokens: 7,
      outputTokens: 4,
      sawDone: true,
      sawFinish: true,
    });
    const wire = output.join("");
    expect(wire).toContain('"name":"lookup"');
    expect(wire).toContain('"finish_reason":"tool_calls"');
    expect(wire).toContain('"arguments":"{"');
    expect(wire).not.toContain("private");
    expect(wire).not.toContain("hidden");
    expect(wire).toContain('"content":"hello "');
    expect(wire).toContain('"content":"world"');
  });

  it("reports an in-band provider error as terminal", async () => {
    const output: string[] = [];
    const result = await pumpNativeOpenAIStream(
      readable([
        frame({ choices: [{ index: 0, delta: { content: "partial" } }] }),
        frame({ error: "gone" }),
      ]),
      { model: "test-model", tools: undefined, onChunk: (chunk) => output.push(chunk) },
    );
    expect(result.error).toBe("gone");
    expect(result.sawDone).toBe(false);
    expect(output.length).toBeGreaterThan(0);
  });
});
