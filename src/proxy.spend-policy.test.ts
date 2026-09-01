import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";
import { SpendControl, InMemorySpendControlStorage, CAIP2_BASE } from "./spend-control.js";
import { runPolicyCommand } from "./commands/policy.js";

/**
 * Pins the enforcement wiring itself, not just the helper.
 *
 * `registerSpendPolicyHook` had full unit coverage against a hand-built
 * x402Client while nothing asserted that `startProxy` actually registers it —
 * deleting that one line from proxy.ts left every test green and shipped a
 * spend policy that governed nothing.
 *
 * Also pins the classification: a policy refusal must reach the caller as a
 * refusal. Treated as a retryable provider error it walks the whole paid
 * fallback chain and then answers 200 from a free model, so the caller never
 * learns their own policy blocked the payment.
 */
describe("startProxy enforces spend policy on the live payment path", () => {
  const blockedPayee = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
  let upstream: Server;
  let proxy: ProxyHandle;
  let control: SpendControl;
  let unpaidHits = 0;
  let paidHits = 0;

  beforeAll(async () => {
    upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.headers["x-payment"]) {
          // The signer ran and a payment was attached — the policy failed to stop it.
          paidHits++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "paid" } }] }));
          return;
        }
        unpaidHits++;
        // x402 v2 carries the challenge in the PAYMENT-REQUIRED header
        // (base64 JSON); only v1 puts it in the body.
        const challenge = {
          x402Version: 2,
          resource: { url: "http://127.0.0.1/v1/chat/completions" },
          accepts: [
            {
              scheme: "exact",
              network: CAIP2_BASE,
              amount: "10000",
              asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              payTo: blockedPayee,
              maxTimeoutSeconds: 60,
              extra: {},
            },
          ],
        };
        res.writeHead(402, {
          "Content-Type": "application/json",
          "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
        });
        res.end(JSON.stringify({ error: "payment required" }));
      });
    });

    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address() as AddressInfo;

    // Configure through the operator command rather than setPolicy() directly, so
    // this pins the whole path: CLI/plugin surface -> spending store -> pre-sign hook.
    const storage = new InMemorySpendControlStorage();
    const applied = runPolicyCommand(["set", "blockedPayees", blockedPayee], {
      openControl: () => new SpendControl({ storage }),
    });
    expect(applied.isError).toBeFalsy();
    control = new SpendControl({ storage });

    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: `http://127.0.0.1:${addr.port}`,
      port: 0,
      skipBalanceCheck: true,
      spendControl: control,
    });
  }, 20_000);

  afterAll(async () => {
    await proxy?.close();
    upstream.closeAllConnections?.();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  beforeEach(() => {
    unpaidHits = 0;
    paidHits = 0;
  });

  it("refuses to sign for a blocked payee and never attaches a payment", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4.6",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    });

    const text = await res.text();

    // The wallet never signed: upstream saw the unpaid probe and no retry
    // carrying an X-PAYMENT header.
    expect(paidHits).toBe(0);
    expect(unpaidHits).toBeGreaterThan(0);

    // And the caller is told, rather than being handed a quiet free-model 200.
    expect(res.status).not.toBe(200);
    expect(text).toMatch(/blocked by policy|spend_policy_denied/i);
  }, 30_000);
});
