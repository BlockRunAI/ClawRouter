import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring tests for the Polymarket signing paths. Each one builds an in-memory
 * SpendControl with the target counterparty on a deny list, runs the real
 * tool function with every network/keystore edge mocked, and asserts the
 * signing/order/transaction function was NEVER called. An allowed-counterparty
 * case per path pins that the check is additive — it also pins the exact
 * counterparty fields handed to policy, since a wrong payTo/network/asset
 * would make an operator's allowlist govern the wrong thing.
 */
const h = vi.hoisted(() => ({
  AGENT: "0x1111111111111111111111111111111111111111",
  VAULT: "0x2222222222222222222222222222222222222222",
  BRIDGE: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ATTACKER: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
  sendTransaction: vi.fn(async () => "0xpolygon-tx"),
  sendWalletBatch: vi.fn(async () => ({ transactionHash: "0xrelayer-tx" })),
  createPaymentPayload: vi.fn(async () => "0xsigned-authorization"),
  feePost: vi.fn(async () => ({ success: true, deposit: { txHash: "0xdeposit" } })),
  axiosPost: vi.fn(async () => ({
    data: { address: { evm: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } },
  })),
  negRisk: false,
  clob: {
    getOrderBook: vi.fn(async () => ({
      tick_size: "0.01",
      neg_risk: h.negRisk,
      min_order_size: "5",
      asks: [{ price: "0.55", size: "100" }],
      bids: [{ price: "0.45", size: "100" }],
    })),
    createAndPostOrder: vi.fn(async () => ({ success: true, orderID: "ord-1", status: "live" })),
    createAndPostMarketOrder: vi.fn(async () => ({ success: true, orderID: "ord-2" })),
  },
}));

vi.mock("@blockrun/llm", () => ({
  createPaymentPayload: h.createPaymentPayload,
  BlockrunClient: class {
    post = h.feePost;
  },
}));
vi.mock("axios", () => ({ default: { post: h.axiosPost } }));
vi.mock("./wallet-adapter.js", () => ({
  getOrCreateWalletKey: () => `0x${"11".repeat(32)}`,
  getChainBalance: async () => 100,
}));
vi.mock("./client.js", () => ({
  getPolymarketAccount: () => ({ address: h.AGENT }),
  getClobClient: async () => h.clob,
  checkGeoblock: async () => ({}),
  resetClobClient: () => {},
}));
vi.mock("./positions.js", () => ({ getFundsAddress: () => h.VAULT }));
vi.mock("./setup.js", () => ({
  getPublicClient: () => ({
    readContract: async () => 5_000_000n, // $5 pUSD in the deposit wallet
    waitForTransactionReceipt: async () => ({}),
  }),
}));
vi.mock("./relayer.js", () => ({ sendWalletBatch: h.sendWalletBatch }));
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createWalletClient: () => ({ sendTransaction: h.sendTransaction }),
}));
vi.mock("./constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./constants.js")>()),
  getSigType: () => 0,
}));

import { fundVault } from "./fund.js";
import { executeTrade, getSessionLedger } from "./orders.js";
import { withdrawFunds } from "./withdraw.js";
import {
  BASE_USDC,
  CTF_EXCHANGE_V2,
  NEG_RISK_CTF_EXCHANGE_V2,
  PUSD_COLLATERAL,
} from "./constants.js";
import { InMemorySpendControlStorage, SpendControl } from "../spend-control.js";

function inMemoryControl(): SpendControl {
  return new SpendControl({ storage: new InMemorySpendControlStorage() });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fundVault consults spend policy before signing the deposit", () => {
  it("refuses a blocked bridge and never signs or pays the fee", async () => {
    const control = inMemoryControl();
    control.setPolicy("blockedPayees", [h.BRIDGE]);

    const r = await fundVault({ amount_usd: 5, confirm: true }, { spendControl: control });

    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/blocked by policy/i);
    expect(h.createPaymentPayload).not.toHaveBeenCalled();
    expect(h.feePost).not.toHaveBeenCalled();
  });

  it("signs for an allowed bridge and hands policy the real counterparty", async () => {
    const control = inMemoryControl();
    const check = vi.spyOn(control, "check");

    const r = await fundVault({ amount_usd: 5, confirm: true }, { spendControl: control });

    expect(r.isError).toBeFalsy();
    expect(h.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(5, {
      payTo: h.BRIDGE,
      network: "eip155:8453",
      asset: BASE_USDC,
    });
  });
});

describe("executeTrade consults spend policy before signing the order", () => {
  // Limit buy 10 @ 0.50 → $5 notional, under the default $25 per-order cap.
  const limitBuy = { action: "buy" as const, token_id: "123", price: 0.5, size: 10, confirm: true };

  beforeEach(() => {
    h.negRisk = false;
  });

  it("refuses a blocked exchange, never submits, and rolls back the bet ledger", async () => {
    const control = inMemoryControl();
    control.setPolicy("blockedPayees", [CTF_EXCHANGE_V2]);
    const before = getSessionLedger().totalUsd;

    const r = await executeTrade(limitBuy, { spendControl: control });

    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/blocked by policy/i);
    expect(h.clob.createAndPostOrder).not.toHaveBeenCalled();
    expect(h.clob.createAndPostMarketOrder).not.toHaveBeenCalled();
    expect(getSessionLedger().totalUsd).toBe(before);
  });

  it("submits for an allowed exchange and hands policy the real counterparty", async () => {
    const control = inMemoryControl();
    const check = vi.spyOn(control, "check");

    const r = await executeTrade(limitBuy, { spendControl: control });

    expect(r.isError).toBeFalsy();
    expect(h.clob.createAndPostOrder).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(5, {
      payTo: CTF_EXCHANGE_V2,
      network: "eip155:137",
      asset: PUSD_COLLATERAL,
    });
  });

  it("routes negRisk markets to the NegRisk exchange, so an allowlist for the plain one refuses", async () => {
    h.negRisk = true;
    const control = inMemoryControl();
    control.setPolicy("allowedPayees", [CTF_EXCHANGE_V2]);
    const check = vi.spyOn(control, "check");

    const r = await executeTrade(limitBuy, { spendControl: control });

    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not in the configured allowlist/i);
    expect(h.clob.createAndPostOrder).not.toHaveBeenCalled();
    expect(check.mock.calls[0]?.[1]?.payTo).toBe(NEG_RISK_CTF_EXCHANGE_V2);
  });
});

describe("withdrawFunds consults spend policy before signing the transfer", () => {
  it("refuses an agent-chosen blocked recipient and never signs on either path", async () => {
    const control = inMemoryControl();
    control.setPolicy("blockedPayees", [h.ATTACKER]);

    const r = await withdrawFunds(
      { amount_usd: 3, to_address: h.ATTACKER, confirm: true },
      { spendControl: control },
    );

    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/blocked by policy/i);
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(h.sendWalletBatch).not.toHaveBeenCalled();
  });

  it("signs to the default agent wallet and hands policy the destination leg", async () => {
    const control = inMemoryControl();
    const check = vi.spyOn(control, "check");

    const r = await withdrawFunds({ amount_usd: 3, confirm: true }, { spendControl: control });

    expect(r.isError).toBeFalsy();
    expect(h.sendTransaction).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(3, {
      payTo: h.AGENT,
      network: "eip155:8453",
      asset: BASE_USDC,
    });
  });
});
