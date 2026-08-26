import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";

/**
 * A tool-calling turn must still be able to speak to the user.
 *
 * Agents route user-facing prose through `content` on the same turn that
 * carries `tool_calls` ("I haven't sent it yet, let me check first" + an
 * `exec` call). Blanking that content mutes the agent: the operator sees a
 * bare `[Called function ...]` line, asks a plain question, and gets another
 * bare tool call back with no answer.
 */
const TOOL = {
  type: "function",
  function: {
    name: "exec",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
};

function sseContent(text: string): string[] {
  return text
    .split("\n\n")
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join(""),
    )
    .filter((payload) => payload && payload !== "[DONE]")
    .map((payload) => {
      try {
        return JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
      } catch {
        return null;
      }
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .flatMap((chunk) => (chunk.choices ?? []).map((choice) => choice.delta?.content))
    .filter((c): c is string => typeof c === "string");
}

describe("prose on tool-calling turns", () => {
  let upstream: Server;
  let proxy: ProxyHandle;
  let upstreamResponse: Record<string, unknown> = {};

  beforeAll(async () => {
    upstream = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      await new Promise<void>((resolve) => req.on("end", resolve));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(upstreamResponse));
    });

    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address() as AddressInfo;

    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: `http://127.0.0.1:${addr.port}`,
      port: 0,
      skipBalanceCheck: true,
    });
  }, 10_000);

  afterAll(async () => {
    await proxy?.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  beforeEach(() => {
    delete process.env.CLAWROUTER_TOOL_CALL_PROSE;
  });

  afterEach(() => {
    delete process.env.CLAWROUTER_TOOL_CALL_PROSE;
  });

  // The prompt must differ per test: identical bodies hit the response cache
  // and replay an earlier test's already-transformed content.
  function ask(prompt: string, body: Record<string, unknown> = {}) {
    return fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: `did you send it? (${prompt})` }],
        tools: [TOOL],
        ...body,
      }),
    });
  }

  function nativeToolCallResponse(content: string) {
    return {
      id: "chatcmpl-prose",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "openai/gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            tool_calls: [
              {
                id: "exec:0",
                type: "function",
                function: { name: "exec", arguments: '{"command":"ls"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };
  }

  it("keeps user-facing prose that accompanies native tool_calls", async () => {
    upstreamResponse = nativeToolCallResponse("还没发出去，我先确认一下有多少条。");

    const res = await ask("native");
    const json = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string; tool_calls?: unknown[] };
      }>;
    };

    expect(json.choices?.[0]?.message?.content).toBe("还没发出去，我先确认一下有多少条。");
    expect(json.choices?.[0]?.message?.tool_calls).toHaveLength(1);
  });

  it("streams that prose as a delta instead of muting the turn", async () => {
    upstreamResponse = nativeToolCallResponse("还没发出去，我先确认一下有多少条。");

    const res = await ask("stream", { stream: true });
    const deltas = sseContent(await res.text());

    expect(deltas.join("")).toContain("还没发出去");
  });

  it("keeps prose that surrounds a textual tool call, without leaking the syntax", async () => {
    upstreamResponse = {
      id: "chatcmpl-prose-textual",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "openai/gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "还没发出去，我先确认一下。\n" +
              "<tool_call>exec<arg_key>command</arg_key><arg_value>ls</arg_value></tool_call>",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };

    const res = await ask("textual");
    const json = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string; tool_calls?: Array<{ function?: { name?: string } }> };
      }>;
    };

    const content = json.choices?.[0]?.message?.content ?? "";
    expect(content).toContain("还没发出去");
    expect(content).not.toContain("<tool_call>");
    expect(content).not.toContain("<arg_key>");
    expect(json.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe("exec");
  });

  it("still strips thinking tokens from a tool-calling turn", async () => {
    upstreamResponse = nativeToolCallResponse(
      "<think>The user wants a listing. I should call exec.</think>还没发出去。",
    );

    const res = await ask("thinking");
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = json.choices?.[0]?.message?.content ?? "";
    expect(content).not.toContain("<think>");
    expect(content).not.toContain("I should call exec");
    expect(content).toContain("还没发出去。");
  });

  it("restores the old muting behaviour when CLAWROUTER_TOOL_CALL_PROSE=off", async () => {
    process.env.CLAWROUTER_TOOL_CALL_PROSE = "off";
    upstreamResponse = nativeToolCallResponse("还没发出去，我先确认一下有多少条。");

    const res = await ask("muted");
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    expect(json.choices?.[0]?.message?.content).toBe("");
  });
});
