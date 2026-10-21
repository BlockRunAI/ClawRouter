import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";
import { InMemorySpendControlStorage, SpendControl } from "./spend-control.js";

vi.mock("./logger.js", async (original) => ({
  ...(await original<typeof import("./logger.js")>()),
  logUsage: vi.fn(async () => {}),
}));

/**
 * BlockRun retired the Surf data API on 2026-09-06; every /api/v1/surf/* path
 * now answers 410 endpoint_retired. ClawRouter no longer whitelists /v1/surf/*
 * as a paid partner prefix, so:
 *
 * - wallet mode refuses it locally (unsupported_endpoint 404) — nothing reaches
 *   the gateway and nothing is signed;
 * - API-key mode forwards it through the account passthrough like any other
 *   non-chat path, so the caller sees the gateway's own 410 and its hint.
 */
const RETIRED = {
  error: { message: "retired", type: "invalid_request_error", code: "endpoint_retired" },
  retired_on: "2026-09-06",
};

describe("/v1/surf/* after the Surf retirement", () => {
  let upstream: Server;
  let base: string;
  let calls: Array<{ path: string; payment?: string }> = [];

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      calls.push({
        path: req.url!,
        payment: req.headers["payment-signature"] as string | undefined,
      });
      req.resume();
      if (req.url?.startsWith("/v1/surf/")) {
        res.writeHead(410, { "content-type": "application/json" });
        res.end(JSON.stringify(RETIRED));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end('{"data":[]}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  beforeEach(() => {
    calls = [];
  });

  describe("wallet mode", () => {
    let proxy: ProxyHandle;
    beforeAll(async () => {
      proxy = await startProxy({
        wallet: generatePrivateKey(),
        apiBase: base,
        port: 0,
        skipBalanceCheck: true,
      });
    }, 10_000);
    afterAll(async () => {
      await proxy?.close();
    });

    it.each([
      ["GET", "/v1/surf/market/price?symbol=BTC"],
      ["POST", "/v1/surf/onchain/sql"],
    ])("refuses %s %s locally without reaching the gateway", async (method, path) => {
      const res = await fetch(proxy.baseUrl + path, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "POST" ? { body: '{"sql":"SELECT 1"}' } : {}),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("unsupported_endpoint");
      // The served-prefix list in the hint must no longer advertise surf.
      expect(body.error.message).toContain(",phone,voice}/.");
      expect(calls.filter((c) => c.path.startsWith("/v1/surf/"))).toHaveLength(0);
    });
  });

  describe("API-key mode", () => {
    let proxy: ProxyHandle;
    beforeAll(async () => {
      proxy = await startProxy({
        spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
        apiKey: "brk_live_surf_retired_123456789",
        apiBase: base,
        port: 0,
        allowExistingProxy: false,
      });
    }, 10_000);
    afterAll(async () => {
      await proxy?.close();
    });

    it("relays the gateway's 410 endpoint_retired unchanged", async () => {
      const res = await fetch(proxy.baseUrl + "/v1/surf/market/price?symbol=BTC");
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual(RETIRED);
      const call = calls.find((c) => c.path.startsWith("/v1/surf/"));
      expect(call?.payment).toBeUndefined();
    });
  });
});
