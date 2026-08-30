import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";

/**
 * Regression test for the chat path (`/v1/chat/completions`) leaving its paid
 * upstream running after the client disconnects — the same shape as #251, which
 * was fixed for the media handlers. `proxyRequest` wired its disconnect abort to
 * `req.on("close")`, but on Node (verified on v24.15.0) an IncomingMessage emits
 * `"close"` when the request-body readable finishes, not when the client hangs
 * up. The body is fully drained near the top of `proxyRequest`, so `"close"` has
 * already fired by the time the listener is attached far below — the handler
 * never ran and the upstream fetch was orphaned. The abort now hangs off
 * `res.on("close")` (guarded by `!res.writableEnded`), mirroring every media
 * handler. This pins the upstream observing the abort after the client destroys
 * its request.
 */
describe("chat completions upstream call on client abort", () => {
  let upstream: Server;
  let proxy: ProxyHandle;
  let upstreamHits = 0;
  let upstreamAborted = 0;

  beforeAll(async () => {
    upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/v1/chat/completions") {
          upstreamHits++;
          // Hold the response open. If the proxy aborts, the socket closes
          // before we ever write — that's what we observe.
          res.on("close", () => {
            if (!res.writableEnded) upstreamAborted++;
          });
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unexpected path" }));
      });
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
    upstream.closeAllConnections?.();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("aborts the upstream request when the client disconnects", async () => {
    upstreamHits = 0;
    upstreamAborted = 0;

    const url = new URL(`${proxy.baseUrl}/v1/chat/completions`);
    // Explicit model → single upstream attempt, no fallback chain.
    const body = JSON.stringify({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });

    await new Promise<void>((resolve) => {
      const clientReq = request({
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(body.length) },
      });
      clientReq.on("error", () => resolve());
      clientReq.on("close", () => resolve());
      clientReq.end(body);
      // Give the proxy time to forward upstream, then walk away.
      setTimeout(() => clientReq.destroy(), 500);
    });

    // Poll briefly for the upstream socket to observe the abort.
    const deadline = Date.now() + 3_000;
    while (upstreamAborted === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(upstreamHits).toBe(1);
    expect(upstreamAborted).toBe(1);
  }, 10_000);
});
