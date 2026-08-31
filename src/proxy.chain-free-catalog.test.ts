/**
 * Guard: a free model the ACTIVE chain's gateway does not carry must not be sent.
 *
 * The two BlockRun gateways stopped sharing a free tier on 2026-08-30. Base
 * rebuilt to seven models; sol.blockrun.ai carried one of them and answered
 * HTTP 400 "Unknown model" for the other six. Solana has been the default chain
 * for new installs since v0.12.246, so `/model free` on a fresh install pointed
 * at a model its own gateway had never heard of.
 *
 * The gateways' never-retire redirect rule does NOT absorb this: it only covers
 * ids a gateway once shipped, so a model that never existed on a chain hard-400s
 * there rather than falling back.
 *
 * The subtlety this test exists for: filtering `pickFreeModel()` alone does not
 * fix it. `/model free` resolves through MODEL_ALIASES to a concrete id and takes
 * the EXPLICIT-model branch, which never calls pickFreeModel — the first version
 * of this fix filtered the cascade correctly and still 400'd on sol, because the
 * common path never read the filter. The substitution therefore happens after
 * every path has converged on a candidate list.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";

import { startProxy } from "./proxy.js";

type ProxyHandle = Awaited<ReturnType<typeof startProxy>>;

let proxy: ProxyHandle | undefined;
let upstream: Server | undefined;

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = undefined;
});

/** A gateway that lists only `catalogIds` and records what it was asked to serve. */
async function gatewayServing(catalogIds: string[], seen: string[]) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: catalogIds.map((id) => ({ id })) }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { model?: string };
    const model = String(body.model ?? "");
    seen.push(model);

    if (!catalogIds.includes(model)) {
      // Exactly what sol.blockrun.ai does for an id it never shipped.
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown model: ${model}` }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model,
        choices: [
          { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function askForFree(url: string) {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "free", messages: [{ role: "user", content: "hi" }] }),
  });
}

/** Let the startup catalog read land before the first request. */
const settle = () => new Promise((r) => setTimeout(r, 300));

describe("free models on a gateway that does not carry them", () => {
  it("substitutes a free model the chain does serve instead of 400ing", async () => {
    // Mirrors sol on 2026-08-31: only nano-omni of the seven.
    const seen: string[] = [];
    const g = await gatewayServing(["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"], seen);
    upstream = g.server;
    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: g.url,
      port: 0,
      skipBalanceCheck: true,
      cacheConfig: { enabled: false },
    });
    await settle();

    const res = await askForFree(`http://127.0.0.1:${proxy.port}`);
    expect(res.status).toBe(200);
    // The upstream must never have been asked for a model it does not carry.
    expect(seen).toEqual(["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"]);
  });

  it("leaves the configured default alone when the gateway carries it", async () => {
    // Base: the head is served, so nothing should be substituted.
    const seen: string[] = [];
    const g = await gatewayServing(
      ["nvidia/nemotron-3.5-lightning", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"],
      seen,
    );
    upstream = g.server;
    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: g.url,
      port: 0,
      skipBalanceCheck: true,
      cacheConfig: { enabled: false },
    });
    await settle();

    const res = await askForFree(`http://127.0.0.1:${proxy.port}`);
    expect(res.status).toBe(200);
    expect(seen).toEqual(["nvidia/nemotron-3.5-lightning"]);
  });

  it("stays permissive when the catalog cannot be read", async () => {
    // An unreadable catalog must not be able to switch the free tier off, so the
    // configured head is used unchanged — the pre-v0.12.259 behaviour.
    const seen: string[] = [];
    const g = await gatewayServing([], seen); // empty catalog => treated as a bad read
    upstream = g.server;
    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: g.url,
      port: 0,
      skipBalanceCheck: true,
      cacheConfig: { enabled: false },
    });
    await settle();

    await askForFree(`http://127.0.0.1:${proxy.port}`);
    expect(seen[0]).toBe("nvidia/nemotron-3.5-lightning");
  });
});
