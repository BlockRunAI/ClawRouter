/** Model metadata only. This client has no wallet or payment-signing capability. */
import { createCatalogClient, type CatalogState, type Network } from "@blockrun/model-catalog";
import { createApiKeyFetch } from "./api-key.js";
import {
  BLOCKRUN_MODELS,
  MODEL_ALIASES,
  OPENCLAW_MODELS,
  VISIBLE_OPENCLAW_MODELS,
  toOpenClawModel,
  type BlockRunModel,
} from "./models.js";
import type { ModelDefinitionConfig } from "./types.js";

const POLICY_URL =
  "https://raw.githubusercontent.com/BlockRunAI/model-catalog/main/dist/snapshot.v1.json";
export type ModelCatalogView = {
  models: BlockRunModel[];
  openclaw: ModelDefinitionConfig[];
  visible: ModelDefinitionConfig[];
  freeIds: ReadonlySet<string>;
};
export function fallbackCatalog(): ModelCatalogView {
  return {
    models: BLOCKRUN_MODELS,
    openclaw: OPENCLAW_MODELS,
    visible: VISIBLE_OPENCLAW_MODELS,
    freeIds: new Set(BLOCKRUN_MODELS.filter((m) => m.id.startsWith("free/")).map((m) => m.id)),
  };
}
// ClawRouter's free/ names are product aliases, not gateway model IDs.
function upstreamId(id: string): string {
  if (id === "free/north-mini-code") return "cohere/north-mini-code";
  if (id === "free/laguna-xs-2.1") return "poolside/laguna-xs-2.1";
  return id.startsWith("free/") ? `nvidia/${id.slice(5)}` : id;
}

export function projectClawCatalog(state: CatalogState): ModelCatalogView {
  const models = BLOCKRUN_MODELS.map((m) => ({ ...m }));
  const byUpstream = new Map(models.map((m) => [upstreamId(m.id), m]));
  const additions = new Set<string>();
  const freeIds = new Set(fallbackCatalog().freeIds);
  for (const row of state.models) {
    if (!row.id.includes("/") || row.id.startsWith("blockrun/")) continue;
    if (!row.categories.includes("chat") || row.available === false) continue;
    if (!["paid", "free", "flat"].includes(row.billing_mode)) continue;
    const old = byUpstream.get(row.id);
    // Never turn a product's explicitly free choice into a paid selection.
    if (old?.id.startsWith("free/") && row.billing_mode !== "free") {
      throw new Error("Gateway changed billing of a pinned free model");
    }
    if (!old && Object.hasOwn(MODEL_ALIASES, row.id)) continue;
    const model: BlockRunModel = old ?? {
      id: row.id,
      name: row.name,
      inputPrice: 0,
      outputPrice: 0,
      contextWindow: row.context_window ?? 32768,
      maxOutput: row.max_output ?? 4096,
      // A catalog's "coding" category is not proof of working structured tools.
      // New models are explicit picks, not automatic routing candidates.
      toolCalling: false,
      agentic: false,
      reasoning: row.categories.includes("reasoning"),
      vision: row.categories.includes("vision"),
    };
    if (
      row.billing_mode === "flat" &&
      (typeof row.pricing.flat !== "number" ||
        !Number.isFinite(row.pricing.flat) ||
        row.pricing.flat < 0)
    ) {
      throw new Error("Invalid flat model price");
    }
    model.name = row.name;
    model.inputPrice = row.billing_mode === "paid" ? row.pricing.input : 0;
    model.outputPrice = row.billing_mode === "paid" ? row.pricing.output : 0;
    delete model.promo;
    delete model.flatPrice;
    if (row.billing_mode === "flat") model.flatPrice = row.pricing.flat;
    if (row.context_window) model.contextWindow = row.context_window;
    if (row.max_output) model.maxOutput = row.max_output;
    if (row.billing_mode === "free") freeIds.add(model.id);
    if (!old) {
      models.push(model);
      additions.add(model.id);
    }
  }
  const byId = new Map(models.map((m) => [m.id, m]));
  const openclaw = models.filter((m) => !Object.hasOwn(MODEL_ALIASES, m.id)).map(toOpenClawModel);
  // Existing aliases always resolve to the same product-owned target.
  for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
    const model = byId.get(target);
    if (!alias.includes("/") && model)
      openclaw.push(toOpenClawModel({ ...model, id: alias, name: `${alias} → ${model.name}` }));
  }
  const definitions = new Map(openclaw.map((m) => [m.id, m]));
  const visibleIds = new Set(VISIBLE_OPENCLAW_MODELS.map((m) => m.id));
  // Central policy orders newly discovered chat models; legacy hidden pins stay hidden.
  for (const group of state.groups)
    for (const row of group.models) if (additions.has(row.id)) visibleIds.add(row.id);
  const visible = [...visibleIds].flatMap((id) =>
    definitions.has(id) ? [definitions.get(id)!] : [],
  );
  return { models, openclaw, visible, freeIds };
}

/** Each proxy owns its cache: no account keys, chains or late reads cross instances. */
export function createClawCatalog(options: {
  network: Network;
  apiBase: string;
  apiKey?: string;
  catalogUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  ttlMs?: number;
}) {
  const gatewayUrl = `${options.apiBase.replace(/\/$/, "")}/v1/models?format=json`;
  const fetcher = options.fetch ?? globalThis.fetch;
  const gatewayFetch = options.apiKey
    ? createApiKeyFetch(options.apiKey, fetcher, options.apiBase)
    : fetcher;
  const client = createCatalogClient({
    network: options.network,
    gatewayUrl,
    catalogUrl: options.catalogUrl ?? process.env.BLOCKRUN_MODEL_CATALOG_URL ?? POLICY_URL,
    timeoutMs: options.timeoutMs ?? 4000,
    ttlMs: options.ttlMs ?? 300000,
    fetch: (url, init) =>
      String(url) === gatewayUrl
        ? gatewayFetch(url, { ...init, redirect: "error" })
        : fetcher(url, { ...init, redirect: "error" }),
  });
  let view = fallbackCatalog();
  let inflight: Promise<ModelCatalogView> | undefined;
  return {
    current: () => view,
    refresh(): Promise<ModelCatalogView> {
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const state = await client.refresh();
          if (state.source === "live") view = projectClawCatalog(state);
        } catch {
          /* Keep the previous complete view on malformed data or network failure. */
        }
        return view;
      })().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}
