import { describe, expect, it, vi } from "vitest";
vi.mock("../../../../src/updater.js", () => ({ checkForUpdates: async () => {} }));
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { generateKeyPairSigner } from "@solana/kit";
import { startProxy, SpendControl, InMemorySpendControlStorage } from "@twzrd1111/clawrouter";
import { createMppFetch, createSolanaMppFetch } from "./index.js";
import { readCredits } from "./mpp-paid-failure.js";

describe("factory-produced rails through the streaming proxy", () => {
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "does not pay a fallback after an HTTP 200 provider error, stream=%s native=%s",
    async (stream, native) => {
      const signer = await generateKeyPairSigner();
      const recipient = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const id = `paid-200-error-${stream}-${native}`;
      const quote = {
        amount: "750",
        currency: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        recipient: recipient.address,
        methodDetails: {
          network: "devnet",
          decimals: 6,
          feePayer: true,
          feePayerKey: feePayer.address,
          recentBlockhash: "11111111111111111111111111111111",
          tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        },
      };
      const header = `Payment id="${id}", realm="fixture", method="solana", intent="charge", request="${Buffer.from(JSON.stringify(quote)).toString("base64url")}"`;
      const base = vi.fn(async (input: RequestInfo | URL) =>
        (input as Request).headers.has("authorization")
          ? new Response(
              native
                ? 'data: {"error":"Provider overloaded"}\n\n'
                : JSON.stringify({
                    error: { message: "Provider overloaded, service unavailable" },
                  }),
              { headers: { "content-type": native ? "text/event-stream" : "application/json" } },
            )
          : new Response("", { status: 402, headers: { "www-authenticate": header } }),
      ) as unknown as typeof fetch;
      const spend = new SpendControl({ storage: new InMemorySpendControlStorage() });
      spend.setLimit("daily", 1);
      const payFetch = await createSolanaMppFetch({
        signer,
        rpcUrl: "http://127.0.0.1:1",
        network: "devnet",
        spend,
        fetch: base,
      });
      const proxy = await startProxy({
        wallet: generatePrivateKey(),
        apiBase: "http://127.0.0.1:1",
        port: 0,
        skipBalanceCheck: true,
        allowExistingProxy: false,
        payFetch,
        spendControl: spend,
      });
      try {
        const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "blockrun/auto",
            stream,
            max_tokens: 8,
            messages: [{ role: "user", content: id }],
          }),
        });
        expect(response.status).toBe(native ? 200 : 502);
        expect(response.headers.get("payment-receipt")).toBeNull();
        if (native)
          expect(await response.text()).toContain('"type":"payment_settled_no_completion"');
        else expect((await response.json()).error.type).toBe("payment_settled_no_completion");
        expect(base).toHaveBeenCalledTimes(2); // one probe and one paid response, no other model
        expect(spend.getSpending("daily")).toBeCloseTo(0.00075, 8);
        expect(
          readCredits().filter((r) => r.payer === signer.address && r.challengeId === id),
        ).toEqual([{ payer: signer.address, amount: "750", challengeId: id, reason: "HTTP 200" }]);
      } finally {
        await proxy.close();
      }
    },
  );

  it.each(["tempo", "solana"])(
    "forwards the receipt with the %s factory's own capability",
    async (rail) => {
      const base = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return new Response(
          JSON.stringify({
            id: "fixture",
            choices: [
              { message: { role: "assistant", content: "factory works" }, finish_reason: "stop" },
            ],
          }),
          { headers: { "content-type": "application/json", "payment-receipt": "fixture-receipt" } },
        );
      }) as unknown as typeof fetch;
      const payFetch =
        rail === "tempo"
          ? createMppFetch(privateKeyToAccount(generatePrivateKey()), base)
          : await createSolanaMppFetch({
              signer: await generateKeyPairSigner(),
              rpcUrl: "http://127.0.0.1:1",
              network: "devnet",
              fetch: base,
            });
      const proxy = await startProxy({
        wallet: generatePrivateKey(),
        apiBase: "http://127.0.0.1:1",
        port: 0,
        skipBalanceCheck: true,
        allowExistingProxy: false,
        payFetch,
        spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
      });
      try {
        const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "openai/gpt-4o-mini",
            stream: true,
            max_tokens: 8,
            messages: [{ role: "user", content: rail }],
          }),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("payment-receipt")).toBe("fixture-receipt");
        const body = await response.text();
        expect(body).toContain("factory works");
        expect(body).toContain("[DONE]");
        expect(base).toHaveBeenCalledTimes(1);
      } finally {
        await proxy.close();
      }
    },
  );
});
