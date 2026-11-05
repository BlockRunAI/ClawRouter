// Copy into a clean consumer directory after installing both candidate tarballs.
// Fixture keys only; remote HTTP is stubbed and non-loopback sockets are refused.
import assert from "node:assert/strict";
import net from "node:net";
import { generateKeyPairSigner } from "@solana/kit";
import { Credential } from "mppx";
import {
  CreditLedger,
  creditPaidNoCompletion,
  readCredits,
  SpentProofLedger,
  ReplayRejectedError,
  fulfillPaidProof,
  createSolanaMppFetch,
  MppPaidNoCompletionError,
} from "@twzrd1111/clawrouter-mpp";

let networkCalls = 0;
const realFetch = globalThis.fetch.bind(globalThis);
const originalConnect = net.Socket.prototype.connect;
const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const hostFor = (args) => {
  const first = args[0];
  if (Array.isArray(first)) return hostFor(first);
  if (first && typeof first === "object")
    return first.path ? "localhost" : (first.host ?? first.hostname ?? "localhost");
  if (typeof first === "string" && first.startsWith("/")) return "localhost";
  if (typeof first === "number") return typeof args[1] === "string" ? args[1] : "localhost";
  return "unknown";
};
net.Socket.prototype.connect = function (...args) {
  if (!loopback.has(hostFor(args))) {
    networkCalls++;
    throw new Error("non-loopback socket forbidden");
  }
  return originalConnect.apply(this, args);
};
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return loopback.has(url.hostname)
    ? realFetch(input, init)
    : new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
};

const payer = await generateKeyPairSigner();
const payee = await generateKeyPairSigner();
const feePayer = await generateKeyPairSigner();
const request = {
  amount: "750",
  currency: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  recipient: payee.address,
  methodDetails: {
    network: "devnet",
    decimals: 6,
    feePayer: true,
    feePayerKey: feePayer.address,
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    recentBlockhash: "11111111111111111111111111111111",
  },
};
const challengeId = "installed-candidate-fixture";
const header = `Payment id="${challengeId}", realm="fixture", method="solana", intent="charge", request="${Buffer.from(JSON.stringify(request)).toString("base64url")}"`;
let signerCalls = 0;
const signer = {
  ...payer,
  signTransactions: async (...args) => {
    signerCalls++;
    return payer.signTransactions(...args);
  },
};
const credentials = [];
const base = async (input) => {
  const authorization = input.headers.get("authorization");
  if (!authorization)
    return new Response("", { status: 402, headers: { "www-authenticate": header } });
  credentials.push(authorization);
  return new Response("model failed", { status: 502 });
};
const pay = await createSolanaMppFetch({
  signer,
  rpcUrl: "http://127.0.0.1:1",
  network: "devnet",
  fetch: base,
});
const send = () => pay("https://fixture.invalid/completions", { method: "POST", body: "{}" });
const calls = await Promise.allSettled([send(), send()]);
assert(calls.every((r) => r.status === "rejected" && r.reason instanceof MppPaidNoCompletionError));
assert.equal(signerCalls, 1);
assert.equal(credentials.length, 2);
assert.equal(credentials[0], credentials[1]);
assert.equal(Credential.deserialize(credentials[0]).challenge.id, challengeId);
const rows = readCredits();
assert.deepEqual(rows, [{ payer: payer.address, amount: "750", challengeId, reason: "HTTP 502" }]);

const proofs = new SpentProofLedger();
let modelCalls = 0;
const fulfill = () =>
  fulfillPaidProof({
    ledger: proofs,
    networkId: "solana:mainnet-beta",
    txSignature: "verified-fixture-tx",
    challengeId,
    upstream: async () => {
      modelCalls++;
      return "ok";
    },
  });
const fulfilled = await Promise.allSettled([fulfill(), fulfill()]);
assert.equal(fulfilled.filter((r) => r.status === "fulfilled").length, 1);
const rejected = fulfilled.find((r) => r.status === "rejected").reason;
assert(rejected instanceof ReplayRejectedError);
assert.equal(rejected.status, 409);
assert.equal(rejected.code, "proof_replayed");
assert.equal(modelCalls, 1);

const ledger = new CreditLedger();
const error = new MppPaidNoCompletionError("no completion", "fixture-ref", 502);
let creditSignerCalls = 0;
const hooks = {
  sign: async () => {
    creditSignerCalls++;
  },
};
const first = creditPaidNoCompletion(ledger, error, rows[0], hooks);
assert.equal(creditPaidNoCompletion(ledger, error, rows[0], hooks), first);
assert.equal(readCredits(ledger).length, 1);
assert.equal(creditSignerCalls, 0);
assert.equal(networkCalls, 0);
process.env.BLOCKRUN_MODEL_CATALOG_URL = "";
const { startProxy, SpendControl, InMemorySpendControlStorage } =
  await import("@twzrd1111/clawrouter");
