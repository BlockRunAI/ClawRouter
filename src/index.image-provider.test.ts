import { describe, expect, it } from "vitest";

import { buildImageGenerationProvider } from "./index.js";
import { PARTNER_SERVICES } from "./partners/registry.js";
import { IMAGE_MODEL_ALIASES, IMAGE_MODEL_IDS, IMAGE_MODEL_SIZES } from "./proxy.js";

/**
 * The OpenClaw image UI sends the picked entry from `provider.models` straight
 * through to `POST /v1/images/generations`, and that handler forwards the body
 * to the gateway verbatim — no `resolveModelAlias()` pass. So every id we
 * advertise here has to be a live gateway model id, not an alias and not a
 * retired one, or the user's pick 400s upstream.
 *
 * `IMAGE_PRICING` in proxy.ts is the list that v0.12.227 kept in sync with
 * blockrun's IMAGE_MODELS, so it is the local source of truth for "the gateway
 * can serve this". Anything advertised but unpriced is drift.
 */
describe("image generation provider model list", () => {
  const provider = buildImageGenerationProvider();

  // `models` is optional on ImageGenerationProviderPlugin, so pin that we
  // actually advertise something before asserting on its contents.
  const models = provider.models ?? [];

  it("advertises a model list", () => {
    expect(models.length).toBeGreaterThan(0);
  });

  it("matches the gateway's image catalog exactly", () => {
    // Both directions: an advertised id the gateway cannot serve is a
    // guaranteed 400, and a servable id we never advertise is unreachable
    // from the picker. The 2026-05 sweep left drift in both directions.
    expect([...models].sort()).toEqual([...IMAGE_MODEL_IDS].sort());
  });

  it("does not advertise models delisted upstream", () => {
    // dall-e-3: gateway 400s ("Delisted 2026-05-25: OpenAI removed dall-e-3
    // from the API"). flux-1.1-pro: no gateway entry at all. Both were dropped
    // from IMAGE_PRICING and MODEL_ALIASES in v0.12.227.
    expect(models).not.toContain("openai/dall-e-3");
    expect(models).not.toContain("black-forest/flux-1.1-pro");
  });

  it("advertises the live successors", () => {
    expect(models).toContain("openai/gpt-image-2");
    expect(models).toContain("google/nano-banana-2");
    expect(models).toContain("bytedance/seedream-5-pro");
  });

  it("advertises a default model that is itself advertised", () => {
    expect(models).toContain(provider.defaultModel);
  });

  it("advertises only sizes some gateway model accepts, and all of them", () => {
    // The gateway validates size per-model BEFORE payment and 400s unknown
    // ones (live-probed 2026-08-23), so a size here that no model accepts is
    // a guaranteed failure from the size picker — that is how the orphaned
    // dall-e-3 sizes (1792x1024 / 1024x1792) lingered until v0.12.247.
    const sizes = provider.capabilities?.geometry?.sizes ?? [];
    expect([...sizes].sort()).toEqual([...IMAGE_MODEL_SIZES].sort());
  });
});

describe("/cr-imagegen model aliases", () => {
  it("every alias target is a servable gateway id", () => {
    // An alias pointing at a delisted id is the same guaranteed-400 drift
    // class the picker test guards against — the resolved id is sent to the
    // gateway verbatim.
    for (const [alias, target] of Object.entries(IMAGE_MODEL_ALIASES)) {
      expect(IMAGE_MODEL_IDS, `alias "${alias}" → "${target}"`).toContain(target);
    }
  });

  it("keeps the legacy dall-e-3 shorthands routed to the OpenAI successor", () => {
    expect(IMAGE_MODEL_ALIASES["dall-e-3"]).toBe("openai/gpt-image-2");
    expect(IMAGE_MODEL_ALIASES["dalle"]).toBe("openai/gpt-image-2");
  });
});

describe("partner registry image generation entry", () => {
  const svc = PARTNER_SERVICES.find((s) => s.proxyPath === "/images/generations");

  it("exists", () => {
    expect(svc).toBeDefined();
  });

  it("enumerates every servable model id and no others", () => {
    // This prose description is what agents read to pick a model — it drifted
    // to advertising dall-e-3/flux once already (fixed in PR #254). Pin it.
    for (const id of IMAGE_MODEL_IDS) {
      expect(svc!.description).toContain(id);
    }
    expect(svc!.description).not.toContain("dall-e-3");
    expect(svc!.description).not.toContain("flux");
  });

  it("states the correct model count", () => {
    expect(svc!.shortDescription).toContain(`${IMAGE_MODEL_IDS.length} image models`);
  });
});
