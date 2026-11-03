// SPIKE proof: ClawRouter proxy paying a Solana MPP (charge) seller on LOCALNET.
//   SIGNER_PATH=/path/solana-keypair.json SELLER=http://127.0.0.1:4095 RPC_URL=http://127.0.0.1:18899 \
//     PER_REQUEST_USD=0.001 [DAILY_USD=0.01] npx tsx scripts/mpp-solana-spike.ts
// The payer key is read from the file and never printed. The proxy's own x402 wallet is a throwaway key
// generated in-process and is never used to pay (payFetch replaces the rail). Spend control is in-memory
// and never touches ~/.openclaw.
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { generatePrivateKey } from "viem/accounts";
import { startProxy } from "../src/proxy.js";
import { createSolanaMppFetch } from "../src/mpp-solana-fetch.js";
import { InMemorySpendControlStorage, SpendControl } from "../src/spend-control.js";

const signerPath = process.env.SIGNER_PATH;
const seller = process.env.SELLER ?? "http://127.0.0.1:4095";
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:18899";
if (!signerPath) throw new Error("SIGNER_PATH required");
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(rpcUrl))
  throw new Error("localnet only: RPC_URL must be loopback");
const signer = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(signerPath, "utf8"))),
);

const spend = new SpendControl({ storage: new InMemorySpendControlStorage() });
const perRequest = Number(process.env.PER_REQUEST_USD ?? "0.001");
spend.setLimit("perRequest", perRequest);
if (process.env.DAILY_USD) spend.setLimit("daily", Number(process.env.DAILY_USD));

const proxy = await startProxy({
  spendControl: spend,
  wallet: generatePrivateKey(),
  apiBase: seller,
  payFetch: await createSolanaMppFetch({ signer, rpcUrl, network: "localnet", spend }),
  skipBalanceCheck: true,
  port: 8499,
});
try {
  const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "solana-spike/canned",
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
    }),
  });
  const text = await res.text();
  let content: unknown;
  try {
    content = JSON.parse(text).choices?.[0]?.message?.content;
  } catch {
    content = text.slice(0, 200);
  }
  console.log(
    JSON.stringify(
      { payer: signer.address, status: res.status, content, perRequest, spent: spend.getStatus() },
      null,
      1,
    ),
  );
  process.exitCode = res.status === 200 ? 0 : 1;
} finally {
  await proxy.close();
}
