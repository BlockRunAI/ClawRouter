import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startProxy, type ProxyHandle } from "./proxy.js";

// Synthetic credentials. The API keys deliberately have the same masked label.
const KEY_A = "brk_live_" + "a".repeat(32) + "same";
const KEY_B = "brk_live_" + "a".repeat(12) + "b".repeat(20) + "same";
const WALLET_A = "0x" + "1".repeat(64);
const WALLET_B = "0x" + "2".repeat(64);

describe("customer credential changes on an occupied port", () => {
  let upstream: Server;
  let apiBase: string;
  beforeAll(async () => {
    upstream = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [] }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    apiBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  for (const race of [false, true]) {
    for (const scenario of [
      "same-key",
      "different-key",
      "different-gateway",
      "api-to-wallet",
      "wallet-to-api",
      "different-wallet",
      "different-chain",
    ] as const) {
      it(`${scenario} preserves billing identity (${race ? "listen race" : "initial health check"})`, async () => {
        const walletFirst = ["wallet-to-api", "different-wallet", "different-chain"].includes(
          scenario,
        );
        const firstOptions = walletFirst ? { wallet: WALLET_A } : { apiKey: KEY_A };
        const first = await startProxy({
          ...firstOptions,
          apiBase,
          paymentChain: "base",
          port: 0,
          skipBalanceCheck: true,
        });
        let attached: ProxyHandle | undefined;
        const originalFetch = globalThis.fetch;
        if (race) {
          let skipped = false;
          vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
            if (!skipped && String(input) === `${first.baseUrl}/health`) {
              skipped = true;
              return Promise.resolve(new Response("", { status: 404 }));
            }
            return originalFetch(input, init);
          });
        }
        try {
          const credential =
            scenario === "api-to-wallet"
              ? { wallet: WALLET_A }
              : scenario === "different-wallet"
                ? { wallet: WALLET_B }
                : scenario === "different-chain"
                  ? { wallet: WALLET_A }
                  : { apiKey: scenario === "different-key" ? KEY_B : KEY_A };
          const next = startProxy({
            ...credential,
            apiBase: scenario === "different-gateway" ? `${apiBase}/other` : apiBase,
            paymentChain: scenario === "different-chain" ? "solana" : "base",
            port: first.port,
            skipBalanceCheck: true,
          }).then((handle) => {
            attached = handle;
            return handle;
          });
          if (scenario === "same-key") {
            expect((await next).authMode).toBe("api-key");
          } else {
            await expect(next).rejects.toThrow(/existing proxy|different|requested|stop/i);
          }
          const health = await originalFetch(`${first.baseUrl}/health`).then((res) => res.json());
          expect(health.authMode).toBe(walletFirst ? "wallet" : "api-key");
          expect(JSON.stringify(health)).not.toContain(KEY_A);
        } finally {
          vi.restoreAllMocks();
          await attached?.close();
          await first.close();
        }
      }, 20_000);
    }
  }
});
