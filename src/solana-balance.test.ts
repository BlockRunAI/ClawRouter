import { beforeEach, describe, expect, it, vi } from "vitest";

const getTokenAccountsByOwnerMock = vi.fn();

vi.mock("@solana/kit", () => ({
  address: (value: string) => value,
  createSolanaRpc: () => ({
    getTokenAccountsByOwner: getTokenAccountsByOwnerMock,
  }),
}));

import { SolanaBalanceMonitor } from "./solana-balance.js";

const WALLET = "11111111111111111111111111111111";

function tokenAccountResponse(amount: string) {
  return {
    value: [
      {
        account: {
          data: {
            parsed: {
              info: {
                tokenAmount: { amount },
              },
            },
          },
        },
      },
    ],
  };
}

describe("SolanaBalanceMonitor singleflight and invalidation", () => {
  beforeEach(() => {
    getTokenAccountsByOwnerMock.mockReset();
  });

  it("coalesces concurrent checkBalance calls into a single RPC read", async () => {
    let resolveSend!: (val: unknown) => void;
    getTokenAccountsByOwnerMock.mockImplementation(() => ({
      send: () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    }));

    const monitor = new SolanaBalanceMonitor(WALLET, "https://rpc.example");
    const p1 = monitor.checkBalance();
    const p2 = monitor.checkBalance();
    const p3 = monitor.checkSufficient(500_000n);

    expect(getTokenAccountsByOwnerMock).toHaveBeenCalledTimes(1);
    resolveSend(tokenAccountResponse("3000000"));

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.balance).toBe(3_000_000n);
    expect(r2.balance).toBe(3_000_000n);
    expect(r3.sufficient).toBe(true);
    expect(getTokenAccountsByOwnerMock).toHaveBeenCalledTimes(1);
  });

  it("does not let a pre-invalidation in-flight read overwrite newer cache state", async () => {
    const resolvers: Array<(val: unknown) => void> = [];
    getTokenAccountsByOwnerMock.mockImplementation(() => ({
      send: () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    }));

    const monitor = new SolanaBalanceMonitor(WALLET, "https://rpc.example");
    const staleCall = monitor.checkBalance();
    expect(getTokenAccountsByOwnerMock).toHaveBeenCalledTimes(1);

    monitor.invalidate();
    const freshCall = monitor.checkBalance();
    expect(getTokenAccountsByOwnerMock).toHaveBeenCalledTimes(2);

    resolvers[1]!(tokenAccountResponse("500000"));
    expect((await freshCall).balance).toBe(500_000n);

    resolvers[0]!(tokenAccountResponse("8000000"));
    await staleCall;

    const cached = await monitor.checkBalance();
    expect(cached.balance).toBe(500_000n);
    expect(getTokenAccountsByOwnerMock).toHaveBeenCalledTimes(2);
  });
});
