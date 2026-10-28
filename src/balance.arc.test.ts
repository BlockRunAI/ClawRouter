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
});
