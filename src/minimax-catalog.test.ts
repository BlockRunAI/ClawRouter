import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createClawCatalog, fallbackCatalog } from "./model-catalog.js";
import {
  BLOCKRUN_MODELS,
  getAgenticModels,
  resolveModelAlias,
  withPinnedModels,
} from "./models.js";
import { buildProxyModelList, estimateAmount, startProxy } from "./proxy.js";
import { DEFAULT_ROUTING_CONFIG } from "./router/index.js";
import { InMemorySpendControlStorage, SpendControl } from "./spend-control.js";

// Public Base/Solana catalog values checked 2026-10-20. Neither lists Flash.
const rows = [
  { id: "minimax/minimax-m3", name: "MiniMax M3", context_window: 1048576, max_output: 65536 },
  { id: "minimax/minimax-m2.7", name: "MiniMax M2.7", context_window: 204800, max_output: 16384 },
].map((row) => ({
  ...row,
  categories: ["chat", "reasoning", "coding"],
  billing_mode: "paid",
  pricing: { input: 0.3, output: 1.2 },
}));
const legacy = ["minimax/minimax-m2.7", "minimax/minimax-m2.5", "minimax-m2.7", "minimax-m2.5"];

function assertDiscovery(view: ReturnType<typeof fallbackCatalog>) {
  const ids = buildProxyModelList(1, view).map((model) => model.id);
  for (const id of legacy) {
    expect(ids).not.toContain(id);
    expect(view.visible.map((model) => model.id)).not.toContain(id);
  }
  expect(ids.filter((id) => id.startsWith("minimax/"))).toEqual(["minimax/minimax-m3"]);
  expect(ids).toContain("minimax");
  expect(ids.some((id) => /minimax.*flash/i.test(id))).toBe(false);
  expect(view.models.find((model) => model.id === "minimax/minimax-m3")).toMatchObject({
    inputPrice: 0.3,
    outputPrice: 1.2,
    contextWindow: 1048576,
    maxOutput: 65536,
    vision: true,
  });
  expect(
    estimateAmount(
      "minimax/minimax-m2.7",
      4000,
      1000,
      new Map(view.models.map((model) => [model.id, model])),
    ),
  ).toBeDefined();
}

