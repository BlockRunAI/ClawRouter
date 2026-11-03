// SPIKE proof: ClawRouter proxy paying an MPP (Tempo charge) seller on Moderato testnet.
//   SIGNER_PATH=/path/signer.json SELLER=http://127.0.0.1:4093 npx tsx scripts/mpp-spike.ts
// The payer key is read from the file and never printed. The proxy's own x402 wallet is a throwaway
// key generated in-process and is never used to pay (payFetch replaces the rail).
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startProxy } from "../src/proxy.js";
import { createMppFetch } from "../src/mpp-fetch.js";
import { InMemorySpendControlStorage, SpendControl } from "../src/spend-control.js";

const signerPath = process.env.SIGNER_PATH;
const seller = process.env.SELLER ?? "http://127.0.0.1:4093";
if (!signerPath) throw new Error("SIGNER_PATH required");
const payer = privateKeyToAccount(JSON.parse(readFileSync(signerPath, "utf8")).privateKey);

// Isolated, in-memory spend control (never touches ~/.openclaw). PER_REQUEST_USD caps one payment.
const spend = new SpendControl({ storage: new InMemorySpendControlStorage() });
const perRequest = Number(process.env.PER_REQUEST_USD ?? "0.001");
spend.setLimit("perRequest", perRequest);
if (process.env.DAILY_USD) spend.setLimit("daily", Number(process.env.DAILY_USD));

const proxy = await startProxy({
  spendControl: spend,
  wallet: generatePrivateKey(),
  apiBase: seller,
  payFetch: createMppFetch(payer, fetch, { spend }),
  skipBalanceCheck: true,
  port: 8499,
});
try {
  const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "infer-mpp/twzrd-coder",
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
      { payer: payer.address, status: res.status, content, perRequest, spent: spend.getStatus() },
      null,
      1,
    ),
  );
  process.exitCode = res.status === 200 ? 0 : 1;
} finally {
  await proxy.close();
}
