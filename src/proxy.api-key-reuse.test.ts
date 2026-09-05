/**
 * A running proxy may only be reused by the credential that started it.
 *
 * The mode check that existed before this separated wallet from API key, and
 * its comment claimed to "never reuse across credentials" — but it never
 * compared WHICH key. So `clawrouter login` with a second key, against a port
 * already serving the first, attached silently: the new process printed the new
 * key and reported "listening", while every request went on being charged to
 * the previous account.
 *
 * Reproduced on the shipped 0.12.272 before the fix: a proxy started with key A
 * kept answering /health as key A while a second process configured for key B
 * reported success on the same port.
 *
 * Cross-account billing with a success message in front of it is the worst
 * failure shape available here, so an unverifiable match is refused rather than
 * assumed.
 */

import { describe, expect, it } from "vitest";
import { startProxy } from "./proxy.js";

// Well-formed but inert: `isValidApiKey` only checks the shape, and these tests
// never let a request reach the gateway.
const KEY_A = "brk_live_" + "A".repeat(32);
const KEY_B = "brk_live_" + "B".repeat(32);

// A range no other suite uses. 22000-32000 overlapped payment-chain-reuse
// (21000-31000), solana-rpc-override (22000-23000) and 23500-24000, so under
// vitest's parallel file execution two suites could bind the same port and
// fail each other intermittently — which they did, twice, before this narrowed.
const freePort = () => 34000 + Math.floor(Math.random() * 800);

describe("startProxy API-key reuse guard", () => {
  it("refuses to reuse a proxy that is billing a different key", async () => {
    const port = freePort();
    const first = await startProxy({ apiKey: KEY_A, port, skipBalanceCheck: true });
    try {
      await expect(startProxy({ apiKey: KEY_B, port, skipBalanceCheck: true })).rejects.toThrow(
        /billing/i,
      );
    } finally {
      await first.close();
    }
  });

  it("names both accounts, so the message says whose money was at stake", async () => {
    const port = freePort();
    const first = await startProxy({ apiKey: KEY_A, port, skipBalanceCheck: true });
    try {
      // Masked labels, never the raw keys — /health is unauthenticated on
      // localhost and a bearer token is not a status field.
      await expect(startProxy({ apiKey: KEY_B, port, skipBalanceCheck: true })).rejects.toThrow(
        /brk_live_AAAAA…AAAA[\s\S]*brk_live_BBBBB…BBBB/,
      );
    } finally {
      await first.close();
    }
  });

  it("still reuses cleanly for the SAME key", async () => {
    // The guard must not break the ordinary case it protects: one machine,
    // one key, a second client attaching to the proxy already running.
    const port = freePort();
    const first = await startProxy({ apiKey: KEY_A, port, skipBalanceCheck: true });
    try {
      const second = await startProxy({ apiKey: KEY_A, port, skipBalanceCheck: true });
      expect(second.port).toBe(port);
      expect(second.authMode).toBe("api-key");
      await second.close(); // a reused handle's close() is a no-op by design
    } finally {
      await first.close();
    }
  });

  it("still refuses to attach a wallet to an API-key proxy", async () => {
    // The original mode guard has to keep working — this test would pass
    // trivially if the new key comparison had replaced it rather than joined it.
    const port = freePort();
    const first = await startProxy({ apiKey: KEY_A, port, skipBalanceCheck: true });
    try {
      await expect(
        startProxy({
          wallet: "0x" + "11".repeat(32),
          port,
          skipBalanceCheck: true,
        }),
      ).rejects.toThrow(/API key|wallet/i);
    } finally {
      await first.close();
    }
  });
});
