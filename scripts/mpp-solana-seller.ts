// SPIKE fixture: a Solana MPP (charge) seller for LOCALNET only, built on @solana/pay-kit's server.
//   RPC_URL=http://127.0.0.1:18899 PORT=4095 npx tsx scripts/mpp-solana-seller.ts
// Loopback only. The operator key is a throwaway generated in-process and never written anywhere;
// the recipient address (public) is printed so the caller can inspect balances. The completion is canned:
// this fixture exists to exercise the PAYMENT rail, not a model.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes, generateKeyPairSigner } from "@solana/kit";
import { createPayKit, usd } from "@solana/pay-kit";

const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:18899";
const port = Number(process.env.PORT ?? "4095");
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(rpcUrl)) {
  throw new Error("RPC_URL must be loopback: this fixture is localnet only");
}

// Fixture-only: on solana-test-validator the blockhash pay-kit hands the client is fresher than the
// `finalized` commitment its server preflights `sendTransaction` at (~13 s behind), so a prompt payment
// fails with "Blockhash not found". Preflight at `processed` for this process's own RPC calls only.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (typeof init?.body === "string" && init.body.includes('"sendTransaction"')) {
    const call = JSON.parse(init.body);
    if (call.method === "sendTransaction" && call.params?.[1]) {
      call.params[1].preflightCommitment = "processed";
      init = { ...init, body: JSON.stringify(call) };
    }
  }
  return realFetch(input, init);
};

// OPERATOR_KEYPAIR (optional): a localnet keypair file, so restarts keep the same funded address.
const operator = process.env.OPERATOR_KEYPAIR
  ? await createKeyPairSignerFromBytes(
      Uint8Array.from(JSON.parse(readFileSync(process.env.OPERATOR_KEYPAIR, "utf8"))),
    )
  : await generateKeyPairSigner();
const pay = await createPayKit({
  network: "localnet",
  accept: ["mpp"],
  stablecoins: ["USDC"],
  operator: { signer: operator, recipient: operator.address },
  rpcUrl,
  pricing: { chat: usd("0.00075") },
});

const chat = pay.fetch(
  "chat",
  () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-solana-spike",
        object: "chat.completion",
        model: "solana-spike/canned",
        choices: [
          { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    ),
);

const server = createServer(async (req, res) => {
  const url = `http://127.0.0.1:${port}${req.url ?? "/"}`;
  if (req.method === "GET" && req.url === "/v1/models") {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ object: "list", data: [{ id: "solana-spike/canned", object: "model" }] }),
    );
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const response = await chat(
      new Request(url, { method: "POST", headers, body: Buffer.concat(chunks) }),
    );
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  res.statusCode = 404;
  res.end();
});
server.listen(port, "127.0.0.1", () => {
  console.log(
    JSON.stringify({ listening: `127.0.0.1:${port}`, recipient: operator.address, rpcUrl }),
  );
});
