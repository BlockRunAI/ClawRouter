import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  sigType: 0,
  waitForReceipt: vi.fn(async () => ({})),
  clob: {
    getOrderBook: vi.fn(async () => ({
      tick_size: "0.01",
      neg_risk: h.negRisk,
      min_order_size: "5",
      asks: [{ price: "0.55", size: "100" }],
      bids: [{ price: "0.45", size: "100" }],
    })),
    getMarket: vi.fn(async () => ({
      question: "Will it happen?",
      neg_risk: h.negRisk,
      closed: true,
      tokens: [{ token_id: "777", outcome: "Yes", winner: true }],
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
    waitForTransactionReceipt: h.waitForReceipt,
  }),
  getPusdBalance: async () => 5,
}));
vi.mock("./relayer.js", () => ({ sendWalletBatch: h.sendWalletBatch }));
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createWalletClient: () => ({ sendTransaction: h.sendTransaction }),
}));
vi.mock("./constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./constants.js")>()),
  getSigType: () => h.sigType,
}));

import { x402Client } from "@x402/fetch";
import { runPolicyCommand } from "../commands/policy.js";
import { fundVault } from "./fund.js";
import { executeTrade, getSessionLedger } from "./orders.js";
import { redeemPosition } from "./redeem.js";
import { buildPolymarketTool } from "./tool.js";
import { withdrawFunds } from "./withdraw.js";
import {
  BASE_USDC,
  CONDITIONAL_TOKENS,
  CTF_EXCHANGE_V2,
  NEG_RISK_ADAPTER,
  NEG_RISK_CTF_EXCHANGE_V2,
  PUSD_COLLATERAL,
} from "./constants.js";
import {
  InMemorySpendControlStorage,
  getSharedSpendControl,
  registerSpendPolicyHook,
  setSharedSpendControl,
  CAIP2_BASE,
  SpendControl,
} from "../spend-control.js";

function inMemoryControl(): SpendControl {
  return new SpendControl({ storage: new InMemorySpendControlStorage() });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.sigType = 0;
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

  it("releases the policy reservation when the CLOB resolves but rejects the order", async () => {
    // A resolved { success:false } is not a throw. Without the placed check
    // inside the policy callback, the reservation settles as real spend and a
    // rejected order eats the operator's window.
    const control = inMemoryControl();
    control.setLimit("session", 5); // exactly one $5 order's worth
    const counterparty = { payTo: CTF_EXCHANGE_V2, network: "eip155:137", asset: PUSD_COLLATERAL };
    h.clob.createAndPostOrder.mockResolvedValueOnce({
      success: false,
      errorMsg: "rejected by CLOB",
    } as never);
    const before = getSessionLedger().totalUsd;

    const r = await executeTrade(limitBuy, { spendControl: control });

    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/rejected by CLOB/);
    expect(getSessionLedger().totalUsd).toBe(before);
    // The window is intact: the same $5 is still allowed afterwards.
    expect(control.check(5, counterparty).allowed).toBe(true);
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

describe("redeemPosition consults spend policy before signing the claim", () => {
  // Redeem moves NO capital out — it burns the wallet's own outcome tokens and
  // credits collateral back to the same wallet — so the amount checked is 0.
  // The check is still pinned: payee/network lists govern every signed path,
  // and the contract called (ConditionalTokens vs NegRiskAdapter) is the payee.
  const redeem = { condition_id: `0x${"ab".repeat(32)}`, confirm: true };

  beforeEach(() => {
    h.negRisk = false;
  });

  it("refuses a blocked ConditionalTokens contract and never signs on either path", async () => {
    const control = inMemoryControl();
    control.setPolicy("blockedPayees", [CONDITIONAL_TOKENS]);

    const r = await redeemPosition(redeem, { spendControl: control });

    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/blocked by policy/i);
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(h.sendWalletBatch).not.toHaveBeenCalled();
  });

  it("signs for an allowed contract and hands policy the redeem target with amount 0", async () => {
    const control = inMemoryControl();
    const check = vi.spyOn(control, "check");

    const r = await redeemPosition(redeem, { spendControl: control });

    expect(r.isError).toBeFalsy();
    expect(h.sendTransaction).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(0, {
      payTo: CONDITIONAL_TOKENS,
      network: "eip155:137",
      asset: PUSD_COLLATERAL,
    });
  });

  it("routes negRisk markets to the NegRiskAdapter, so an allowlist for ConditionalTokens refuses", async () => {
    h.negRisk = true;
    const control = inMemoryControl();
    control.setPolicy("allowedPayees", [CONDITIONAL_TOKENS]);
    const check = vi.spyOn(control, "check");

    const r = await redeemPosition(redeem, { spendControl: control });

    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not in the configured allowlist/i);
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(h.sendWalletBatch).not.toHaveBeenCalled();
    expect(check.mock.calls[0]?.[1]?.payTo).toBe(NEG_RISK_ADAPTER);
  });
});

