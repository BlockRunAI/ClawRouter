/**
 * Layer 1 — Lifecycle integration tests (no API keys required).
 *
 * Verifies proxy health, model listing, stats, and 404 handling.
 * These tests always run regardless of wallet funding.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestProxy, stopTestProxy, getTestProxyUrl } from "./setup.js";

describe("ClawRouter proxy lifecycle", () => {
  beforeAll(async () => {
    await startTestProxy();
  });

  afterAll(async () => {
    await stopTestProxy();
  });

  it("GET /health returns 200 with status ok and valid wallet address", async () => {
    const res = await fetch(`${getTestProxyUrl()}/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; wallet: string };
    expect(body.status).toBe("ok");
    expect(body.wallet).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("GET /health?full=true includes balance info", async () => {
    const res = await fetch(`${getTestProxyUrl()}/health?full=true`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");

    // Full health check includes either balance or balanceError
    const hasBalanceInfo = "balance" in body || "balanceError" in body;
    expect(hasBalanceInfo).toBe(true);
  });

  it("GET /v1/models returns model list with routing profiles", async () => {
    const res = await fetch(`${getTestProxyUrl()}/v1/models`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string; object: string }>;
    };
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);

    const modelIds = body.data.map((m) => m.id);
    // Routing profile models are registered without "blockrun/" prefix in BLOCKRUN_MODELS
    expect(modelIds).toContain("auto");
    expect(modelIds).toContain("eco");
    expect(modelIds).toContain("free");
    expect(modelIds).toContain("premium");
  });

  it("GET /nonexistent returns 404", async () => {
    const res = await fetch(`${getTestProxyUrl()}/nonexistent`);
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Not found");
  });

  it("GET /stats returns stats JSON", async () => {
    const res = await fetch(`${getTestProxyUrl()}/stats`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
  });
});
