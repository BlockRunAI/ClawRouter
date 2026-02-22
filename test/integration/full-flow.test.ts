/**
 * Layer 2 — Full-flow integration tests (requires funded wallet).
 *
 * Gated on BLOCKRUN_WALLET_KEY env var. These tests make real API calls
 * through the proxy to verify end-to-end chat completion flow.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestProxy, stopTestProxy, getTestProxyUrl } from "./setup.js";

describe.skipIf(!process.env.BLOCKRUN_WALLET_KEY)("ClawRouter full-flow (funded wallet)", () => {
  beforeAll(async () => {
    await startTestProxy();
  });

  afterAll(async () => {
    await stopTestProxy();
  });

  it("chat completion with blockrun/free returns valid response", async () => {
    const res = await fetch(`${getTestProxyUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "blockrun/free",
        messages: [{ role: "user", content: "Say hello in one word." }],
        max_tokens: 50,
      }),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices.length).toBeGreaterThan(0);
    expect(body.choices[0].message.content).toBeTruthy();
  }, 60_000);

  it("chat completion with blockrun/auto resolves to a model", async () => {
    const res = await fetch(`${getTestProxyUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "blockrun/auto",
        messages: [{ role: "user", content: "What is 2+2?" }],
        max_tokens: 50,
      }),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      model: string;
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.model).toBeTruthy();
    expect(body.choices.length).toBeGreaterThan(0);
  }, 60_000);

  it("streaming chat completion returns SSE with data and [DONE]", async () => {
    const res = await fetch(`${getTestProxyUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "blockrun/free",
        messages: [{ role: "user", content: "Say hi." }],
        max_tokens: 50,
        stream: true,
      }),
    });

    expect(res.status).toBe(200);

    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("data: ");
    expect(text).toContain("[DONE]");
  }, 60_000);
});
