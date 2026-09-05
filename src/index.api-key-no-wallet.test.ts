/**
 * API-key mode must never mint a wallet.
 *
 * The promise in the README is absolute: "In API-key mode ClawRouter never
 * generates, reads or signs with a private key." `resolveOrGenerateWalletKey()`
 * creates one as a side effect, so every call site has to check for a key
 * first. Three of the four did. The fourth — the plugin's non-gateway-mode
 * registration branch in `register()` — called it unconditionally, so a
 * card-paying user installing the OpenClaw plugin got a freshly minted private
 * key plus a "BACK UP YOUR KEY NOW — losing this key = losing your USDC"
 * banner for a wallet that would never be used.
 *
 * That branch fires inside `register()` with a live OpenClaw `api` object and
 * an async IIFE, which makes it awkward to drive from a unit test. The
 * invariant is structural, so this guards it structurally — the same approach
 * as install-script-permissions.test.ts and chain-models-in-catalog.test.ts.
 * A behavioural test would be better; no test at all was what shipped the bug.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "index.ts");
const source = readFileSync(SRC, "utf8");

/**
 * Every real `resolveOrGenerateWalletKey(` call site, with surrounding context.
 *
 * Skips the import statement and any occurrence inside a comment — the comments
 * warning about this very function name would otherwise register as call sites
 * and make the guard fail on its own documentation.
 */
function callSites(text: string): { index: number; context: string }[] {
  const sites: { index: number; context: string }[] = [];
  const needle = "resolveOrGenerateWalletKey(";
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index === -1) break;
    from = index + needle.length;
    const lineStart = text.lastIndexOf("\n", index) + 1;
    const line = text.slice(lineStart, text.indexOf("\n", index));
    const beforeOnLine = text.slice(lineStart, index);
    const isComment = /^\s*(\/\/|\*|\/\*)/.test(line) || beforeOnLine.includes("//");
    const isImport = /^\s*resolveOrGenerateWalletKey,\s*$/.test(line);
    if (isComment || isImport) continue;
    sites.push({ index, context: text.slice(Math.max(0, index - 1400), index) });
  }
  return sites;
}

/** The same skip rule, for locating a call inside one extracted block. */
function firstCallIndex(block: string, needle: string): number {
  let from = 0;
  for (;;) {
    const index = block.indexOf(needle, from);
    if (index === -1) return -1;
    from = index + needle.length;
    const lineStart = block.lastIndexOf("\n", index) + 1;
    const line = block.slice(lineStart, block.indexOf("\n", index));
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    return index;
  }
}

describe("API-key mode never mints a wallet", () => {
  it("guards every resolveOrGenerateWalletKey call site with an API-key check", () => {
    const sites = callSites(source);
    expect(sites.length).toBeGreaterThan(0);

    const unguarded = sites.filter(
      (s) => !/resolveApiKey\(|\bapiKey\b|keyResolution/.test(s.context),
    );

    expect(
      unguarded.map((s) => source.slice(0, s.index).split("\n").length),
      "resolveOrGenerateWalletKey() MINTS a private key. Every call site in index.ts must " +
        "resolve the BlockRun API key first and skip the wallet when one is configured. " +
        "Unguarded call sites are at the line numbers above.",
    ).toEqual([]);
  });

  it("resolves the API key before the wallet in the non-gateway registration branch", () => {
    const branch = source.slice(source.indexOf("if (!isGatewayMode()) {"));
    const block = branch.slice(0, branch.indexOf("Not in gateway mode"));

    const keyAt = firstCallIndex(block, "resolveApiKey(");
    const walletAt = firstCallIndex(block, "resolveOrGenerateWalletKey(");

    expect(keyAt, "non-gateway registration branch must resolve the API key").toBeGreaterThan(-1);
    expect(walletAt, "non-gateway registration branch still resolves a wallet").toBeGreaterThan(-1);
    expect(
      keyAt,
      "the API key must be resolved BEFORE resolveOrGenerateWalletKey can mint one",
    ).toBeLessThan(walletAt);
  });

  it("returns early on a key rather than falling through to the wallet banner", () => {
    const branch = source.slice(source.indexOf("if (!isGatewayMode()) {"));
    const block = branch.slice(0, branch.indexOf("Not in gateway mode"));
    const afterKey = block.slice(firstCallIndex(block, "resolveApiKey("));
    const beforeWallet = afterKey.slice(0, firstCallIndex(afterKey, "resolveOrGenerateWalletKey("));

    expect(
      /\breturn\b/.test(beforeWallet),
      "an API key must short-circuit before the wallet call, not merely precede it",
    ).toBe(true);
    expect(beforeWallet).toContain("billing account credit, no wallet");
  });
});
