/**
 * Test: SSE error format when upstream returns unparseable JSON.
 *
 * Verifies that when the upstream API returns a 200 with invalid/unparseable
 * JSON body, the proxy wraps it in {"error": {...}} format instead of sending
 * raw JSON — which causes OpenAI SDKs to throw a generic "Unexpected error".
 *
 * Regression test for: https://github.com/BlockRunAI/ClawRouter/issues/139
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { startProxy } from "../../src/proxy.js";
import type { ProxyHandle } from "../../src/proxy.js";

// Dummy wallet key (valid format, never used for real payments)
const TEST_WALLET_KEY = "0x" + "ab".repeat(32);

let mockUpstream: Server;
let mockUpstreamPort: number;
let proxy: ProxyHandle;

/** What the mock upstream should return on the next request. */
let mockResponse = { status: 200, body: "" };

function startMockUpstream(): Promise<void> {
  return new Promise((resolve) => {
    mockUpstream = createServer((req, res) => {
      // Consume the request body to avoid backpressure issues
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(mockResponse.status, { "Content-Type": "application/json" });
        res.end(mockResponse.body);
      });
    });
    mockUpstream.listen(0, "127.0.0.1", () => {
      const addr = mockUpstream.address() as { port: number };
      mockUpstreamPort = addr.port;
      resolve();
    });
  });
}

describe("SSE error format for unparseable upstream responses", () => {
  beforeAll(async () => {
    await startMockUpstream();

    proxy = await startProxy({
      wallet: TEST_WALLET_KEY,
      apiBase: `http://127.0.0.1:${mockUpstreamPort}/api`,
      port: 0, // OS picks a free port
      skipBalanceCheck: true,
    });
  }, 10_000);

  afterAll(async () => {
    await proxy?.close();
    await new Promise<void>((resolve) => mockUpstream?.close(() => resolve()));
  });

  it("wraps unparseable upstream JSON in {error} format for streaming requests", async () => {
    // Mock upstream returns garbage that isn't valid JSON
    mockResponse = { status: 200, body: "THIS IS NOT JSON {{{" };

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();

    // Should contain [DONE] terminator
    expect(text).toContain("[DONE]");

    // Extract SSE data lines (skip heartbeat comments and [DONE])
    const dataLines = text
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => l.slice(6));

    // At least one data line should be the error
    expect(dataLines.length).toBeGreaterThan(0);

    // The error should be parseable JSON with {"error": {...}} structure
    const lastData = dataLines[dataLines.length - 1];
    const parsed = JSON.parse(lastData) as { error?: { message?: string; type?: string } };
    expect(parsed.error).toBeDefined();
    expect(parsed.error!.type).toBe("proxy_error");
    expect(parsed.error!.message).toContain("Upstream response could not be parsed");
  }, 30_000);

  it("still correctly transforms valid upstream JSON to SSE chunks", async () => {
    // Mock upstream returns a valid OpenAI-format response
    mockResponse = {
      status: 200,
      body: JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello!" },
            finish_reason: "stop",
          },
        ],
      }),
    };

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Valid response test " + Date.now() }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("[DONE]");

    // Extract data chunks
    const dataLines = text
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => l.slice(6));

    // Should have at least one valid SSE chunk with chat.completion.chunk format
    const chunks = dataLines.map((l) => JSON.parse(l) as { object?: string });
    const hasChunk = chunks.some((c) => c.object === "chat.completion.chunk");
    expect(hasChunk).toBe(true);
  }, 30_000);
});
