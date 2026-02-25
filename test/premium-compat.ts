/**
 * Regression tests for premium payment compatibility issues:
 * 1) x402 wrapped payment failures should be treated as provider errors and fallback.
 * 2) Session pinning should not override routing profile switches (premium -> eco).
 *
 * Usage:
 *   bun run test/premium-compat.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { startProxy } from "../src/proxy.js";

type MockState = {
  modelCalls: string[];
  wrappedPaymentFailureModels: Set<string>;
};

async function startMockApi(state: MockState): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    try {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model?: string };
      const model = body.model || "unknown";
      state.modelCalls.push(model);

      if (state.wrappedPaymentFailureModels.has(model)) {
        // Real-world shape observed in logs: 400 with embedded x402 payment failure details.
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              'Payment required: {"error":"x402_payment_failed","merchant_status":402,"merchant_body":"{\\"error\\":\\"Payment Required\\",\\"message\\":\\"This endpoint requires x402 payment\\"}"}',
          }),
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: Date.now(),
          model,
          choices: [{ index: 0, message: { role: "assistant", content: `ok:${model}` } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request body" }));
    }
  });

  const port = 25000 + Math.floor(Math.random() * 1000);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

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

async function run(): Promise<void> {
  console.log("\n═══ Premium Compatibility Tests ═══\n");

  const state: MockState = {
    modelCalls: [],
    wrappedPaymentFailureModels: new Set(),
  };

  const mockApi = await startMockApi(state);
  const proxyPort = 26000 + Math.floor(Math.random() * 1000);
  const proxy = await startProxy({
    walletKey: `0x${"1".repeat(64)}`,
    apiBase: `http://127.0.0.1:${mockApi.port}`,
    port: proxyPort,
    skipBalanceCheck: true,
    sessionConfig: { enabled: true, headerName: "x-session-id" },
  });

  // Test 1: wrapped x402 payment failure must fallback to free model.
  {
    console.log("--- Test 1: wrapped x402 failure triggers fallback ---");
    state.modelCalls.length = 0;
    state.wrappedPaymentFailureModels = new Set(["xai/grok-code-fast-1"]);

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "xai/grok-code-fast-1",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 128,
      }),
    });

    assert(res.ok, `request succeeds via fallback: ${res.status}`);
    assert(
      state.modelCalls.join(",") === "xai/grok-code-fast-1,nvidia/gpt-oss-120b",
      `fallback chain used expected models: ${state.modelCalls.join(", ")}`,
    );
  }

  // Test 2: session pin should not cross routing profiles.
  {
    console.log("--- Test 2: session profile switch re-routes ---");
    state.modelCalls.length = 0;
    state.wrappedPaymentFailureModels = new Set();
    const sessionId = `sess-${Date.now()}`;
    const prompt = "Prove step by step that sqrt(2) is irrational.";

    const premiumRes = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({
        model: "premium",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 256,
      }),
    });
    assert(premiumRes.ok, `premium request ok: ${premiumRes.status}`);

    const ecoRes = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({
        model: "eco",
        // Keep tier intent but alter body to avoid request dedup cache hits.
        messages: [{ role: "user", content: `${prompt} Give a shorter version.` }],
        max_tokens: 256,
      }),
    });
    assert(ecoRes.ok, `eco request ok: ${ecoRes.status}`);

    const firstModel = state.modelCalls[0];
    const secondModel = state.modelCalls[1];
    assert(!!firstModel && !!secondModel, `captured two model calls: ${state.modelCalls.join(", ")}`);
    assert(
      secondModel !== "anthropic/claude-sonnet-4",
      `eco request should not reuse premium pinned model: ${secondModel}`,
    );
  }

  await proxy.close();
  await mockApi.close();

  console.log("\n═══════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════\n");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
