import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";

describe("modal sandbox proxying", () => {
  let upstream: Server;
  let proxy: ProxyHandle;
  let receivedPath = "";
  let receivedBody: Record<string, unknown> | null = null;

  beforeAll(async () => {
    upstream = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      receivedPath = req.url ?? "";

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
      res.end(
        JSON.stringify({
          sandbox_id: "sb-test",
          status: "running",
        }),
      );
    });

    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address() as AddressInfo;
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;

    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: upstreamUrl,
      port: 0,
      skipBalanceCheck: true,
    });
  }, 10_000);

  afterAll(async () => {
    await proxy?.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("forwards /v1/modal/sandbox/create through the paid proxy path", async () => {
    receivedPath = "";
    receivedBody = null;

    const res = await fetch(`${proxy.baseUrl}/v1/modal/sandbox/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: "python:3.11",
        timeout: 300,
        setup_commands: ["pip install pandas"],
      }),
    });

    expect(res.status).toBe(200);
    expect(receivedPath).toBe("/v1/modal/sandbox/create");
    expect(receivedBody).toEqual({
      image: "python:3.11",
      timeout: 300,
      setup_commands: ["pip install pandas"],
    });
    await expect(res.json()).resolves.toEqual({
      sandbox_id: "sb-test",
      status: "running",
    });
  });
});
