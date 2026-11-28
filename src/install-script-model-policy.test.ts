/**
 * reinstall.sh, update.sh and uninstall.sh run their config edits as inline `node -e` code, so
 * they carry their own copy of the modelPolicy.allow rule in src/openclaw-model-policy.ts. This
 * runs the exact lines between each script's markers against the same inputs as the TypeScript
 * helper and requires the same result, so the copies cannot drift apart.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  removeBlockrunModelPolicyAllow,
  syncBlockrunModelPolicyAllow,
} from "./openclaw-model-policy.js";

function block(script: string, name: string): string {
  const source = readFileSync(new URL(`../scripts/${script}`, import.meta.url), "utf8");
  const start = source.indexOf(`// >>> ${name}`);
  const end = source.indexOf(`// <<< ${name}`);
  expect(start, `${script} is missing its "${name}" block`).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const TOP_MODELS = ["auto", "openai/gpt-6.2-sol", "moonshot/kimi-k3.1-pro"];

/** Allow lists covering every branch of the rule. `undefined` = no modelPolicy at all. */
const CASES: Array<Record<string, unknown> | undefined> = [
  undefined,
  { deny: ["x/y"] },
  { allow: "blockrun/auto" },
  { allow: [] },
  { allow: ["anthropic/claude-x", "blockrun/auto", "blockrun/retired/model-0"], deny: ["a/b"] },
  { allow: ["blockrun/*", "blockrun/retired/model-0"] },
  { allow: ["*"] },
  { allow: ["blockrun/openai/*", 42, " blockrun/auto "] },
  { allow: TOP_MODELS.map((id) => `blockrun/${id}`) },
  { allow: ["blockrun/auto", "blockrun/openai/gpt-6.2-sol"] },
];

function configFor(policy: Record<string, unknown> | undefined) {
  const defaults: Record<string, unknown> = { models: {} };
  if (policy !== undefined) defaults.modelPolicy = structuredClone(policy);
  return { agents: { defaults } };
}

describe("install scripts apply the same modelPolicy.allow rule as the plugin", () => {
  for (const script of ["reinstall.sh", "update.sh"]) {
    it(`${script} syncs like syncBlockrunModelPolicyAllow`, () => {
      const run = new Function(
        "config",
        "TOP_MODELS",
        "currentKeys",
        "console",
        `${block(script, "modelPolicy.allow sync")}\nreturn policySynced;`,
      );
      for (const policy of CASES) {
        const expected = configFor(policy);
        const result = syncBlockrunModelPolicyAllow(
          expected.agents.defaults,
          TOP_MODELS.map((id) => `blockrun/${id}`),
        );

        const actual = configFor(policy);
        const synced = run(actual, TOP_MODELS, new Set(TOP_MODELS.map((id) => `blockrun/${id}`)), {
          log: () => {},
        });

        expect(actual, JSON.stringify(policy)).toEqual(expected);
        expect(synced).toBe(result.added + result.pruned > 0);
      }
    });
  }

  it("uninstall.sh removes like removeBlockrunModelPolicyAllow", () => {
    const run = new Function(
      "config",
      "console",
      `let changed = false;\n${block("uninstall.sh", "modelPolicy.allow removal")}\nreturn changed;`,
    );
    for (const policy of CASES) {
      const expected = configFor(policy);
      const removed = removeBlockrunModelPolicyAllow(expected.agents.defaults);

      const actual = configFor(policy);
      const changed = run(actual, { log: () => {} });

      expect(actual, JSON.stringify(policy)).toEqual(expected);
      expect(changed).toBe(removed > 0);
    }
  });
});
