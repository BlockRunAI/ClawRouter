/**
 * x402 SDK integration tests — verifies client setup, scheme registration,
 * and wrapFetchWithPayment behavior.
 */

import { describe, it, expect, vi } from "vitest";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAllKeys, generateWalletMnemonic } from "./wallet.js";

// Deterministic test mnemonic (DO NOT use in production)
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

function createTestEvmClient(): x402Client {
  const keys = deriveAllKeys(TEST_MNEMONIC);
  const account = privateKeyToAccount(keys.evmPrivateKey);
  const publicClient = createPublicClient({ chain: base, transport: http() });
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  return client;
}

describe("x402 SDK integration", () => {
  describe("x402Client creation", () => {
    it("creates a client and registers EVM scheme without error", () => {
      const client = createTestEvmClient();
      expect(client).toBeInstanceOf(x402Client);
    });

    it("registers Solana scheme via registerExactSvmScheme", async () => {
      const { registerExactSvmScheme } = await import("@x402/svm/exact/client");
      const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");

      const keys = deriveAllKeys(TEST_MNEMONIC);
      const solanaSigner = await createKeyPairSignerFromPrivateKeyBytes(keys.solanaPrivateKeyBytes);

      const client = createTestEvmClient();
      // Should not throw
      registerExactSvmScheme(client, { signer: solanaSigner });
    });

    it("registers both EVM and Solana on the same client", async () => {
      const { registerExactSvmScheme } = await import("@x402/svm/exact/client");
      const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");

      const keys = deriveAllKeys(TEST_MNEMONIC);
      const account = privateKeyToAccount(keys.evmPrivateKey);
      const publicClient = createPublicClient({ chain: base, transport: http() });
      const evmSigner = toClientEvmSigner(account, publicClient);
      const solanaSigner = await createKeyPairSignerFromPrivateKeyBytes(keys.solanaPrivateKeyBytes);

      const client = new x402Client();
      registerExactEvmScheme(client, { signer: evmSigner });
      registerExactSvmScheme(client, { signer: solanaSigner });

      // Client exists and didn't throw during dual registration
      expect(client).toBeInstanceOf(x402Client);
    });
  });

  describe("wrapFetchWithPayment", () => {
    it("passes through non-402 responses unchanged", async () => {
      const mockResponse = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);

      const client = createTestEvmClient();
      const payFetch = wrapFetchWithPayment(mockFetch as unknown as typeof fetch, client);

      const res = await payFetch("https://example.com/api");
      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const body = await res.json();
      expect(body).toEqual({ ok: true });
    });

    it("passes through streaming responses without buffering", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: chunk1\n\n"));
          controller.enqueue(encoder.encode("data: chunk2\n\n"));
          controller.close();
        },
      });
      const mockResponse = new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);

      const client = createTestEvmClient();
      const payFetch = wrapFetchWithPayment(mockFetch as unknown as typeof fetch, client);

      const res = await payFetch("https://example.com/stream");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");

      // Body is still a readable stream
      const text = await res.text();
      expect(text).toContain("chunk1");
      expect(text).toContain("chunk2");
    });

    it("attempts payment on 402 response", async () => {
      // First call returns 402, second (after payment) returns 200
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "payment required" }), {
            status: 402,
            headers: {
              "X-PAYMENT": JSON.stringify({
                x402Version: 1,
                scheme: "exact",
                network: "base",
                paymentRequirements: [{
                  scheme: "exact",
                  network: "base",
                  maxAmountRequired: "1000",
                  resource: "https://example.com/api",
                  description: "test",
                  mimeType: "application/json",
                  payTo: "0x0000000000000000000000000000000000000001",
                  maxTimeoutSeconds: 60,
                  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                  outputSchema: undefined,
                  extra: {},
                }],
              }),
            },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: "paid" }), { status: 200 }),
        );

      const client = createTestEvmClient();
      const payFetch = wrapFetchWithPayment(mockFetch as unknown as typeof fetch, client);

      // This will get the 402, attempt to sign payment, and retry.
      // The signing may fail (no real on-chain state) but the flow
      // demonstrates the SDK processes 402 responses correctly.
      try {
        const res = await payFetch("https://example.com/api");
        // If payment signing succeeded (unlikely without chain state),
        // the second response should be returned
        expect(res.status).toBe(200);
      } catch (err) {
        // Expected: signing fails without real chain state,
        // but the error should be about payment creation, not parsing
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/payment/i);
      }

      // First call always happens (gets the 402)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("preserves request headers on non-402 pass-through", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("ok", { status: 200 }),
      );

      const client = createTestEvmClient();
      const payFetch = wrapFetchWithPayment(mockFetch as unknown as typeof fetch, client);

      await payFetch("https://example.com/api", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Custom": "test-value",
        },
        body: JSON.stringify({ prompt: "hello" }),
      });

      const calledRequest = mockFetch.mock.calls[0][0] as Request;
      expect(calledRequest.headers.get("Content-Type")).toBe("application/json");
      expect(calledRequest.headers.get("X-Custom")).toBe("test-value");
    });
  });
});
