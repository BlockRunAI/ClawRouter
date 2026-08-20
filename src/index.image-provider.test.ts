import { describe, expect, it } from "vitest";

import { buildImageGenerationProvider } from "./index.js";
import { IMAGE_MODEL_IDS } from "./proxy.js";

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

  it("only advertises models the gateway can still serve", () => {
    const unservable = models.filter((id) => !IMAGE_MODEL_IDS.includes(id));
    expect(unservable).toEqual([]);
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
});
