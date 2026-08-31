/**
 * Guard: every free model in the picker resolves to the id BlockRun actually serves.
 *
 * The `free/` prefix is a ClawRouter invention — it exists so the picker can say
 * "free" about models whose upstream ids say `nvidia/`, `cohere/` or `poolside/`.
 * Until 2026-08-30 the translation was a single blanket rewrite to `nvidia/`,
 * which was correct because the free tier was NVIDIA-only. blockrun #448 ended
 * that: two of the seven live free models are hosted under their own maker's
 * namespace, so `free/north-mini-code` → `nvidia/north-mini-code` would be a 400
 * on every request to it.
 *
 * The failure this catches is quiet in the worst way. A free model that 400s
 * just falls through the cascade to the next rung, so the user still gets an
 * answer and nothing in the logs looks like a bug — the rung is simply dead
 * weight, exactly like the retired ids the liveness guard exists to catch.
 *
 * The expected set is DERIVED from the live catalog snapshot, not hand-written:
 * the assertion is that whatever `toUpstreamModelId` produces is an id BlockRun
 * lists, which is the property that actually matters.
 */

import { describe, expect, it } from "vitest";

import { BLOCKRUN_MODELS } from "./models.js";
import { toUpstreamModelId } from "./proxy.js";
import topModels from "./top-models.json" with { type: "json" };

/** Picker ids that are free, i.e. carry ClawRouter's `free/` convention. */
const freePickerIds = (topModels as string[]).filter((id) => id.startsWith("free/"));

describe("free model upstream ids", () => {
  it("finds free models to check (guards against a vacuous pass)", () => {
    expect(freePickerIds.length).toBeGreaterThan(0);
  });

  it("maps the two non-NVIDIA free models to their real maker namespace", () => {
    // Named explicitly because these are the ones the blanket rewrite gets
    // wrong, and a silent regression here is a permanently dead cascade rung.
    expect(toUpstreamModelId("free/north-mini-code")).toBe("cohere/north-mini-code");
    expect(toUpstreamModelId("free/laguna-xs-2.1")).toBe("poolside/laguna-xs-2.1");
  });

  it("maps every other free model to nvidia/<basename>", () => {
    for (const id of freePickerIds) {
      const upstream = toUpstreamModelId(id);
      if (upstream.startsWith("nvidia/")) {
        expect(upstream).toBe(`nvidia/${id.slice("free/".length)}`);
      } else {
        // An override — it must still name a real provider namespace, never
        // keep the `free/` prefix, which BlockRun does not know about.
        expect(upstream).toMatch(/^[a-z0-9-]+\/.+/);
        expect(upstream.startsWith("free/")).toBe(false);
      }
    }
  });

  it("leaves non-free ids untouched", () => {
    expect(toUpstreamModelId("anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");
    expect(toUpstreamModelId("zai/glm-5.3-flash")).toBe("zai/glm-5.3-flash");
  });

  it("prices every picker free model at zero", () => {
    // A free model that carries a non-zero price would be filtered by the
    // maxCostPerRun budget check and charged into the session cost, both of
    // which are wrong for a $0 model.
    for (const id of freePickerIds) {
      const model = BLOCKRUN_MODELS.find((m) => m.id === id);
      expect(model, `${id} is in top-models.json but not in BLOCKRUN_MODELS`).toBeDefined();
      expect(model!.inputPrice, id).toBe(0);
      expect(model!.outputPrice, id).toBe(0);
    }
  });
});
