import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";

describe("tool forwarding", () => {
  let upstream: Server;
  let proxy: ProxyHandle;
  let upstreamUrl = "";
  let receivedBody: Record<string, unknown> | null = null;
  let upstreamResponse: Record<string, unknown> = {
    id: "chatcmpl-tool-forwarding",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "openai/gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  };

  beforeAll(async () => {
    upstream = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      receivedBody = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(upstreamResponse));
    });

    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address() as AddressInfo;
    upstreamUrl = `http://127.0.0.1:${addr.port}`;

    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: upstreamUrl,
      port: 0,
      skipBalanceCheck: true,
    });
  }, 10_000);

  beforeEach(() => {
    upstreamResponse = {
      id: "chatcmpl-tool-forwarding",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "openai/gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    };
  });

  afterAll(async () => {
    await proxy?.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("forwards OpenClaw web_search tools to upstream unchanged", async () => {
    receivedBody = null;

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "Find today's top non-war news" }],
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              description: "Search the web",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string" },
                },
                required: ["query"],
              },
            },
          },
        ],
        max_tokens: 64,
      }),
    });

    expect(res.status).toBe(200);
    expect(receivedBody).not.toBeNull();
    if (!receivedBody) {
      throw new Error("Proxy did not forward the request body to upstream");
    }

    const forwardedRequest = receivedBody as unknown as {
      tools?: Array<{ function?: { name?: string } }>;
    };
    const parsedTools = forwardedRequest.tools ?? [];
    expect(parsedTools).toHaveLength(1);
    expect(parsedTools[0]?.function?.name).toBe("web_search");
  });

  it("suppresses assistant content when upstream returns tool_calls", async () => {
    upstreamResponse = {
      id: "chatcmpl-tool-content",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "moonshot/kimi-k2.6",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "The user wants the current time. I should call get_current_time with Chicago.",
            tool_calls: [
              {
                id: "get_current_time:0",
                type: "function",
                function: {
                  name: "get_current_time",
                  arguments: "{\"city\":\"Chicago\"}",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "moonshot/kimi-k2.6",
        stream: false,
        messages: [{ role: "user", content: "What time is it in Chicago? Use the tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_current_time",
              description: "Get current time",
              parameters: { type: "object" },
            },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: unknown[];
        };
      }>;
    };
    expect(json.choices?.[0]?.message?.content).toBe("");
    expect(json.choices?.[0]?.message?.tool_calls).toHaveLength(1);
  });
});
