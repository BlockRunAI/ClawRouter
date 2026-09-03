/**
 * A torn spending.json against the REAL FileSpendControlStorage.
 *
 * The unit tests for this path use an in-memory storage stub that throws
 * UnreadableSpendPolicyError on demand. That proves the branch, not that a
 * genuinely truncated file on disk reaches it — and the whole failure mode is
 * "the file is not what the parser expected", which a stub cannot reproduce.
 *
 * Uses a temp HOME set BEFORE importing spend-control.js: WALLET_DIR is
 * computed from homedir() at module load (same pattern as
 * auth.payment-chain-default.test.ts).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEMP_HOME = mkdtempSync(join(tmpdir(), "clawrouter-torn-"));
process.env.HOME = TEMP_HOME;
process.env.USERPROFILE = TEMP_HOME;

const { SpendControl } = await import("./spend-control.js");
const { runPolicyCommand } = await import("./commands/policy.js");

const WALLET_DIR = join(TEMP_HOME, ".openclaw", "blockrun");
const SPENDING = join(WALLET_DIR, "spending.json");
const TORN = '{"limits":{"daily":1},"history":[{"timestamp":1,"amo';

beforeEach(() => {
  mkdirSync(WALLET_DIR, { recursive: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => rmSync(TEMP_HOME, { recursive: true, force: true }));

describe("a truncated spending.json on disk", () => {
  it("does not take the constructor down, and starts with no limits", () => {
    writeFileSync(SPENDING, TORN);
    const control = new SpendControl();
    expect(control.check(5).allowed).toBe(true); // unchanged startup behaviour
  });

  it("does not widen a running instance's limits on reload", () => {
    writeFileSync(SPENDING, JSON.stringify({ limits: { daily: 1 }, history: [] }));
    const control = new SpendControl();
    expect(control.check(5).allowed).toBe(false);

    writeFileSync(SPENDING, TORN);
    control.reloadLimits();
    expect(control.check(5).allowed).toBe(false); // the cap survives the torn read
  });

  it("is never overwritten by a history save", () => {
    writeFileSync(SPENDING, JSON.stringify({ limits: { daily: 1 }, history: [] }));
    const control = new SpendControl();
    writeFileSync(SPENDING, TORN);
    control.record(0.01, { model: "some/model" });
    // Writing history would have rewritten limits from an unreadable read.
    expect(readFileSync(SPENDING, "utf8")).toBe(TORN);
  });

  it("makes a policy write report failure rather than a false success", () => {
    writeFileSync(SPENDING, TORN);
    const result = runPolicyCommand(["limit", "daily", "2"]);
    expect(result.isError).toBe(true);
    expect(readFileSync(SPENDING, "utf8")).toBe(TORN);
  });
});
