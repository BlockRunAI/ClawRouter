import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createClawCatalog } from "./model-catalog.js";
import { BLOCKRUN_MODELS, MODEL_ALIASES } from "./models.js";
import { startProxy, estimateAmount } from "./proxy.js";
import { InMemorySpendControlStorage, SpendControl } from "./spend-control.js";

const snapshot = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve("@blockrun/model-catalog/snapshot"), "utf8"),
);
const row = (id = "test/future", input = 2) => ({
  id,
  name: "Future chat model",
  categories: ["chat"],
  billing_mode: "paid",
  pricing: { input, output: 8 },
  context_window: 65536,
  max_output: 8192,
});
const json = (body: unknown) => new Response(JSON.stringify(body));

describe("shared catalog adapter", () => {
  it("adds, reprices and removes future models without changing product aliases or auto candidates", async () => {
    let rows = [row()];
    const aliases = { ...MODEL_ALIASES };
    const client = createClawCatalog({
      network: "base",
      apiBase: "https://base.test",
      catalogUrl: "",
      ttlMs: 0,
      fetch: async () => json({ data: rows }),
    });
    expect(client.current().models).toBe(BLOCKRUN_MODELS);
    let view = await client.refresh();
    expect(view.visible.find((m) => m.id === "test/future")?.cost.input).toBe(2);
    expect(view.models.find((m) => m.id === "test/future")?.toolCalling).toBe(false);
    expect(BLOCKRUN_MODELS.some((m) => m.id === "test/future")).toBe(false);
    expect(
      estimateAmount("test/future", 4000, 1000, new Map(view.models.map((m) => [m.id, m]))),
    ).toBe("13200");
    rows = [row("test/future", 4)];
    view = await client.refresh();
    expect(view.visible.find((m) => m.id === "test/future")?.cost.input).toBe(4);
    rows = [row("test/replacement")];
    view = await client.refresh();
    expect(view.models.some((m) => m.id === "test/future")).toBe(false);
    expect(MODEL_ALIASES).toEqual(aliases);
  });

  it("isolates accounts/networks and never sends a key or payment headers to policy", async () => {
    const requests: { url: string; auth: string | null; redirect?: RequestRedirect }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input),
        auth = new Headers(init?.headers).get("authorization");
      requests.push({ url, auth, redirect: init?.redirect });
      if (url === "https://policy.test/catalog") return json(snapshot);
      expect(new Headers(init?.headers).has("payment-signature")).toBe(false);
      return json({ data: [row(auth?.endsWith("B") ? "test/account-b" : "test/account-a")] });
    };
    const a = createClawCatalog({
      network: "base",
      apiBase: "https://api.test",
      apiKey: "test-key-A",
      catalogUrl: "https://policy.test/catalog",
      fetch: fetcher,
    });
    const b = createClawCatalog({
      network: "solana",
      apiBase: "https://api.test",
      apiKey: "test-key-B",
      catalogUrl: "https://policy.test/catalog",
      fetch: fetcher,
    });
    await Promise.all([a.refresh(), b.refresh()]);
    expect(a.current().models.some((m) => m.id === "test/account-b")).toBe(false);
    expect(b.current().models.some((m) => m.id === "test/account-a")).toBe(false);
    expect(
      requests.filter((r) => r.url.includes("policy.test")).every((r) => r.auth === null),
    ).toBe(true);
    expect(requests.every((r) => r.redirect === "error")).toBe(true);
  });

  it("keeps last good data on bad gateway rows and refreshes gateway data despite malformed policy", async () => {
    let brokenPolicy = false,
      brokenGateway = false;
    const client = createClawCatalog({
      network: "solana",
      apiBase: "https://sol.test",
      catalogUrl: "https://policy.test/catalog",
      ttlMs: 0,
      fetch: async (url) => {
        if (String(url).includes("policy.test")) {
          const next = structuredClone(snapshot);
          if (brokenPolicy) delete next.picker_policy.views.default_chat.shortcuts;
          return json(next);
        }
        return json({
          data: brokenGateway
            ? [row("test/future", -1)]
            : [row("test/future", brokenPolicy ? 4 : 2)],
        });
      },
    });
    await client.refresh();
    brokenPolicy = true;
    expect((await client.refresh()).visible.find((m) => m.id === "test/future")?.cost.input).toBe(
      4,
    );
    brokenGateway = true;
    expect((await client.refresh()).visible.find((m) => m.id === "test/future")?.cost.input).toBe(
      4,
    );
  });

  it("rejects a paid reclassification of an explicitly free model", async () => {
    const client = createClawCatalog({
      network: "base",
      apiBase: "https://base.test",
      catalogUrl: "",
      fetch: async () => json({ data: [row("nvidia/nemotron-3.5-lightning", 100)] }),
    });
    const before = client.current();
    expect(await client.refresh()).toBe(before);
    expect(before.models.find((m) => m.id === MODEL_ALIASES.free)?.inputPrice).toBe(0);
  });

  it("uses live estimates for known models while preserving their tool/vision constraints", async () => {
    const old = BLOCKRUN_MODELS.find((m) => m.id === "openai/gpt-5.4-mini")!;
    const client = createClawCatalog({
      network: "base",
      apiBase: "https://base.test",
      catalogUrl: "",
      fetch: async () =>
        json({
          data: [
            row(old.id, 3),
            { ...row("test/free"), billing_mode: "free", pricing: { input: 0, output: 0 } },
            { ...row("test/image"), categories: ["image"] },
          ],
        }),
    });
    const view = await client.refresh();
    expect(view.models.find((m) => m.id === old.id)).toMatchObject({
      inputPrice: 3,
      toolCalling: old.toolCalling,
      vision: old.vision,
    });
    expect(old.inputPrice).not.toBe(3);
    expect(view.models.some((m) => m.id === "test/image")).toBe(false);
    expect(view.freeIds.has("test/free")).toBe(true);
  });

  it("serves a newly discovered model through the real API-key proxy without a wallet or signing", async () => {
    const seen: { model: string; auth?: string; payment?: string }[] = [];
    const upstream = createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/v1/models")) {
        res.end(JSON.stringify({ data: [row()] }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push({
        model: body.model,
        auth: req.headers.authorization,
        payment: req.headers["payment-signature"] as string | undefined,
      });
      res.end(
        JSON.stringify({
          id: "test",
          object: "chat.completion",
          model: body.model,
          choices: [
            { index: 0, message: { role: "assistant", content: "CORE_OK" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const key = "brk_test_catalog_integration_only_12345";
    let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
    try {
      proxy = await startProxy({
        spendControl: new SpendControl({ storage: new InMemorySpendControlStorage() }),
        apiKey: key,
        apiBase: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        port: 0,
        skipBalanceCheck: true,
        cacheConfig: { enabled: false },
        maxCostPerRunUsd: 0.05,
        maxCostPerRunMode: "strict",
      });
      await expect
        .poll(() => proxy!.getCatalogModels!().some((m) => m.id === "test/future"))
        .toBe(true);
      const models = await (await fetch(`${proxy.baseUrl}/v1/models`)).json();
      expect(models.data.find((m: { id: string }) => m.id === "test/future")).toMatchObject({
        input_price: 2,
        max_output: 8192,
      });
      const blocked = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": "core-cap" },
        body: JSON.stringify({
          model: "test/future",
          messages: [{ role: "user", content: "budget probe" }],
          max_tokens: 8192,
        }),
      });
      expect(blocked.status).toBe(429);
      expect(seen).toEqual([]);
      const reply = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test/future",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 16,
        }),
      });
      expect(reply.status).toBe(200);
      expect((await reply.json()).choices[0].message.content).toBe("CORE_OK");
      expect(seen).toEqual([{ model: "test/future", auth: `Bearer ${key}`, payment: undefined }]);
      expect(proxy.walletAddress).toBe("");
    } finally {
      await proxy?.close();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });
});
