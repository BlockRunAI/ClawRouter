import { describe, expect, it, vi } from "vitest";

import { BalanceMonitor, fetchArcUsdcBalance } from "./balance.js";
import { RpcError } from "./errors.js";

const ADDRESS = "0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Arc USDC balance (read through arc.blockrun.ai, no RPC key)", () => {
  it("reads micro-USDC from the Arc gateway's /v1/balance", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ address: ADDRESS, balance: "24253720", balanceUSD: "$24.25", network: "arc" }),
    );
    await expect(fetchArcUsdcBalance(ADDRESS, fetchImpl as typeof fetch)).resolves.toBe(
      24_253_720n,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(`https://arc.blockrun.ai/api/v1/balance?address=${ADDRESS}`);
  });

  it("throws on an HTTP error instead of reading as an empty wallet", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "down" }, 503));
    await expect(fetchArcUsdcBalance(ADDRESS, fetchImpl as typeof fetch)).rejects.toThrow(/503/);
  });

  it("throws when the body carries no integer balance", async () => {
    for (const body of [{}, { balance: 24.25 }, { balance: "$24.25" }, { balance: "" }]) {
      const fetchImpl = vi.fn(async () => jsonResponse(body));
      await expect(fetchArcUsdcBalance(ADDRESS, fetchImpl as typeof fetch)).rejects.toThrow(
        /no balance/,
      );
    }
  });
});

describe("BalanceMonitor on Arc", () => {
  it("reports Arc balance, low/empty flags and the shared EVM address", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ balance: "500000" }));
    const monitor = new BalanceMonitor(ADDRESS, "arc", fetchImpl as typeof fetch);
    expect(monitor.getChain()).toBe("arc");
    const info = await monitor.checkBalance();
    expect(info.balance).toBe(500_000n);
    expect(info.balanceUSD).toBe("$0.50");
    expect(info.isLow).toBe(true);
    expect(info.isEmpty).toBe(false);
    expect(info.walletAddress).toBe(ADDRESS);
  });

  it("flags an empty Arc wallet and re-reads it on the next check", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ balance: "0" }));
    const monitor = new BalanceMonitor(ADDRESS, "arc", fetchImpl as typeof fetch);
    expect((await monitor.checkBalance()).isEmpty).toBe(true);
    await monitor.checkBalance();
    expect(fetchImpl).toHaveBeenCalledTimes(2); // zero is never cached
  });

  it("caches a positive balance and honours checkSufficient", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ balance: "2000000" }));
    const monitor = new BalanceMonitor(ADDRESS, "arc", fetchImpl as typeof fetch);
    expect((await monitor.checkSufficient(1_000_000n)).sufficient).toBe(true);
    const short = await monitor.checkSufficient(3_000_000n);
    expect(short.sufficient).toBe(false);
    expect(short.shortfall).toBe("$1.00");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed Arc read as RpcError, like the Base RPC path", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const monitor = new BalanceMonitor(ADDRESS, "arc", fetchImpl as typeof fetch);
    await expect(monitor.checkBalance()).rejects.toBeInstanceOf(RpcError);
  });

  it("defaults to Base and never calls the Arc gateway there", () => {
    const fetchImpl = vi.fn();
    const monitor = new BalanceMonitor(ADDRESS, undefined, fetchImpl as unknown as typeof fetch);
    expect(monitor.getChain()).toBe("base");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("coalesces concurrent checkBalance calls into a single RPC read", async () => {
    let resolveFetch!: (res: Response) => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const monitor = new BalanceMonitor(ADDRESS, "arc", fetchImpl as typeof fetch);

    const p1 = monitor.checkBalance();
    const p2 = monitor.checkBalance();
    const p3 = monitor.checkSufficient(1_000_000n);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch(jsonResponse({ balance: "2500000" }));

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.balance).toBe(2_500_000n);
    expect(r2.balance).toBe(2_500_000n);
    expect(r3.sufficient).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("recovers after a failed concurrent read so the next check retries", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new TypeError("fetch failed");
      return jsonResponse({ balance: "1500000" });
    });
    const monitor = new BalanceMonitor(ADDRESS, "arc", fetchImpl as typeof fetch);

    const [a, b] = await Promise.allSettled([monitor.checkBalance(), monitor.checkBalance()]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const info = await monitor.checkBalance();
    expect(info.balance).toBe(1_500_000n);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not let a pre-invalidation in-flight read poison the cache", async () => {
    const resolvers: Array<(res: Response) => void> = [];
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const monitor = new BalanceMonitor(ADDRESS, "arc", fetchImpl as typeof fetch);

    const staleCall = monitor.checkBalance();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Payment failed mid-flight: invalidate and start a fresh check.
    monitor.invalidate();
    const freshCall = monitor.checkBalance();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Resolve the fresh read first with the new lower balance, then the stale one.
    resolvers[1]!(jsonResponse({ balance: "400000" }));
    expect((await freshCall).balance).toBe(400_000n);

    resolvers[0]!(jsonResponse({ balance: "9000000" }));
    await staleCall;

    // Cache must retain the post-invalidation balance, not the stale 9000000.
    const cached = await monitor.checkBalance();
    expect(cached.balance).toBe(400_000n);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
