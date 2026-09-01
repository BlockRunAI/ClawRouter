import { describe, it, expect, afterEach } from "vitest";
import { buildPolymarketTool } from "./tool.js";
import { installUnderscoreHeaderBridge } from "./client.js";
import { getMaxBetUsd, getMaxSessionUsd } from "./constants.js";
import { executeTrade } from "./orders.js";

describe("buildPolymarketTool", () => {
  const tool = buildPolymarketTool();

  it("registers as blockrun_polymarket with action required", () => {
    expect(tool.name).toBe("blockrun_polymarket");
    expect(tool.parameters.required).toContain("action");
  });

  it("exposes all nine actions", () => {
    const action = tool.parameters.properties.action as { enum: string[] };
    expect(action.enum).toEqual([
      "setup",
      "fund",
      "buy",
      "sell",
      "cancel",
      "orders",
      "positions",
      "redeem",
      "withdraw",
    ]);
  });

  it("warns REAL MONEY in the description so agents gate on confirm", () => {
    expect(tool.description).toContain("REAL MONEY");
    expect(tool.description).toContain("confirm:true");
  });
});

describe("safety caps (fail-closed parsing)", () => {
  const KEY = "POLYMARKET_MAX_BET_USD";
  const SESSION = "POLYMARKET_MAX_SESSION_USD";
  afterEach(() => {
    delete process.env[KEY];
    delete process.env[SESSION];
  });

  it("defaults the per-order cap to $25 when unset", () => {
    delete process.env[KEY];
    expect(getMaxBetUsd()).toBe(25);
  });

  it("honors a valid override", () => {
    process.env[KEY] = "5";
    expect(getMaxBetUsd()).toBe(5);
  });

  it("fails CLOSED (0) on garbage so a misconfigured cap blocks trading", () => {
    process.env[KEY] = "$100";
    expect(getMaxBetUsd()).toBe(0);
  });

  it("session cap is null (uncapped) when unset, honors 0 as freeze", () => {
    delete process.env[SESSION];
    expect(getMaxSessionUsd()).toBeNull();
    process.env[SESSION] = "0";
    expect(getMaxSessionUsd()).toBe(0);
  });
});

describe("underscore-header proxy bridge", () => {
  it("duplicates POLY_* underscore headers as hyphenated copies", () => {
    let captured: ((config: unknown) => unknown) | undefined;
    const fakeInstance = {
      interceptors: { request: { use: (fn: (c: unknown) => unknown) => (captured = fn) } },
    };
    installUnderscoreHeaderBridge(fakeInstance);
    expect(captured).toBeTypeOf("function");

    const headers: Record<string, unknown> = { POLY_ADDRESS: "0xabc", POLY_API_KEY: "k" };
    captured!({ headers });
    expect(headers["poly-address"]).toBe("0xabc");
    expect(headers["poly-api-key"]).toBe("k");
    // Original underscore header is left intact (Polymarket reads it directly).
    expect(headers["POLY_ADDRESS"]).toBe("0xabc");
  });
});

describe("trade gating (cross-field validation, no network)", () => {
  it("rejects a limit order missing size before touching the CLOB", async () => {
    const r = await executeTrade({ action: "buy", token_id: "1", price: 0.5 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/limit orders need both price and size/i);
  });

  it("rejects a market buy missing amount_usd", async () => {
    const r = await executeTrade({ action: "buy", token_id: "1" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/market buys need amount_usd/i);
  });

  it("rejects a market sell missing size", async () => {
    const r = await executeTrade({ action: "sell", token_id: "1" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/market sells need size/i);
  });

  it("rejects GTD without an expiry", async () => {
    const r = await executeTrade({
      action: "buy",
      token_id: "1",
      price: 0.5,
      size: 10,
      order_type: "GTD",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/GTD orders need expires_at/i);
  });

  // A negative or zero amount_usd must be rejected here, before any network
  // call: it becomes the order's notional, and being additive it lets
  // `ledger.totalUsd + notional > sessionCap` be satisfied by *reducing*
  // totalUsd instead of raising it — silently defeating
  // POLYMARKET_MAX_SESSION_USD for every order placed afterward.
  it("rejects a market buy with a negative amount_usd before touching the CLOB", async () => {
    const r = await executeTrade({ action: "buy", token_id: "1", amount_usd: -5 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/amount_usd must be a positive dollar amount/i);
  });

  it("rejects a market buy with amount_usd of zero before touching the CLOB", async () => {
    const r = await executeTrade({ action: "buy", token_id: "1", amount_usd: 0 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/amount_usd must be a positive dollar amount/i);
  });
});
