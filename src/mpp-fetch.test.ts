import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createMppFetch } from "./mpp-fetch.js";

const account = privateKeyToAccount(generatePrivateKey());

describe("createMppFetch", () => {
  it("passes a non-402 response through untouched", async () => {
    const base = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const res = await createMppFetch(account, base)("http://127.0.0.1:1/x");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("does not pay a 402 that carries no payment challenge", async () => {
    const base = vi.fn(
      async () => new Response("nope", { status: 402 }),
    ) as unknown as typeof fetch;
    const res = await createMppFetch(account, base)("http://127.0.0.1:1/x");
    expect(res.status).toBe(402);
    expect(await res.text()).toBe("nope");
    expect(base).toHaveBeenCalledTimes(1); // no retry: nothing was signed
  });

  it("does not touch globalThis.fetch", () => {
    const before = globalThis.fetch;
    createMppFetch(account, vi.fn() as unknown as typeof fetch);
    expect(globalThis.fetch).toBe(before);
  });
});