describe("MiniMax current discovery and explicit legacy compatibility", () => {
  const savedConfigs = [
    { agents: { defaults: { model: { primary: "blockrun/minimax/minimax-m2.7" } } } },
    {
      agents: {
        defaults: { model: { primary: "blockrun/auto", fallbacks: ["blockrun/minimax-m2.7"] } },
      },
    },
    { agents: { list: [{ id: "saved", model: "blockrun/minimax/minimax-m2.5" }] } },
    { agents: { defaults: { compaction: { model: "blockrun/minimax-m2.7" } } } },
    {
      agents: {
        defaults: { models: { "blockrun/minimax/minimax-m2.7": { params: { temperature: 0.2 } } } },
      },
    },
  ];

  it.each(savedConfigs)(
    "keeps explicit saved selections available without changing config: %j",
    (config) => {
      const before = JSON.stringify(config);
      const definitions = withPinnedModels(fallbackCatalog().visible, config);
      expect(definitions.filter((m) => legacy.includes(m.id))).toHaveLength(1);
      expect(JSON.stringify(config)).toBe(before);
    },
  );

  it("does not treat generated legacy catalogs or empty allowlist entries as pins", () => {
    const visible = fallbackCatalog().visible;
    expect(
      withPinnedModels(visible, {
        models: { providers: { blockrun: { models: [{ id: legacy[0] }] } } },
        agents: { defaults: { models: { [`blockrun/${legacy[0]}`]: {} } } },
      }),
    ).toEqual(visible);
  });

  it.each(["update.sh", "reinstall.sh"])(
    "preserves the same explicit pins in %s allowlist synchronization",
    (script) => {
      const source = readFileSync(new URL(`../scripts/${script}`, import.meta.url), "utf8");
      const code = source.slice(
        source.indexOf("  function preservePins(value)"),
        source.indexOf("  const currentKeys = new Set(TOP_MODELS.map"),
      );
      expect(code).toContain("preservePins(config)");
      for (const config of savedConfigs) {
        const context = { config, TOP_MODELS: fallbackCatalog().visible.map((m) => m.id) };
        runInNewContext(code, context);
        expect(context.TOP_MODELS.filter((id) => legacy.includes(id))).toEqual(
          withPinnedModels(fallbackCatalog().visible, config)
            .filter((m) => legacy.includes(m.id))
            .map((m) => m.id),
        );
      }
    },
  );
  it("advertises only M3 while preserving aliases and cost metadata", () => {
    assertDiscovery(fallbackCatalog());
    expect(resolveModelAlias("minimax")).toBe("minimax/minimax-m3");
    for (const version of ["m2.7", "m2.5"]) {
      expect(resolveModelAlias(`minimax-${version}`)).toBe(`minimax/minimax-${version}`);
      expect(resolveModelAlias(`blockrun/minimax/minimax-${version}`)).toBe(
        `minimax/minimax-${version}`,
      );
    }
    expect(resolveModelAlias("custom/provider-model")).toBe("custom/provider-model");
    expect(resolveModelAlias("minimax/music-2.5+")).toBe("minimax/music-2.5+");
    expect(getAgenticModels().filter((id) => id.startsWith("minimax/"))).toEqual([
      "minimax/minimax-m3",
    ]);
    const defaults = JSON.stringify(DEFAULT_ROUTING_CONFIG).match(/minimax\/minimax-[a-z0-9.]+/g);
    expect(defaults?.length).toBeGreaterThan(0);
    expect(new Set(defaults)).toEqual(new Set(["minimax/minimax-m3"]));
  });

  it.each(["base", "solana"] as const)(
    "does not re-advertise legacy entries on %s refresh",
    async (network) => {
      const client = createClawCatalog({
        network,
        apiBase: "https://catalog.test",
        catalogUrl: "",
        ttlMs: 0,
        fetch: async () =>
          new Response(
            JSON.stringify({
              data: [
                ...rows,
                {
                  id: "minimax/music-2.5+",
                  name: "Music",
                  categories: ["music"],
                  billing_mode: "per_track",
                  pricing: { per_track: 0.15 },
                },
              ],
            }),
          ),
      });
      assertDiscovery(await client.refresh());
      assertDiscovery(await client.refresh());
      expect(
        BLOCKRUN_MODELS.find((model) => model.id === "minimax/minimax-m2.7")?.explicitOnly,
      ).toBe(true);
    },
  );

  it("keeps explicit legacy/custom requests and user routing overrides on the wire", async () => {
    const seen: string[] = [];
    const upstream = createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/v1/models")) {
        res.end(JSON.stringify({ data: rows }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push(body.model);
      expect(req.headers.authorization).toBe("Bearer brk_test_minimax_catalog_only_12345");
      expect(req.headers["payment-signature"]).toBeUndefined();
      res.end(
        JSON.stringify({
          id: "test",
          object: "chat.completion",
          model: body.model,
          choices: [
            { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
    try {
      proxy = await startProxy({
        apiKey: "brk_test_minimax_catalog_only_12345",
        apiBase: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        port: 0,
        spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
        skipBalanceCheck: true,
        cacheConfig: { enabled: false },
        routingConfig: {
          tiers: {
            SIMPLE: { primary: "minimax/minimax-m2.7", fallback: [] },
            MEDIUM: { primary: "minimax/minimax-m2.7", fallback: [] },
            COMPLEX: { primary: "minimax/minimax-m2.7", fallback: [] },
            REASONING: { primary: "minimax/minimax-m2.7", fallback: [] },
          },
        },
      });
      const listing = await (await fetch(`${proxy.baseUrl}/v1/models`)).json();
      expect(listing.data.map((model: { id: string }) => model.id)).not.toContain(
        "minimax/minimax-m2.7",
      );
      for (const model of [
        "minimax",
        "minimax-m2.7",
        "blockrun/minimax/minimax-m2.7",
        "custom/provider-model",
        "auto",
      ]) {
        const reply = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: `hello ${model}` }],
            max_tokens: 16,
          }),
        });
        expect(reply.status).toBe(200);
        await reply.text();
      }
      expect(seen).toEqual([
        "minimax/minimax-m3",
        "minimax/minimax-m2.7",
        "minimax/minimax-m2.7",
        "custom/provider-model",
        "minimax/minimax-m2.7",
      ]);
      expect(proxy.walletAddress).toBe("");
    } finally {
      await proxy?.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
