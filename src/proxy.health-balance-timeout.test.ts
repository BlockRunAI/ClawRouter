import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import type { BalanceMonitor, SufficiencyResult } from "./balance.js";
import { startProxy, type ProxyHandle } from "./proxy.js";

/**
 * Regression test: `/health?full=true` awaited the balance RPC with no time
 * bound, so an unresponsive RPC hung the health endpoint indefinitely — the
 * one endpoint monitoring hits, and the one that must always answer. The
 * handler's `catch` only covers a rejection, never a hang.
 *
 * The check is now bounded like the pre-request one, degrading to
 * `balanceError` rather than holding the response open.
 */
describe("/health?full=true under a slow balance RPC", () => {
  let upstream: Server;
  let proxy: ProxyHandle;
  const RPC_DELAY_MS = 10_000;

  const hangingMonitor = {
    checkBalance: async () => {
      await new Promise((r) => setTimeout(r, RPC_DELAY_MS));
      return {
        balance: 10_000_000n,
        balanceUSD: "$10.00",
        isLow: false,
        isEmpty: false,
        walletAddress: "0xslow",
      };
    },
    checkSufficient: async (): Promise<SufficiencyResult> => ({
      sufficient: true,
      info: {
        balance: 10_000_000n,
        balanceUSD: "$10.00",
        isLow: false,
        isEmpty: false,
        walletAddress: "0xslow",
      },
    }),
    deductEstimated: () => {},
    invalidate: () => {},
  } as unknown as BalanceMonitor;

  beforeAll(async () => {
    upstream = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address() as AddressInfo;

    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: `http://127.0.0.1:${addr.port}`,
      port: 0,
      skipBalanceCheck: true,
      _balanceMonitorOverride: hangingMonitor,
    });
  }, 15_000);

  afterAll(async () => {
    await proxy?.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("answers well before the RPC settles, reporting balanceError", async () => {
    const started = Date.now();
    const res = await fetch(`${proxy.baseUrl}/health?full=true`);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.balanceError).toBeDefined();
    expect(body.balance).toBeUndefined();

    // Must not wait out the 10s RPC; the bound is 2.5s plus scheduling slack.
    expect(elapsed).toBeLessThan(RPC_DELAY_MS / 2);
  }, 15_000);
});
