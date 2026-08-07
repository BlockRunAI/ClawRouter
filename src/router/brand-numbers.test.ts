/**
 * Pins the numbers about ClawRouter that BlockRun publishes but cannot count.
 *
 * blockrun.ai/brand/numbers.json is the artifact every public repo's marketing
 * copy is generated from. Most of it is derived from the model catalog, so it
 * cannot go stale. The `clawrouter.*` block is different: those facts live in
 * THIS repo's code, so over there they are hand-asserted.
 *
 * This test is what makes that safe. Change the scorer or the alias map and the
 * build fails HERE — in the repo that can actually fix it — instead of quietly
 * making a claim in 37 READMEs wrong.
 *
 * When one fails: confirm the change is intended, update brand-numbers.json,
 * and update the same numbers in blockrun's src/app/brand/numbers.json/route.ts.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MODEL_ALIASES } from "../models.js";
import { DEFAULT_ROUTING_CONFIG, classifyByRules } from "./index.js";

const published = JSON.parse(readFileSync("brand-numbers.json", "utf8")) as {
  clawrouter: { dimensions: number; tiers: number; profiles: number; aliases: number };
};

describe("numbers BlockRun publishes about ClawRouter", () => {
  it("scores across the advertised number of dimensions", () => {
    // A prompt with enough substance to take the full scoring path rather than
    // an early return — the count is what matters, not the verdict.
    const result = classifyByRules(
      "Refactor this module to remove the duplicated retry logic and add tests.",
      undefined,
      2_000,
      DEFAULT_ROUTING_CONFIG.scoring,
    );
    expect(result.dimensions).toBeDefined();
    expect(result.dimensions).toHaveLength(published.clawrouter.dimensions);
  });

  it("exposes the advertised number of routing profiles", () => {
    // eco / auto / premium / agentic — one tier table each.
    const profiles = Object.keys(DEFAULT_ROUTING_CONFIG).filter((k) =>
      /^(tiers|[a-z]+Tiers)$/.test(k),
    );
    expect(profiles).toHaveLength(published.clawrouter.profiles);
  });

  it("exposes the advertised number of tiers, identically in every profile", () => {
    const profiles = Object.entries(DEFAULT_ROUTING_CONFIG).filter(([k]) =>
      /^(tiers|[a-z]+Tiers)$/.test(k),
    );
    for (const [name, table] of profiles) {
      // A profile missing a tier silently falls back mid-route, so check each
      // rather than only the default one.
      expect(Object.keys(table as object), name).toHaveLength(published.clawrouter.tiers);
    }
  });

  it("ships the advertised number of model aliases", () => {
    expect(Object.keys(MODEL_ALIASES)).toHaveLength(published.clawrouter.aliases);
  });
});

describe("package.json description", () => {
  // npm renders this on the package page, where no marker can reach it — it is
  // not markdown, so scripts/sync-brand-numbers.mjs cannot rewrite it. Assert
  // instead, so the one un-syncable surface still cannot drift.
  const numbers = JSON.parse(readFileSync("brand-numbers.json", "utf8")) as {
    models: { chatVisible: number; free: number };
    savings: { autoVsBaselinePct: number };
  };
  const { description } = JSON.parse(readFileSync("package.json", "utf8")) as {
    description: string;
  };

  it("quotes the published savings figure", () => {
    expect(description).toContain(`save ${numbers.savings.autoVsBaselinePct}% on inference costs`);
  });

  it("quotes the published model counts", () => {
    expect(description).toContain(
      `${numbers.models.chatVisible} models (${numbers.models.free} free)`,
    );
  });
});

describe("README hero badge", () => {
  // The free-model count is baked into a shields URL and its alt text. A marker
  // cannot go inside an HTML attribute without breaking the tag, so this is the
  // other surface sync-brand-numbers.mjs cannot reach. Assert it instead.
  const readme = readFileSync("README.md", "utf8");
  const free = (
    JSON.parse(readFileSync("brand-numbers.json", "utf8")) as { models: { free: number } }
  ).models.free;

  it("shows the published free-model count", () => {
    expect(readme).toContain(`badge/🆓_${free}_Free_Models-success`);
  });

  it("keeps its alt text in step with the badge", () => {
    expect(readme).toContain(`alt="${free} free models"`);
  });
});

describe("README tier table", () => {
  // The table names one model per tier per profile. It had drifted three cells
  // out of config.ts — eco SIMPLE and both REASONING primaries — and nothing
  // noticed, because a README is prose to everything except a reader.
  //
  // Matched on the model's short name rather than the full id: the table is
  // written for humans and drops the provider prefix.
  const readme = readFileSync("README.md", "utf8");
  // End at the footnote line, not the first "†" — that character also appears
  // inside the table, marking primaries withheld from /v1/models.
  const table = readme.slice(readme.indexOf("| Tier "), readme.indexOf("\n† Withheld"));

  const shortName = (id: string) => id.split("/")[1];
  const profiles = [
    ["ecoTiers", "ECO"],
    ["tiers", "AUTO"],
    ["premiumTiers", "PREMIUM"],
  ] as const;

  for (const [key, label] of profiles) {
    for (const tier of ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"] as const) {
      it(`${label} ${tier} names the configured primary`, () => {
        const table_ = DEFAULT_ROUTING_CONFIG[key] as Record<string, { primary: string }>;
        const primary = shortName(table_[tier].primary);
        const row = table.split("\n").find((l) => l.startsWith(`| ${tier}`));
        expect(row, `no ${tier} row in the README table`).toBeDefined();
        expect(row).toContain(primary);
      });
    }
  }
});

describe("skill frontmatter", () => {
  // A skill's YAML frontmatter is the description an agent reads when deciding
  // whether to load it. A marker there is not inert — it becomes part of the
  // string — so it holds literals, asserted here like package.json is.
  const skill = readFileSync("skills/clawrouter/SKILL.md", "utf8");
  const frontmatter = skill.slice(0, skill.indexOf("\n---", 4));
  const n = JSON.parse(readFileSync("brand-numbers.json", "utf8")) as {
    models: { chatVisible: number };
    savings: { autoVsBaselinePct: number };
  };

  it("quotes the published savings figure", () => {
    expect(frontmatter).toContain(`save ${n.savings.autoVsBaselinePct}% on inference costs`);
  });

  it("quotes the published model count", () => {
    expect(frontmatter).toContain(`${n.models.chatVisible} models`);
  });
});
