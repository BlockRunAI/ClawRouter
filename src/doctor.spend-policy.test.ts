import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { wrapFetchWithPayment } from "@x402/fetch";

import { createDoctorX402Client } from "./doctor.js";
import { SpendControl, InMemorySpendControlStorage, CAIP2_BASE } from "./spend-control.js";

/**
 * Doctor builds its own x402 client and pays a real endpoint. Until this
 * landed it registered the signing schemes but not the spend-policy hook, so a
 * blocked payee the proxy refused was still paid by `clawrouter doctor`.
 * Same shape as proxy.spend-policy.test.ts: a mock upstream that challenges
 * with a 402 naming a blocked payee, and a count of retries that carried a
 * signed payment. That count must stay at zero.
 */
describe("doctor's x402 client enforces spend policy before signing", () => {
  const blockedPayee = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
  let upstream: Server;
  let url: string;
  let paidHits = 0;
  let unpaidHits = 0;

  beforeAll(async () => {
    upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.on("data", () => {});
      req.on("end", () => {
        if (req.headers["x-payment"] || req.headers["payment-signature"]) {
          paidHits++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "paid" } }] }));
          return;
        }
        unpaidHits++;
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
    url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1/chat/completions`;
  });

  afterAll(async () => {
    upstream.closeAllConnections?.();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("refuses a blocked payee and never attaches a payment", async () => {
    const control = new SpendControl({ storage: new InMemorySpendControlStorage() });
    control.setPolicy("blockedPayees", [blockedPayee]);
    const x402 = createDoctorX402Client({ walletKey: generatePrivateKey(), spendControl: control });
    const paymentFetch = wrapFetchWithPayment(fetch, x402);

    await expect(
      paymentFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    ).rejects.toThrow(/blocked by policy/i);

    expect(unpaidHits).toBeGreaterThan(0);
    expect(paidHits).toBe(0);
  }, 20_000);
});
