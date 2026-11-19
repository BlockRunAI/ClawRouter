/**
 * PF-8 (BlockRunAI/blockrun specs/2026-11-16-chat-platform-fee.md): per-token
 * paid chat pays `platform_fee_percent` on top of the list rates a
 * `/v1/models` row publishes. These tests pin how ClawRouter reads it and that
 * every local estimate built from the rates carries it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClawCatalog } from "./model-catalog.js";
import { logUsage } from "./logger.js";
import { platformFeePercentOf, withPlatformFee } from "./platform-fee.js";
import { estimateAmount, startProxy, type ProxyHandle } from "./proxy.js";
import { InMemorySpendControlStorage, SpendControl } from "./spend-control.js";

vi.mock("./logger.js", async (original) => ({
  ...(await original<typeof import("./logger.js")>()),
  logUsage: vi.fn(async () => {}),
}));

const paidRow = (extra: Record<string, unknown> = {}, pricing: Record<string, unknown> = {}) => ({
  id: "test/fee-model",
  name: "Fee model",
  categories: ["chat"],
  billing_mode: "paid",
  pricing: { input: 2, output: 8, ...pricing },
  context_window: 65536,
  max_output: 8192,
  ...extra,
});

describe("platformFeePercentOf", () => {
  it("is 0 when the row publishes no fee (older gateways, enterprise PF-9)", () => {
    expect(platformFeePercentOf(paidRow())).toBe(0);
  });

  it("reads pricing.platform_fee_percent (sol's shape)", () => {
    expect(platformFeePercentOf(paidRow({}, { platform_fee_percent: 5 }))).toBe(5);
  });

  it("falls back to the row's top-level platform_fee_percent", () => {
    expect(platformFeePercentOf(paidRow({ platform_fee_percent: 5 }))).toBe(5);
  });

  it("prefers pricing over the top level when both are present", () => {
    expect(
      platformFeePercentOf(paidRow({ platform_fee_percent: 9 }, { platform_fee_percent: 5 })),
    ).toBe(5);
    // A gateway that publishes 0 inside pricing means 0, not "look elsewhere".
    expect(
      platformFeePercentOf(paidRow({ platform_fee_percent: 9 }, { platform_fee_percent: 0 })),
    ).toBe(0);
  });

  it("ignores malformed values and falls through to the next source, then 0", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5", null, {}]) {
      expect(platformFeePercentOf(paidRow({}, { platform_fee_percent: bad }))).toBe(0);
      expect(
        platformFeePercentOf(paidRow({ platform_fee_percent: 5 }, { platform_fee_percent: bad })),
      ).toBe(5);
    }
  });

  it("is 0 for free, flat and media rows whatever they say", () => {
    for (const billing_mode of ["free", "flat", "per_image", "per_second", "per_token"]) {
      expect(
        platformFeePercentOf(
          paidRow({ billing_mode, platform_fee_percent: 5 }, { platform_fee_percent: 5 }),
        ),
      ).toBe(0);
    }
  });
});

describe("withPlatformFee", () => {
  it("multiplies a token cost by (1 + percent/100)", () => {
    expect(withPlatformFee(0.01, 5)).toBeCloseTo(0.0105, 12);
  });
  it("leaves the cost unchanged when the fee is absent or malformed", () => {
    expect(withPlatformFee(0.01, undefined)).toBe(0.01);
    expect(withPlatformFee(0.01, -5)).toBe(0.01);
    expect(withPlatformFee(0.01, Number.NaN)).toBe(0.01);
  });
});

async function viewFor(rows: unknown[]) {
  const client = createClawCatalog({
    network: "base",
    apiBase: "https://base.test",
    catalogUrl: "",
    ttlMs: 0,
    fetch: async () => new Response(JSON.stringify({ data: rows })),
  });
  const view = await client.refresh();
  return new Map(view.models.map((m) => [m.id, m]));
}

describe("estimateAmount carries the catalog's platform fee", () => {
  // 4000 chars ≈ 1000 input tokens, 1000 output tokens at $2/$8 per 1M:
  // $0.01 token cost, + $0.001 transaction fee, × 1.2 estimation buffer.
  it("adds nothing when the gateway publishes no fee", async () => {
    const models = await viewFor([paidRow()]);
    expect(models.get("test/fee-model")?.platformFeePercent).toBeUndefined();
    expect(estimateAmount("test/fee-model", 4000, 1000, models)).toBe("13200");
  });

  it.each([
    ["nested (sol)", paidRow({}, { platform_fee_percent: 5 })],
    [
      "top-level and nested (base)",
      paidRow({ platform_fee_percent: 5 }, { platform_fee_percent: 5 }),
    ],
    ["top-level only", paidRow({ platform_fee_percent: 5 })],
  ])("applies the fee to the token cost only, not the transaction fee: %s", async (_, row) => {
    const models = await viewFor([row]);
    expect(models.get("test/fee-model")?.platformFeePercent).toBe(5);
    // ($0.01 × 1.05 + $0.001) × 1.2 = $0.0138
    expect(estimateAmount("test/fee-model", 4000, 1000, models)).toBe("13800");
  });

  it("never applies to a flat row's final price", async () => {
    const models = await viewFor([
      {
        ...paidRow({ billing_mode: "flat", platform_fee_percent: 5 }),
        pricing: { flat: 0.01, platform_fee_percent: 5 },
      },
    ]);
    expect(models.get("test/fee-model")?.platformFeePercent).toBeUndefined();
    // ($0.01 + $0.001) × 1.2 = $0.0132
    expect(estimateAmount("test/fee-model", 4000, 1000, models)).toBe("13200");
  });

  it("never applies to a free row", async () => {
    const models = await viewFor([
      {
        ...paidRow({ billing_mode: "free", platform_fee_percent: 0 }),
        pricing: { input: 0, output: 0 },
      },
    ]);
    expect(models.get("test/fee-model")?.platformFeePercent).toBeUndefined();
    // $0 estimate floors at the $0.001 minimum.
    expect(estimateAmount("test/fee-model", 4000, 1000, models)).toBe("1000");
  });

  it("drops a fee the gateway stops publishing", async () => {
    const rows: unknown[][] = [[paidRow({}, { platform_fee_percent: 5 })], [paidRow()]];
    const client = createClawCatalog({
      network: "base",
      apiBase: "https://base.test",
      catalogUrl: "",
      ttlMs: 0,
      fetch: async () => new Response(JSON.stringify({ data: rows.shift() })),
    });
    let view = await client.refresh();
    expect(view.models.find((m) => m.id === "test/fee-model")?.platformFeePercent).toBe(5);
    view = await client.refresh();
    expect(view.models.find((m) => m.id === "test/fee-model")?.platformFeePercent).toBeUndefined();
  });
});

describe("API-key rail usage cost carries the platform fee its gateway publishes", () => {
  let upstream: Server;
  let proxy: ProxyHandle;
  let feePercent: number | undefined;
  let catalogLoads = 0;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      req.resume();
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/v1/models")) {
        catalogLoads++;
        res.end(
          JSON.stringify({
            data: [
              {
                id: "openai/gpt-4o-mini",
                name: "GPT-4o Mini",
                categories: ["chat"],
                billing_mode: "paid",
                platform_fee_percent: feePercent ?? 0,
                pricing: {
                  input: 0.15,
                  output: 0.6,
                  ...(feePercent !== undefined ? { platform_fee_percent: feePercent } : {}),
                },
              },
            ],
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          id: "c-1",
          object: "chat.completion",
          model: "openai/gpt-4o-mini",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
        }),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await proxy?.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  async function loggedCost(fee: number | undefined): Promise<number> {
    feePercent = fee;
    await proxy?.close();
    const loaded = catalogLoads;
    let updated = false;
    proxy = await startProxy({
      spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
      apiKey: "brk_live_platform_fee_test",
      apiBase: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      port: 0,
      allowExistingProxy: false,
      onCatalogUpdated: () => (updated = true),
    });
    // A listing identical to the bundled prices keeps the bundled view and
    // reports no update, so wait for the fetch, then for the update if any.
    await vi.waitFor(() => expect(catalogLoads).toBeGreaterThan(loaded));
    if (fee) await vi.waitFor(() => expect(updated).toBe(true));
    else await new Promise((resolve) => setTimeout(resolve, 50));
    vi.mocked(logUsage).mockClear();
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1000,
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    await vi.waitFor(() => expect(vi.mocked(logUsage)).toHaveBeenCalled());
    return vi.mocked(logUsage).mock.calls[0]![0].cost;
  }

  // (1000 × $0.15 + 1000 × $0.60) / 1M = $0.00075 at list price.
  it("logs list price when the gateway publishes a 0 fee (api.blockrun.ai today, PF-9)", async () => {
    expect(await loggedCost(0)).toBeCloseTo(0.00075, 12);
  });

  it("logs list × (1 + fee/100) when the gateway publishes one", async () => {
    expect(await loggedCost(5)).toBeCloseTo(0.00075 * 1.05, 12);
  });
});
