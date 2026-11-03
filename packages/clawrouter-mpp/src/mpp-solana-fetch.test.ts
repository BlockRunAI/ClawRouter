import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSigner } from "@solana/kit";
import { createPayKit, usd } from "@solana/pay-kit";
import { createSolanaMppFetch } from "./mpp-solana-fetch.js";
import { InMemorySpendControlStorage, SpendControl, SpendPolicyError } from "@blockrun/clawrouter";

// A real pay-kit server emits real Solana MPP 402s without touching a chain. The payer's RPC points at a
// closed port, so a veto that fails to hold would surface as a connection error, not SpendPolicyError.
const DEAD_RPC = "http://127.0.0.1:1";
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function seller(stablecoin: "USDC" | "PYUSD" = "USDC") {
  const operator = await generateKeyPairSigner();
  const pay = await createPayKit({
    network: "localnet",
    accept: ["mpp"],
    stablecoins: [stablecoin],
    operator: { signer: operator, recipient: operator.address },
    rpcUrl: DEAD_RPC,
    preflight: false,
    pricing: { chat: usd("0.00075") },
  });
  const handler = pay.fetch("chat", () => new Response("paid"));
  const server = createServer(async (req, res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const r = await handler(
      new Request(`http://127.0.0.1${req.url}`, { method: "POST", headers, body: "{}" }),
    );
    res.statusCode = r.status;
    r.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`, operator };
}

const control = (configure: (c: SpendControl) => void) => {
  const c = new SpendControl({ storage: new InMemorySpendControlStorage() });
  configure(c);
  return c;
};
const payer = () => generateKeyPairSigner();
const call = (f: (u: string, i?: RequestInit) => Promise<Response>, url: string) =>
  f(url, { method: "POST", body: "{}" });

describe("Solana MPP spend controls", () => {
  it("refuses over the per-request limit before anything is signed", async () => {
    const s = await seller();
    const spend = control((c) => c.setLimit("perRequest", 0.0005));
    const f = await createSolanaMppFetch({
      signer: await payer(),
      rpcUrl: DEAD_RPC,
      network: "localnet",
      spend,
    });
    await expect(call(f, s.url)).rejects.toBeInstanceOf(SpendPolicyError);
    expect(spend.getStatus().spending.daily).toBe(0);
  });

  it("refuses a mint it cannot price while amount limits are set", async () => {
    const s = await seller("PYUSD");
    const spend = control((c) => c.setLimit("perRequest", 1));
    const f = await createSolanaMppFetch({
      signer: await payer(),
      rpcUrl: DEAD_RPC,
      network: "localnet",
      spend,
    });
    await expect(call(f, s.url)).rejects.toThrow(/cannot price/);
  });

  it("enforces payee lists from the challenge recipient, before signing", async () => {
    const s = await seller();
    const spend = control((c) => c.setPolicy("blockedPayees", [s.operator.address]));
    const f = await createSolanaMppFetch({
      signer: await payer(),
      rpcUrl: DEAD_RPC,
      network: "localnet",
      spend,
    });
    await expect(call(f, s.url)).rejects.toThrow(/Payee is blocked by policy/);
  });

  it("lets an allowlisted payee reach signing (regression: authorize() ran the payee check with no payTo)", async () => {
    const s = await seller();
    const spend = control((c) => c.setPolicy("allowedPayees", [s.operator.address]));
    const f = await createSolanaMppFetch({
      signer: await payer(),
      rpcUrl: DEAD_RPC,
      network: "localnet",
      spend,
    });
    // Past every policy check, then dies at the dead RPC while building the transaction.
    await expect(call(f, s.url)).rejects.not.toBeInstanceOf(SpendPolicyError);
  });

  it("refuses a payee that is not on the allowlist, before signing", async () => {
    const s = await seller();
    const other = (await payer()).address;
    const spend = control((c) => c.setPolicy("allowedPayees", [other]));
    const f = await createSolanaMppFetch({
      signer: await payer(),
      rpcUrl: DEAD_RPC,
      network: "localnet",
      spend,
    });
    await expect(call(f, s.url)).rejects.toThrow(/not in the configured allowlist/);
  });

  it("releases the held budget when the payment fails before a signed credential", async () => {
    const s = await seller();
    const spend = control((c) => c.setLimit("daily", 0.001));
    const f = await createSolanaMppFetch({
      signer: await payer(),
      rpcUrl: DEAD_RPC,
      network: "localnet",
      spend,
    });
    // Passes the policy, then dies at the dead RPC while building the transaction: not a policy error.
    await expect(call(f, s.url)).rejects.not.toBeInstanceOf(SpendPolicyError);
    expect(spend.getStatus().spending.daily).toBe(0);
    // ...and the failed attempt did not eat the window: a second one still gets past the policy.
    await expect(call(f, s.url)).rejects.not.toBeInstanceOf(SpendPolicyError);
  });

  it("marks the fetch as enforcing only when a spend control is supplied", async () => {
    const plain = await createSolanaMppFetch({
      signer: await payer(),
      rpcUrl: DEAD_RPC,
      network: "localnet",
    });
    const guarded = await createSolanaMppFetch({
      signer: await payer(),
      rpcUrl: DEAD_RPC,
      network: "localnet",
      spend: control(() => {}),
    });
    expect(plain.enforcesSpend).toBe(false);
    expect(guarded.enforcesSpend).toBe(true);
  });
});
