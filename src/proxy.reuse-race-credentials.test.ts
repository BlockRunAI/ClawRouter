/**
 * Both reuse paths must check credentials, not just the one that is easy to
 * reach from a test.
 *
 * `startProxy` can attach to an already-running proxy two ways: the pre-listen
 * probe, and the EADDRINUSE branch taken when another process wins the bind in
 * between. Only the pre-listen path validated. The race branch compared the
 * payment chain and nothing else, so an API-key caller landing on a Base wallet
 * proxy reused it and returned a handle reporting `authMode: "api-key"` and the
 * key's masked label — while every request was paid in USDC from the wallet.
 * It also tested `error.wallet` for truthiness, and an API-key proxy publishes
 * an EMPTY wallet, so that case fell through to a non-Error throw.
 *
 * The race is not reachable deterministically from a test — it needs a second
 * process to bind between the probe and `listen()`. What is checkable, and what
 * actually broke, is that neither path carries its own copy of the rule. These
 * read the source for that, in the same spirit as the assertion that
 * `startProxy` registers the spend-policy hook at all: the behaviour had full
 * coverage on one path while the other silently had none.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(import.meta.dirname, "proxy.ts"), "utf8");

describe("proxy reuse credential checks", () => {
  it("routes both reuse paths through the same validator", () => {
    const calls = source.match(/assertExistingProxyBillsUs\(/g) ?? [];
    // One definition plus exactly two call sites: pre-listen, and the race.
    expect(calls).toHaveLength(3);
  });

  it("hands the race path the whole probe result, not just the wallet", () => {
    // `{ code: "REUSE_EXISTING", wallet: … }` could not carry authMode or the
    // key label, which is why that branch could not check them.
    expect(source).toMatch(/code:\s*"REUSE_EXISTING",\s*existing:/);
    expect(source).not.toMatch(/code:\s*"REUSE_EXISTING",\s*wallet:/);
  });

  it("does not gate the race branch on a truthy wallet", () => {
    // An API-key proxy publishes wallet: "" — a truthiness test drops it.
    expect(source).not.toMatch(/error\.code === "REUSE_EXISTING" && error\.wallet/);
  });
});
