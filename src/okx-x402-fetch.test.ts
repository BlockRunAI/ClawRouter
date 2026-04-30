/**
 * Tests for the OKX onchainos custom payFetch.
 *
 * Verifies that 402 responses are signed via onchainos and replayed with the
 * correct PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1) header.
 */

import { describe, it, expect } from "vitest";
import { createOnchainosPayFetch } from "./okx-x402-fetch.js";
import type { OnchainOsAdapter } from "./onchainos-adapter.js";

function fakeAdapter(
  signResult: {
    signature: string;
    authorization: Record<string, unknown>;
    sessionCert?: string;
  },
  capture?: { lastAccepts?: unknown[] },
): OnchainOsAdapter {
  return {
    async signX402Payment(accepts: unknown[]) {
      if (capture) capture.lastAccepts = accepts;
      return signResult;
    },
  } as unknown as OnchainOsAdapter;
}

describe("createOnchainosPayFetch (v1 / X-PAYMENT)", () => {
  it("signs and replays a v1 402 with X-PAYMENT", async () => {
    const calls: Array<{ url: string; headers: Headers; body?: string }> = [];
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const req = new Request(input, init);
      const body = init?.body
        ? typeof init.body === "string"
          ? init.body
          : new TextDecoder().decode(init.body as ArrayBuffer)
        : undefined;
      calls.push({ url: req.url, headers: new Headers(req.headers), body });
      // First call: return 402 with v1 body shape.
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            x402Version: 1,
            accepts: [
              {
                scheme: "exact",
                network: "base",
                maxAmountRequired: "10000",
                payTo: "0xRecipient",
              },
            ],
          }),
          { status: 402, headers: { "Content-Type": "application/json" } },
        );
      }
      // Replay with payment header: succeed.
      return new Response("ok", { status: 200 });
    };

    const captured: { lastAccepts?: unknown[] } = {};
    const adapter = fakeAdapter(
      {
        signature: "0xfeedface",
        authorization: { from: "0xPayer", to: "0xRecipient" },
      },
      captured,
    );
    const payFetch = createOnchainosPayFetch(baseFetch, adapter);
    const res = await payFetch("https://blockrun.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet" }),
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    // The first call had no payment header.
    expect(calls[0].headers.get("X-PAYMENT")).toBeNull();
    // The replay must carry an X-PAYMENT header.
    const xPayment = calls[1].headers.get("X-PAYMENT");
    expect(xPayment).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(xPayment!, "base64").toString());
    expect(decoded).toMatchObject({
      x402Version: 1,
      scheme: "exact",
      network: "base",
      payload: { signature: "0xfeedface" },
    });
    // The original request body must be preserved.
    expect(calls[1].body).toBe(JSON.stringify({ model: "claude-sonnet" }));
    // We forwarded the entire accepts array to onchainos.
    expect(captured.lastAccepts).toHaveLength(1);
  });
});

describe("createOnchainosPayFetch (v2 / PAYMENT-SIGNATURE)", () => {
  it("signs and replays a v2 402 with PAYMENT-SIGNATURE", async () => {
    const calls: Array<{ headers: Headers }> = [];
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const req = new Request(input, init);
      calls.push({ headers: new Headers(req.headers) });
      if (calls.length === 1) {
        const requirement = {
          x402Version: 2,
          resource: { url: req.url },
          accepted: {
            scheme: "exact",
            network: "base",
            maxAmountRequired: "5000",
          },
        };
        const headerVal = Buffer.from(JSON.stringify(requirement)).toString("base64");
        return new Response(null, {
          status: 402,
          headers: { "PAYMENT-REQUIRED": headerVal },
        });
      }
      return new Response("ok", { status: 200 });
    };

    const adapter = fakeAdapter({
      signature: "0xdeadbeef",
      authorization: { nonce: "1" },
    });
    const payFetch = createOnchainosPayFetch(baseFetch, adapter);
    const res = await payFetch("https://blockrun.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x" }),
    });

    expect(res.status).toBe(200);
    const sigHeader = calls[1].headers.get("PAYMENT-SIGNATURE");
    expect(sigHeader).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(sigHeader!, "base64").toString());
    expect(decoded).toMatchObject({
      x402Version: 2,
      payload: { signature: "0xdeadbeef" },
    });
    expect(decoded.accepted).toMatchObject({ scheme: "exact", network: "base" });
  });

  it("attaches sessionCert to accepted.extra for aggr_deferred scheme", async () => {
    const calls: Array<{ headers: Headers }> = [];
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const req = new Request(input, init);
      calls.push({ headers: new Headers(req.headers) });
      if (calls.length === 1) {
        const requirement = {
          x402Version: 2,
          resource: { url: req.url },
          accepted: { scheme: "aggr_deferred", network: "base" },
        };
        return new Response(null, {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(requirement)).toString("base64"),
          },
        });
      }
      return new Response("ok", { status: 200 });
    };

    const adapter = fakeAdapter({
      signature: "0xabc",
      authorization: { ok: true },
      sessionCert: "cert-123",
    });
    const payFetch = createOnchainosPayFetch(baseFetch, adapter);
    await payFetch("https://blockrun.ai/api/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });

    const decoded = JSON.parse(
      Buffer.from(calls[1].headers.get("PAYMENT-SIGNATURE")!, "base64").toString(),
    );
    expect(decoded.accepted.extra).toMatchObject({ sessionCert: "cert-123" });
  });
});

describe("createOnchainosPayFetch (passthrough)", () => {
  it("returns non-402 responses without calling onchainos", async () => {
    const baseFetch = async () => new Response("hi", { status: 200 });
    const adapter = {
      async signX402Payment() {
        throw new Error("should not be called");
      },
    } as unknown as OnchainOsAdapter;
    const payFetch = createOnchainosPayFetch(baseFetch, adapter);
    const res = await payFetch("https://blockrun.ai/api/v1/models");
    expect(res.status).toBe(200);
  });

  it("throws when 402 has no accepts to satisfy", async () => {
    let calls = 0;
    const baseFetch = async () => {
      calls++;
      return new Response(JSON.stringify({ x402Version: 1 }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      });
    };
    const adapter = fakeAdapter({ signature: "0x", authorization: {} });
    const payFetch = createOnchainosPayFetch(baseFetch, adapter);
    await expect(
      payFetch("https://blockrun.ai/api/v1/chat/completions", { method: "POST", body: "{}" }),
    ).rejects.toThrow(/no payment options/);
    expect(calls).toBe(1);
  });
});