describe("redeemPosition confirms the claim before reporting success", () => {
  const redeem = { condition_id: `0x${"ab".repeat(32)}`, confirm: true };

  beforeEach(() => {
    h.negRisk = false;
  });

  it("waits for the receipt on the direct EOA path", async () => {
    const r = await redeemPosition(redeem, { spendControl: inMemoryControl() });

    expect(r.isError).toBeFalsy();
    expect(h.sendTransaction).toHaveBeenCalledTimes(1);
    expect(h.waitForReceipt).toHaveBeenCalledWith({ hash: "0xpolygon-tx" });
  });

  it("does not double-wait on the relayer path, which confirms inside sendWalletBatch", async () => {
    h.sigType = 3;

    const r = await redeemPosition(redeem, { spendControl: inMemoryControl() });

    expect(r.isError).toBeFalsy();
    expect(h.sendWalletBatch).toHaveBeenCalledTimes(1);
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(h.waitForReceipt).not.toHaveBeenCalled();
  });
});

describe("every surface shares ONE ledger at runtime", () => {
  // LLM spend recorded exactly as the proxy's x402 hook settles it.
  function recordLlmSpend(control: SpendControl, usd: number): void {
    control.settleReservation(control.reserve(usd), { action: "x402 payment" });
  }

  // Limit buy 10 @ 0.50 → $5 notional.
  const limitBuy = { action: "buy" as const, token_id: "123", price: 0.5, size: 10, confirm: true };

  beforeEach(() => {
    h.negRisk = false;
  });

  it("LLM spend recorded through the wired instance blocks a Polymarket order placed via tool.execute with no per-call deps", async () => {
    const control = inMemoryControl();
    control.setLimit("hourly", 1);
    recordLlmSpend(control, 2);

    const tool = buildPolymarketTool({ spendControl: control });
    const r = (await tool.execute("t1", {
      action: "buy",
      token_id: "123",
      price: 0.5,
      size: 10,
      confirm: true,
    })) as { content: { text: string }[] };

    expect(r.content[0].text).toMatch(/Hourly limit exceeded/i);
    expect(h.clob.createAndPostOrder).not.toHaveBeenCalled();
    expect(h.clob.createAndPostMarketOrder).not.toHaveBeenCalled();
  });

  it("with no deps at all, the tool functions resolve the shared instance, not a private one", async () => {
    const shared = inMemoryControl();
    shared.setLimit("hourly", 1);
    recordLlmSpend(shared, 2);
    setSharedSpendControl(shared);

    // No deps: before the shared instance this constructed a fresh polymarket
    // ledger that had never seen the LLM spend above, and the order went out.
    const r = await executeTrade(limitBuy);

    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Hourly limit exceeded/i);
    expect(h.clob.createAndPostOrder).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  setSharedSpendControl(new SpendControl({ storage: new InMemorySpendControlStorage() }));
});

describe("the singleton is the one ledger every surface reads and writes", () => {
  const limitBuy = { action: "buy" as const, token_id: "123", price: 0.5, size: 10, confirm: true };

  beforeEach(() => {
    h.negRisk = false;
  });

  it("a /policy write on the singleton is enforced by a Polymarket order placed with no deps", async () => {
    const storage = new InMemorySpendControlStorage();
    setSharedSpendControl(new SpendControl({ storage }));

    const res = runPolicyCommand(["set", "blockedPayees", CTF_EXCHANGE_V2], {
      liveControl: getSharedSpendControl,
      openControl: () => new SpendControl({ storage }),
    });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("Applied to the running proxy");

    const r = await executeTrade(limitBuy);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/blocked by policy/i);
    expect(h.clob.createAndPostOrder).not.toHaveBeenCalled();
  });

  it("Polymarket spend recorded on the singleton refuses a proxy payment over the cap", async () => {
    const shared = new SpendControl({ storage: new InMemorySpendControlStorage() });
    shared.setLimit("hourly", 6);
    setSharedSpendControl(shared);

    expect((await executeTrade(limitBuy)).isError).toBeFalsy(); // $5 notional, allowed

    let signerCalls = 0;
    const client = new x402Client();
    registerSpendPolicyHook(client, getSharedSpendControl());
    client.register(CAIP2_BASE, {
      scheme: "exact",
      async createPaymentPayload() {
        signerCalls += 1;
        return { x402Version: 2, payload: {} };
      },
    });
    await expect(
      client.createPaymentPayload({
        x402Version: 2,
        resource: { url: "https://example.invalid/pay" },
        accepts: [
          {
            scheme: "exact",
            network: CAIP2_BASE,
            amount: "2000000", // $2: 5 + 2 > 6
            asset: "USDC",
            payTo: h.ATTACKER,
            maxTimeoutSeconds: 60,
            extra: {},
          },
        ],
      }),
    ).rejects.toThrow(/hourly limit/i);
    expect(signerCalls).toBe(0);
  });
});
