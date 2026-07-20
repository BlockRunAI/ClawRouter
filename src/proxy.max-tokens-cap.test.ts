import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";

/**
 * The output-token budget is not just telemetry — in strict mode it gates the
 * `maxCostPerRun` cap. A client on OpenAI's current `max_completion_tokens`
 * field was read as the 4096 default, so a request asking for 16x that much
 * output was priced at 1/16th of its real cost and walked straight through a
 * cap the user had set.
 *
 * Cap is $0.20 against openai/gpt-4o ($2.50 in / $10.00 out per 1M):
 *   4096  output tokens → ~$0.05 estimate → under the cap (allowed)
 *   65536 output tokens → ~$0.79 estimate → over the cap (must be blocked)
 */

const CAP_USD = 0.2;
const MODEL = "openai/gpt-4o";

let upstream: Server;
let upstreamPort: number;
let proxy: ProxyHandle;
const upstreamCalls: string[] = [];

beforeAll(async () => {
  upstream = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const parsed = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { model?: string };
    upstreamCalls.push(parsed.model ?? "unknown");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        model: parsed.model,
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;

  proxy = await startProxy({
    wallet: generatePrivateKey(),
    apiBase: `http://127.0.0.1:${upstreamPort}`,
    port: 0,
    skipBalanceCheck: true,
    maxCostPerRunUsd: CAP_USD,
    maxCostPerRunMode: "strict",
  });
});

afterAll(async () => {
  await proxy?.close();
  await new Promise<void>((r) => upstream?.close(() => r()));
});

async function send(body: Record<string, unknown>, session: string) {
  return fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": session },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: `budget probe ${session}` }],
      ...body,
    }),
  });
}

describe("maxCostPerRun strict mode reads the modern output-budget field", () => {
  it("blocks a max_tokens request that would exceed the cap", async () => {
    // Baseline: the legacy field was always read, so this already worked.
    const res = await send({ max_tokens: 65536 }, `legacy-${Date.now()}`);
    expect(res.status).toBe(429);
    const json = (await res.json()) as { error?: { type?: string } };
    expect(json.error?.type).toBe("cost_cap_exceeded");
  });

  it("blocks a max_completion_tokens request that would exceed the cap", async () => {
    // The bug: priced at the 4096 default, this sailed through the cap.
    upstreamCalls.length = 0;
    const session = `modern-${Date.now()}`;
    const res = await send({ max_completion_tokens: 65536 }, session);

    expect(res.status).toBe(429);
    const json = (await res.json()) as { error?: { type?: string } };
    expect(json.error?.type).toBe("cost_cap_exceeded");
    // Blocked BEFORE spending money, not after.
    expect(upstreamCalls).toEqual([]);
  });

  it("still allows a modest max_completion_tokens request under the cap", async () => {
    // The fix must not turn the cap into a blanket denial.
    upstreamCalls.length = 0;
    const res = await send({ max_completion_tokens: 256 }, `small-${Date.now()}`);
    expect(res.status).toBe(200);
    expect(upstreamCalls).toEqual([MODEL]);
  });
});
