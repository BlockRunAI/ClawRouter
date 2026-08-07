import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";
import { DEFAULT_ROUTING_CONFIG } from "./router/config.js";
import type { RoutingDecision } from "./router/types.js";

const EXPLICIT_MODEL = "openai/user-explicit";
const AUTO_PRIMARY = "openai/auto-primary";
const AUTO_FALLBACK = "openai/auto-fallback";

function createRoutingConfig() {
  return {
    ...DEFAULT_ROUTING_CONFIG,
    tiers: {
      SIMPLE: { primary: AUTO_PRIMARY, fallback: [AUTO_FALLBACK] },
      MEDIUM: { primary: AUTO_PRIMARY, fallback: [AUTO_FALLBACK] },
      COMPLEX: { primary: AUTO_PRIMARY, fallback: [AUTO_FALLBACK] },
      REASONING: { primary: AUTO_PRIMARY, fallback: [AUTO_FALLBACK] },
    },
    agenticTiers: null,
    ecoTiers: null,
    premiumTiers: null,
    promotions: [],
    overrides: {
      ...DEFAULT_ROUTING_CONFIG.overrides,
      ambiguousDefaultTier: "SIMPLE" as const,
      agenticMode: false,
    },
  };
}

async function createUpstream(
  handler: (
    body: Record<string, unknown>,
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void> | void,
): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    await handler(body, req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

async function postChat(
  proxy: ProxyHandle,
  sessionId: string,
  model: string,
  content: string,
  extra?: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-ID": sessionId,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      max_tokens: 64,
      ...extra,
    }),
  });
}

const DUMMY_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "noop",
      description: "test tool to disable free-model fallback",
      parameters: { type: "object", properties: {} },
    },
  },
];

