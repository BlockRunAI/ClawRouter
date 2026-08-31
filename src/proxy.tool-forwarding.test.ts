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

      // Skip the proxy's bodyless GET of `${apiBase}/v1/models` (startup
      // catalog read, see loadGatewayCatalog) — parsing it throws and would
      // also clobber the request this test is actually asserting on.
      const rawBody = Buffer.concat(chunks).toString();
      if (!rawBody) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      receivedBody = JSON.parse(rawBody) as Record<string, unknown>;

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

  it("forwards assistant prose alongside upstream tool_calls", async () => {
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
                  arguments: '{"city":"Chicago"}',
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
    // The turn keeps its voice: a model that speaks while calling a tool must
    // still reach the user, or the agent goes silent for the whole tool run.
    expect(json.choices?.[0]?.message?.content).toBe(
      "The user wants the current time. I should call get_current_time with Chicago.",
    );
    expect(json.choices?.[0]?.message?.tool_calls).toHaveLength(1);
  });

  it("streams assistant prose in SSE chunks alongside upstream tool_calls", async () => {
    upstreamResponse = {
      id: "chatcmpl-tool-content-sse",
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
                  arguments: '{"city":"Chicago"}',
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
        stream: true,
        messages: [
          { role: "user", content: "What time is it in Chicago right now? Use the tool." },
        ],
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
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();

    const events = text
      .split("\n\n")
      .map((block) =>
        block
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join(""),
      )
      .filter((payload) => payload && payload !== "[DONE]");

    const chunks = events
      .map((payload) => {
        try {
          return JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                role?: string;
                content?: string;
                tool_calls?: Array<{ function?: { name?: string } }>;
              };
              finish_reason?: string | null;
            }>;
          };
        } catch {
          return null;
        }
      })
      .filter((chunk): chunk is NonNullable<typeof chunk> => chunk !== null);

    // The prose must reach the client as a content delta rather than being
    // dropped, so a tool-calling turn is not silent in the chat stream.
    const proseDelivered = chunks.some((chunk) =>
      chunk.choices?.some((choice) => {
        const content = choice.delta?.content;
        return typeof content === "string" && content.includes("get_current_time with Chicago");
      }),
    );
    expect(proseDelivered).toBe(true);

    // A tool_calls chunk must be emitted with the upstream function call
    const toolCallChunks = chunks.flatMap((chunk) =>
      (chunk.choices ?? []).flatMap((choice) => choice.delta?.tool_calls ?? []),
    );
    expect(toolCallChunks).toHaveLength(1);
    expect(toolCallChunks[0]?.function?.name).toBe("get_current_time");

    // The terminal chunk must signal tool_calls completion
    const finishReasons = chunks.flatMap((chunk) =>
      (chunk.choices ?? [])
        .map((choice) => choice.finish_reason)
        .filter((fr): fr is string => typeof fr === "string"),
    );
    expect(finishReasons).toContain("tool_calls");
  });

  it("isolates dedup cache between streaming and non-streaming requests with identical bodies", async () => {
    upstreamResponse = {
      id: "chatcmpl-dedup-isolation",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "openai/gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello from dedup test" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    };

    const baseRequest = {
      model: "openai/gpt-4o",
      messages: [
        { role: "user", content: "dedup-isolation probe — identical body, different stream flag" },
      ],
    };

    // Non-streaming first — populates dedup cache
    const nonStreamRes = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseRequest, stream: false }),
    });
    expect(nonStreamRes.status).toBe(200);
    expect(nonStreamRes.headers.get("content-type")).toContain("application/json");
    const nonStreamJson = (await nonStreamRes.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    expect(nonStreamJson.choices?.[0]?.message?.content).toBe("hello from dedup test");

    // Streaming second — must not receive the cached JSON body
    const streamRes = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseRequest, stream: true }),
    });
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type")).toContain("text/event-stream");
    const streamText = await streamRes.text();
    expect(streamText).toContain("data: ");
    expect(streamText).toContain("[DONE]");
  });

  it("forwards assistant prose when upstream marks finish_reason as tool_calls", async () => {
    upstreamResponse = {
      id: "chatcmpl-tool-finish-reason",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "moonshot/kimi-k2.6",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I should look up Barcelona's next match before replying.",
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
        messages: [{ role: "user", content: "When is Barcelona's next match?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              description: "Search the web",
              parameters: { type: "object" },
            },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      choices?: Array<{
        finish_reason?: string | null;
        message?: {
          content?: string;
          tool_calls?: unknown[];
        };
      }>;
    };
    expect(json.choices?.[0]?.finish_reason).toBe("tool_calls");
    expect(json.choices?.[0]?.message?.content).toBe(
      "I should look up Barcelona's next match before replying.",
    );
  });

  it("synthesizes tool_calls from OpenClaw <tool_call><arg_key> XML in content (non-streaming)", async () => {
    upstreamResponse = {
      id: "chatcmpl-textual-tool-call",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "openai/gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "<tool_call>web_search<arg_key>count</arg_key><arg_value>5</arg_value><arg_key>query</arg_key><arg_value>Alpha Degen YouTube contact email crypto</arg_value></tool_call>",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 },
    };

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "Find Alpha Degen contact" }],
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              description: "Search the web",
              parameters: { type: "object" },
            },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      choices?: Array<{
        finish_reason?: string | null;
        message?: {
          content?: string;
          tool_calls?: Array<{
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    expect(json.choices?.[0]?.finish_reason).toBe("tool_calls");
    expect(json.choices?.[0]?.message?.content).toBe("");
    const toolCalls = json.choices?.[0]?.message?.tool_calls ?? [];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.function?.name).toBe("web_search");
    const args = JSON.parse(toolCalls[0]!.function!.arguments!) as Record<string, unknown>;
    expect(args.count).toBe(5);
    expect(args.query).toBe("Alpha Degen YouTube contact email crypto");
  });

  it("synthesizes tool_calls from OpenClaw <tool_call><arg_key> XML in content (SSE)", async () => {
    upstreamResponse = {
      id: "chatcmpl-textual-tool-call-sse",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "openai/gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "<tool_call>web_search<arg_key>query</arg_key><arg_value>Crypto Cred contact</arg_value></tool_call>",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
    };

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "Find Crypto Cred contact" }],
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              description: "Search the web",
              parameters: { type: "object" },
            },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();

    const events = text
      .split("\n\n")
      .map((block) =>
        block
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join(""),
      )
      .filter((payload) => payload && payload !== "[DONE]");

    const chunks = events
      .map((payload) => {
        try {
          return JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
          };
        } catch {
          return null;
        }
      })
      .filter((chunk): chunk is NonNullable<typeof chunk> => chunk !== null);

    // The XML must NOT leak as delta.content
    const xmlLeak = chunks.some((chunk) =>
      chunk.choices?.some(
        (choice) =>
          typeof choice.delta?.content === "string" && choice.delta.content.includes("<tool_call>"),
      ),
    );
    expect(xmlLeak).toBe(false);

    // A tool_calls chunk must be emitted with the synthesized call
    const toolCallChunks = chunks.flatMap((chunk) =>
      (chunk.choices ?? []).flatMap((choice) => choice.delta?.tool_calls ?? []),
    );
    expect(toolCallChunks).toHaveLength(1);
    expect(toolCallChunks[0]?.function?.name).toBe("web_search");
    const args = JSON.parse(toolCallChunks[0]!.function!.arguments!) as Record<string, unknown>;
    expect(args.query).toBe("Crypto Cred contact");

    // Finish reason must be flipped to tool_calls
    const finishReasons = chunks.flatMap((chunk) =>
      (chunk.choices ?? [])
        .map((choice) => choice.finish_reason)
        .filter((fr): fr is string => typeof fr === "string"),
    );
    expect(finishReasons).toContain("tool_calls");
  });

  it("synthesizes tool_calls from Anthropic <function_calls><invoke> XML in content", async () => {
    upstreamResponse = {
      id: "chatcmpl-anthropic-style",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "moonshot/kimi-k2.6",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              '<function_calls>\n<invoke name="web_search">\n<parameter name="query">DeFi Slate hosts</parameter>\n</invoke>\n</function_calls>',
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
    };

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "moonshot/kimi-k2.6",
        stream: false,
        messages: [{ role: "user", content: "Find DeFi Slate hosts" }],
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              description: "Search the web",
              parameters: { type: "object" },
            },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      choices?: Array<{
        finish_reason?: string | null;
        message?: {
          content?: string;
          tool_calls?: Array<{
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    expect(json.choices?.[0]?.finish_reason).toBe("tool_calls");
    expect(json.choices?.[0]?.message?.content).toBe("");
    const toolCalls = json.choices?.[0]?.message?.tool_calls ?? [];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.function?.name).toBe("web_search");
  });

  it("does not synthesize tool_calls when content has no tool-call XML", async () => {
    upstreamResponse = {
      id: "chatcmpl-no-xml",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "openai/gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Plain assistant prose with no tool calls at all.",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      choices?: Array<{
        finish_reason?: string | null;
        message?: { content?: string; tool_calls?: unknown[] };
      }>;
    };
    expect(json.choices?.[0]?.finish_reason).toBe("stop");
    expect(json.choices?.[0]?.message?.content).toBe(
      "Plain assistant prose with no tool calls at all.",
    );
    expect(json.choices?.[0]?.message?.tool_calls ?? []).toHaveLength(0);
  });

  it("streams assistant prose in SSE chunks when upstream marks finish_reason as tool_calls", async () => {
    upstreamResponse = {
      id: "chatcmpl-tool-finish-reason-sse",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "moonshot/kimi-k2.6",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I should look up Barcelona's next match before replying.",
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
        stream: true,
        messages: [{ role: "user", content: "When is Barcelona's next fixture? Please check." }],
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              description: "Search the web",
              parameters: { type: "object" },
            },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();

    const events = text
      .split("\n\n")
      .map((block) =>
        block
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join(""),
      )
      .filter((payload) => payload && payload !== "[DONE]");

    const chunks = events
      .map((payload) => {
        try {
          return JSON.parse(payload) as {
            choices?: Array<{
              delta?: { content?: string };
              finish_reason?: string | null;
            }>;
          };
        } catch {
          return null;
        }
      })
      .filter((chunk): chunk is NonNullable<typeof chunk> => chunk !== null);

    // Prose reaches the client as delta.content even though the turn is
    // marked as a tool-call turn by finish_reason alone.
    const proseDelivered = chunks.some((chunk) =>
      chunk.choices?.some((choice) => {
        const content = choice.delta?.content;
        return typeof content === "string" && content.includes("Barcelona");
      }),
    );
    expect(proseDelivered).toBe(true);

    // Terminal chunk must propagate the tool_calls finish_reason
    const finishReasons = chunks.flatMap((chunk) =>
      (chunk.choices ?? [])
        .map((choice) => choice.finish_reason)
        .filter((fr): fr is string => typeof fr === "string"),
    );
    expect(finishReasons).toContain("tool_calls");
  });
});
