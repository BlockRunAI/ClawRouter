/**
 * Reconciling the local journal against BlockRun's billing ledger.
 *
 * The three classifications carry different meanings and must not be conflated:
 *
 *   matched              — both sides have the call. A disagreement on AMOUNT is
 *                          the interesting case; it is how the 152x local
 *                          overstatement and the $0 partner undercount would
 *                          have been caught from the ledger side.
 *   chargedNotRecorded   — the gateway billed for a call this machine has no
 *                          record of. The finding worth alerting on: money left
 *                          the account for something that happened elsewhere.
 *   recordedNotCharged   — usually benign (free models, cache hits).
 *
 * The trap this file exists to pin: a "pending" row is usage whose charge is
 * not final. Treating it as a settled $0 would manufacture a discrepancy that
 * later resolves itself, and — worse — counting it toward the gateway total
 * would report a number that changes on the next run.
 */

import { describe, it, expect } from "vitest";
import { joinRows, formatReconcile, type LocalRow } from "./reconcile.js";
import type { UsageRow } from "./api-key.js";

const local = (requestId: string, cost: number, model = "openai/gpt-4o-mini"): LocalRow => ({
  requestId,
  model,
  cost,
  timestamp: "2026-09-05T18:00:00Z",
});

const remote = (
  requestId: string,
  costUsd: number | null,
  costState = "priced",
  endpoint = "/v1/chat/completions",
): UsageRow => ({
  requestId,
  timestamp: "2026-09-05T18:00:00Z",
  endpoint,
  model: "openai/gpt-4o-mini",
  kind: endpoint.includes("chat") ? "chat" : "service",
  inputTokens: 12,
  outputTokens: 8,
  costUsd,
  costState,
  status: 200,
});

describe("joinRows", () => {
  it("matches on request id and reports the amount delta", () => {
    // The 152x bug, seen from the ledger side.
    const r = joinRows([local("a", 0.001)], [remote("a", 0.0000066)]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].deltaUsd).toBeCloseTo(0.0009934, 9);
    expect(r.chargedNotRecorded).toHaveLength(0);
    expect(r.recordedNotCharged).toHaveLength(0);
  });

  it("flags a charge with no local record", () => {
    const r = joinRows([], [remote("ghost", 2.43)]);
    expect(r.chargedNotRecorded).toHaveLength(1);
    expect(r.gatewayTotalUsd).toBeCloseTo(2.43, 9);
  });

  it("flags a local record with no settled charge", () => {
    const r = joinRows([local("only-local", 0)], []);
    expect(r.recordedNotCharged).toHaveLength(1);
    expect(r.chargedNotRecorded).toHaveLength(0);
  });

  it("excludes pending rows from the totals and from both discrepancy lists", () => {
    // A pending charge is not yet final. Counting it as $0 would invent a
    // mismatch; counting it at face value would report a total that moves.
    // `done` is matched locally so it cannot land in chargedNotRecorded, which
    // isolates the pending row as the only thing under test.
    const r = joinRows([local("done", 0.01)], [remote("p", null, "pending"), remote("done", 0.01)]);
    expect(r.pending).toHaveLength(1);
    expect(r.chargedNotRecorded).toHaveLength(0); // the pending row is NOT a finding
    expect(r.matched).toHaveLength(1); // only `done`
    expect(r.gatewayTotalUsd).toBeCloseTo(0.01, 9); // pending NOT in the total
  });

  it("does not treat a pending row as a local-only record either", () => {
    // The local side has it; the ledger has it as pending. Neither list.
    const r = joinRows([local("p", 0.002)], [remote("p", null, "pending")]);
    expect(r.pending).toHaveLength(1);
    expect(r.matched).toHaveLength(0);
    expect(r.recordedNotCharged).toHaveLength(1);
    expect(r.chargedNotRecorded).toHaveLength(0);
  });

  it("counts free rows at zero rather than dropping them", () => {
    const r = joinRows([local("f", 0)], [remote("f", 0, "free")]);
    expect(r.matched).toHaveLength(1);
    expect(r.gatewayTotalUsd).toBe(0);
  });

  it("reports unkeyed journal entries separately from mismatches", () => {
    // Pre-f927cd8 entries and free/cache-hit rows have no id. Absence of a join
    // key is not a discrepancy.
    const r = joinRows([], [], 1353);
    expect(r.unkeyedLocalCount).toBe(1353);
    expect(r.chargedNotRecorded).toHaveLength(0);
    expect(r.recordedNotCharged).toHaveLength(0);
  });
});

describe("formatReconcile", () => {
  it("surfaces an unrecorded charge prominently", () => {
    const out = formatReconcile(joinRows([], [remote("ghost", 2.43)]), 7);
    expect(out).toContain("Charged but NOT in this machine's journal");
    expect(out).toContain("$2.43");
  });

  it("explains the top-up fee gap so the card total is not read as a mismatch", () => {
    const out = formatReconcile(joinRows([], []), 7);
    expect(out).toMatch(/top-up fee/i);
  });

  it("warns when the gateway could not list some days", () => {
    const out = formatReconcile(joinRows([], [], 0, ["2026-09-01"]), 7);
    expect(out).toContain("could not list");
    expect(out).toContain("2026-09-01");
  });

  it("renders sub-cent amounts at full precision rather than rounding to $0.00", () => {
    // Rounding a real charge to $0.00 is how a discrepancy hides.
    const out = formatReconcile(joinRows([local("a", 0.001)], [remote("a", 0.0000066)]), 1);
    expect(out).toContain("0.000007");
  });
});