describe("proxy session pinning", () => {
  let upstream: Server | undefined;
  let proxy: ProxyHandle | undefined;

  afterEach(async () => {
    await proxy?.close();
    if (upstream) {
      await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    }
    proxy = undefined;
    upstream = undefined;
  });

  it("keeps the user-explicit pin after a routed follow-up falls back", async () => {
    const receivedModels: string[] = [];
    let explicitAttempts = 0;

    const upstreamSetup = await createUpstream((body, _req, res) => {
      const model = String(body.model ?? "");
      receivedModels.push(model);

      if (model === EXPLICIT_MODEL) {
        explicitAttempts++;
        if (explicitAttempts === 2) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "temporary provider failure" } }));
          return;
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${receivedModels.length}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1_000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `ok:${model}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }),
      );
    });
    upstream = upstreamSetup.server;

    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: upstreamSetup.url,
      port: 0,
      skipBalanceCheck: true,
      cacheConfig: { enabled: false },
      routingConfig: createRoutingConfig(),
    });

    const sessionId = "sticky-session";

    const explicitRes = await postChat(proxy, sessionId, EXPLICIT_MODEL, "pin this model");
    expect(explicitRes.status).toBe(200);

    const routedRes = await postChat(proxy, sessionId, "blockrun/auto", "simple follow-up");
    expect(routedRes.status).toBe(200);

    const followupRes = await postChat(proxy, sessionId, "blockrun/auto", "another follow-up");
    expect(followupRes.status).toBe(200);

    expect(receivedModels).toEqual([EXPLICIT_MODEL, EXPLICIT_MODEL, AUTO_PRIMARY, EXPLICIT_MODEL]);
  });

  it("emits onRouted once when reusing a user-explicit session pin", async () => {
    const routedDecisions: RoutingDecision[] = [];
    const receivedModels: string[] = [];

    const upstreamSetup = await createUpstream((body, _req, res) => {
      const model = String(body.model ?? "");
      receivedModels.push(model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${receivedModels.length}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1_000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `ok:${model}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }),
      );
    });
    upstream = upstreamSetup.server;

    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: upstreamSetup.url,
      port: 0,
      skipBalanceCheck: true,
      cacheConfig: { enabled: false },
      routingConfig: createRoutingConfig(),
      onRouted: (decision) => {
        routedDecisions.push(decision);
      },
    });

    const sessionId = "explicit-onrouted";

    const explicitRes = await postChat(proxy, sessionId, EXPLICIT_MODEL, "pin this model");
    expect(explicitRes.status).toBe(200);

    routedDecisions.length = 0;
    const routedRes = await postChat(proxy, sessionId, "blockrun/auto", "simple follow-up");
    expect(routedRes.status).toBe(200);

    expect(receivedModels).toEqual([EXPLICIT_MODEL, EXPLICIT_MODEL]);
    expect(routedDecisions).toHaveLength(1);
    expect(routedDecisions[0]?.model).toBe(EXPLICIT_MODEL);
  });

  it("emits a local shadow comparison without changing the serving request", async () => {
    const receivedModels: string[] = [];
    const shadows: Array<{
      executed: RoutingDecision;
      shadow: RoutingDecision;
      sameModel: boolean;
      hasTools: boolean;
      hasVision: boolean;
      requiresStructuredOutput: boolean;
    }> = [];
    const upstreamSetup = await createUpstream((body, _req, res) => {
      const model = String(body.model ?? "");
      receivedModels.push(model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-shadow",
          object: "chat.completion",
          created: 1,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    upstream = upstreamSetup.server;
    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: upstreamSetup.url,
      port: 0,
      skipBalanceCheck: true,
      cacheConfig: { enabled: false },
      routingConfig: {
        ...createRoutingConfig(),
        strategy: "portfolio",
        shadow: { strategy: "rules", sampleRate: 1 },
      },
      onShadowRouted: (comparison) => shadows.push(comparison),
    });

    const response = await postChat(proxy, "shadow", "blockrun/auto", "simple follow-up");
    expect(response.status).toBe(200);
    expect(receivedModels).toEqual([AUTO_PRIMARY]);
    expect(shadows).toHaveLength(1);
    expect(shadows[0]).toMatchObject({
      hasTools: false,
      hasVision: false,
      requiresStructuredOutput: false,
    });
    expect(JSON.stringify(shadows[0])).not.toContain("simple follow-up");
  });

  it("retries an explicit-pin model once on transient 5xx upstream errors", async () => {
    const receivedModels: string[] = [];
    let attempts = 0;

    const upstreamSetup = await createUpstream((body, _req, res) => {
      const model = String(body.model ?? "");
      receivedModels.push(model);
      attempts++;

      // First attempt: simulate NVIDIA worker flake (500). Second attempt: succeed.
      if (attempts === 1) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "upstream provider 500" } }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${attempts}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1_000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `ok:${model}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }),
      );
    });
    upstream = upstreamSetup.server;

    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: upstreamSetup.url,
      port: 0,
      skipBalanceCheck: true,
      cacheConfig: { enabled: false },
      routingConfig: createRoutingConfig(),
    });

    // Tools present → no free-model fallback appended → fallback chain is just
    // [EXPLICIT_MODEL], which is exactly the OpenClaw + user-pinned-model
    // scenario where the original #qwen3-coder 500 bug surfaced.
    const res = await postChat(proxy, "retry-5xx-session", EXPLICIT_MODEL, "hi", {
      tools: DUMMY_TOOLS,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]?.message.content).toBe(`ok:${EXPLICIT_MODEL}`);

    // Same model tried twice: initial 500 + inline retry that succeeded
    expect(receivedModels).toEqual([EXPLICIT_MODEL, EXPLICIT_MODEL]);
    expect(attempts).toBe(2);
  });

  it("retries an explicit-pin model once on transient 5xx errors for normal chats", async () => {
    const receivedModels: string[] = [];
    let attempts = 0;

    const upstreamSetup = await createUpstream((body, _req, res) => {
      const model = String(body.model ?? "");
      receivedModels.push(model);
      attempts++;

      if (attempts === 1) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "upstream provider 500" } }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${attempts}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1_000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `ok:${model}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }),
      );
    });
    upstream = upstreamSetup.server;

    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: upstreamSetup.url,
      port: 0,
      skipBalanceCheck: true,
      cacheConfig: { enabled: false },
      routingConfig: createRoutingConfig(),
    });

    const res = await postChat(proxy, "retry-5xx-normal-chat", EXPLICIT_MODEL, "hi");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]?.message.content).toBe(`ok:${EXPLICIT_MODEL}`);

    // Normal explicit chats should retry the chosen model, not silently drop to free/*
    expect(receivedModels).toEqual([EXPLICIT_MODEL, EXPLICIT_MODEL]);
    expect(attempts).toBe(2);
  });

  it("does not retry an explicit-pin model on 4xx auth errors", async () => {
    const receivedModels: string[] = [];

    const upstreamSetup = await createUpstream((body, _req, res) => {
      const model = String(body.model ?? "");
      receivedModels.push(model);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key" } }));
    });
    upstream = upstreamSetup.server;

    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: upstreamSetup.url,
      port: 0,
      skipBalanceCheck: true,
      cacheConfig: { enabled: false },
      routingConfig: createRoutingConfig(),
    });

    // Tools present → no free-model fallback appended → we can cleanly assert
    // that auth_failure does NOT trigger the new 5xx retry path.
    const res = await postChat(proxy, "no-retry-4xx-session", EXPLICIT_MODEL, "hi", {
      tools: DUMMY_TOOLS,
    });
    expect(res.status).not.toBe(200);

    // Only a single attempt — 4xx auth failures are not retried
    expect(receivedModels).toEqual([EXPLICIT_MODEL]);
  });
});