const { createMppFetch } = await import("@twzrd1111/clawrouter-mpp");
const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
const streamResults = [];
for (const rail of ["tempo", "solana"]) {
  let attempts = 0;
  let finished = false;
  const memory = async () => {
    attempts++;
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"index":0,"delta":{"content":"packed-"},"finish_reason":null}]}\n\n',
          ),
        );
        setTimeout(() => {
          finished = true;
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"index":0,"delta":{"content":"stream-ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            ),
          );
          controller.close();
        }, 100);
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "payment-receipt": "fixture-receipt" },
    });
  };
  const payFetch =
    rail === "tempo"
      ? createMppFetch(privateKeyToAccount(generatePrivateKey()), memory)
      : await createSolanaMppFetch({
          signer: payer,
          rpcUrl: "http://127.0.0.1:1",
          network: "devnet",
          fetch: memory,
        });
  assert.equal(payFetch.deferStreamingHeaders, true);
  assert.equal(payFetch.supportsNativeStreaming, true);
  const proxy = await startProxy({
    wallet: generatePrivateKey(),
    port: 0,
    allowExistingProxy: false,
    apiBase: "http://127.0.0.1:1",
    skipBalanceCheck: true,
    paymentChain: "base",
    payFetch,
    spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
  });
  try {
    const response = await fetch(proxy.baseUrl + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        stream: true,
        max_tokens: 8,
        messages: [{ role: "user", content: rail }],
      }),
    });
    assert.equal(response.status, 200);
    assert(response.headers.get("content-type").includes("text/event-stream"));
    assert.equal(response.headers.get("payment-receipt"), "fixture-receipt");
    const reader = response.body.getReader();
    let body = "";
    while (!body.includes("packed-")) {
      const next = await reader.read();
      assert.equal(next.done, false);
      body += new TextDecoder().decode(next.value);
    }
    assert.equal(finished, false);
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      body += new TextDecoder().decode(next.value);
    }
    const content = body
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)))
      .flatMap((chunk) => chunk.choices ?? [])
      .map((choice) => choice.delta?.content ?? "")
      .join("");
    assert.equal(content, "packed-stream-ok");
    assert.equal(body.split("data: [DONE]").length - 1, 1);
    assert.equal(attempts, 1);
    streamResults.push(rail);
  } finally {
    await proxy.close();
  }
}
let degradedPaidStops = 0;
for (const [stream, native] of [
  [false, false],
  [true, false],
  [true, true],
]) {
  let attempts = 0;
  const id = `installed-paid-200-${stream}-${native}`;
  const header = `Payment id="${id}", realm="fixture", method="solana", intent="charge", request="${Buffer.from(JSON.stringify(request)).toString("base64url")}"`;
  const base = async (input) => {
    attempts++;
    return input.headers.has("authorization")
      ? new Response(
          native
            ? 'data: {"error":"Provider overloaded"}\n\n'
            : JSON.stringify({ error: { message: "Provider overloaded, service unavailable" } }),
          { headers: { "content-type": native ? "text/event-stream" : "application/json" } },
        )
      : new Response("", { status: 402, headers: { "www-authenticate": header } });
  };
  const spend = new SpendControl({ storage: new InMemorySpendControlStorage() });
  spend.setLimit("daily", 1);
  const paid = await createSolanaMppFetch({
    signer: payer,
    rpcUrl: "http://127.0.0.1:1",
    network: "devnet",
    fetch: base,
    spend,
  });
  const proxy = await startProxy({
    wallet: generatePrivateKey(),
    port: 0,
    allowExistingProxy: false,
    apiBase: "http://127.0.0.1:1",
    skipBalanceCheck: true,
    paymentChain: "base",
    payFetch: paid,
    spendControl: spend,
  });
  try {
    const response = await fetch(proxy.baseUrl + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "blockrun/auto",
        stream,
        max_tokens: 8,
        messages: [{ role: "user", content: id }],
      }),
    });
    assert.equal(response.status, native ? 200 : 502);
    if (native) assert((await response.text()).includes('"type":"payment_settled_no_completion"'));
    else assert.equal((await response.json()).error.type, "payment_settled_no_completion");
    assert.equal(attempts, 2); // probe + paid response; no fallback payment
    assert.deepEqual(
      readCredits().filter((row) => row.payer === payer.address && row.challengeId === id),
      [{ payer: payer.address, amount: "750", challengeId: id, reason: "HTTP 200" }],
    );
    degradedPaidStops++;
  } finally {
    await proxy.close();
  }
}
assert.equal(networkCalls, 0);
console.log(
  JSON.stringify(
    {
      passed: true,
      streamResults,
      degradedPaidStops,
      networkCalls,
      fixtureSignerCalls: signerCalls,
      creditSignerCalls,
      modelCalls,
      creditRows: rows.length,
      proofReplayedStatus: rejected.status,
      challengeIdPreserved: true,
    },
    null,
    2,
  ),
);
