/**
 * Integration test for Claw Credit payment mode.
 *
 * Verifies the proxy can run without a local wallet key and route payment
 * through claw.credit's /v1/transaction/pay endpoint.
 *
 * Usage:
 *   npx tsx test/clawcredit-mode.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { startProxy } from "../src/proxy.js";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  }
}

async function startMockClawCreditServer() {
  let lastHeaders: Record<string, string> = {};
  let lastPayload: Record<string, unknown> | null = null;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== "/v1/transaction/pay" || req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf-8");
    const body = JSON.parse(raw) as Record<string, unknown>;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[key.toLowerCase()] = value;
    }

    lastHeaders = headers;
    lastPayload = body;

    const merchantResponse = {
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "openai/gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello from mock claw.credit path" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "success",
        tx_hash: "mock-tx-hash",
        chain: "BASE",
        amount_charged: 0.01,
        remaining_balance: 10.0,
        merchant_response: merchantResponse,
        actual_amount_charged: 0.01,
        remaining_balance_usd: 10.0,
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    getLastHeaders: () => lastHeaders,
    getLastPayload: () => lastPayload,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function run(): Promise<void> {
  console.log("\n═══ Claw Credit Mode Test ═══\n");

  const credit = await startMockClawCreditServer();
  const proxy = await startProxy({
    // Intentionally no walletKey: claw.credit mode should not require one.
    paymentMode: "clawcredit",
    clawCredit: {
      baseUrl: `http://127.0.0.1:${credit.port}`,
      apiToken: "claw_test_token",
      chain: "BASE",
      asset: BASE_USDC,
    },
    port: 0,
  });

  try {
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "Say hello" }],
        max_tokens: 32,
      }),
    });

    assert(response.ok, `proxy request succeeded (${response.status})`);
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    assert(content.includes("mock claw.credit path"), "response came from claw.credit merchant_response");

    const headers = credit.getLastHeaders();
    assert(
      headers.authorization === "Bearer claw_test_token",
      "claw.credit call included Authorization header",
    );

    const payload = credit.getLastPayload() as Record<string, unknown> | null;
    assert(payload != null, "claw.credit pay payload captured");
    if (payload) {
      const tx = payload.transaction as Record<string, unknown>;
      const reqBody = payload.request_body as Record<string, unknown>;
      const http = reqBody.http as Record<string, unknown>;

      assert(tx.chain === "BASE", "transaction.chain forwarded");
      assert(tx.asset === BASE_USDC, "transaction.asset forwarded");
      assert(typeof tx.amount === "number" && (tx.amount as number) > 0, "transaction.amount > 0");
      assert(
        typeof tx.recipient === "string" &&
          (tx.recipient as string).includes("/v1/chat/completions"),
        "transaction.recipient points to BlockRun chat endpoint",
      );
      assert(
        http.url === tx.recipient,
        "request_body.http.url matches transaction.recipient",
      );
    }
  } finally {
    await proxy.close();
    await credit.close();
  }

  console.log("\n═══════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════\n");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
