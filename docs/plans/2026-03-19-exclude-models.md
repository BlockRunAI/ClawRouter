# Exclude Models Feature — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users exclude specific models from routing via `/exclude` Telegram command, persisted to disk.

**Architecture:** New `exclude-models.json` file at `~/.openclaw/blockrun/` stores the exclusion list. A `filterByExcludeList()` function in `selector.ts` filters the fallback chain (same safety pattern as existing filters). The `/exclude` command manages the list via add/remove/clear subcommands. The proxy loads the list at startup and re-reads on each request (hot-reload).

**Tech Stack:** TypeScript, Node.js fs, existing ClawRouter command pattern

---

### Task 1: Exclude List Persistence Module

**Files:**

- Create: `src/exclude-models.ts`
- Test: `src/exclude-models.test.ts`

**Step 1: Write the failing test**

```typescript
// src/exclude-models.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  loadExcludeList,
  addExclusion,
  removeExclusion,
  clearExclusions,
} from "./exclude-models.js";

const TEST_DIR = join(tmpdir(), "clawrouter-test-exclude-" + Date.now());
const TEST_FILE = join(TEST_DIR, "exclude-models.json");

describe("exclude-models", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns empty set when file does not exist", () => {
    const list = loadExcludeList(TEST_FILE);
    expect(list.size).toBe(0);
  });

  it("adds a model and persists to disk", () => {
    addExclusion("nvidia/gpt-oss-120b", TEST_FILE);
    const list = loadExcludeList(TEST_FILE);
    expect(list.has("nvidia/gpt-oss-120b")).toBe(true);
  });

  it("removes a model", () => {
    addExclusion("nvidia/gpt-oss-120b", TEST_FILE);
    addExclusion("xai/grok-4-0709", TEST_FILE);
    removeExclusion("nvidia/gpt-oss-120b", TEST_FILE);
    const list = loadExcludeList(TEST_FILE);
    expect(list.has("nvidia/gpt-oss-120b")).toBe(false);
    expect(list.has("xai/grok-4-0709")).toBe(true);
  });

  it("clears all exclusions", () => {
    addExclusion("nvidia/gpt-oss-120b", TEST_FILE);
    addExclusion("xai/grok-4-0709", TEST_FILE);
    clearExclusions(TEST_FILE);
    const list = loadExcludeList(TEST_FILE);
    expect(list.size).toBe(0);
  });

  it("deduplicates entries", () => {
    addExclusion("nvidia/gpt-oss-120b", TEST_FILE);
    addExclusion("nvidia/gpt-oss-120b", TEST_FILE);
    const list = loadExcludeList(TEST_FILE);
    expect(list.size).toBe(1);
  });

  it("resolves aliases before storing", () => {
    // "free" alias → "nvidia/gpt-oss-120b"
    addExclusion("free", TEST_FILE);
    const list = loadExcludeList(TEST_FILE);
    expect(list.has("nvidia/gpt-oss-120b")).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/exclude-models.test.ts`
Expected: FAIL — module `./exclude-models.js` does not exist

**Step 3: Write minimal implementation**

```typescript
// src/exclude-models.ts
/**
 * Exclude Models — persistent user-configurable model exclusion list.
 *
 * Stores excluded model IDs in ~/.openclaw/blockrun/exclude-models.json.
 * Models in this list are filtered out of routing fallback chains.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { resolveModelAlias } from "./models.js";

const DEFAULT_EXCLUDE_FILE = join(homedir(), ".openclaw", "blockrun", "exclude-models.json");

/**
 * Load the exclude list from disk. Returns empty Set if file missing.
 */
export function loadExcludeList(filePath: string = DEFAULT_EXCLUDE_FILE): Set<string> {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr);
    return new Set();
  } catch {
    return new Set();
  }
}

function save(models: Set<string>, filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify([...models].sort(), null, 2) + "\n");
}

/**
 * Add a model to the exclude list. Resolves aliases (e.g. "free" → "nvidia/gpt-oss-120b").
 * Returns the resolved model ID.
 */
export function addExclusion(model: string, filePath: string = DEFAULT_EXCLUDE_FILE): string {
  const resolved = resolveModelAlias(model);
  const list = loadExcludeList(filePath);
  list.add(resolved);
  save(list, filePath);
  return resolved;
}

/**
 * Remove a model from the exclude list. Returns true if it was present.
 */
export function removeExclusion(model: string, filePath: string = DEFAULT_EXCLUDE_FILE): boolean {
  const resolved = resolveModelAlias(model);
  const list = loadExcludeList(filePath);
  const had = list.delete(resolved);
  if (had) save(list, filePath);
  return had;
}

/**
 * Clear all exclusions.
 */
export function clearExclusions(filePath: string = DEFAULT_EXCLUDE_FILE): void {
  save(new Set(), filePath);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/exclude-models.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/exclude-models.ts src/exclude-models.test.ts
git commit -m "feat: add exclude-models persistence module"
```

---

### Task 2: Filter Function in Selector

**Files:**

- Modify: `src/router/selector.ts` — add `filterByExcludeList()`
- Test: `src/router/selector.test.ts` — add tests

**Step 1: Write the failing test**

Add to `src/router/selector.test.ts`:

```typescript
import { filterByExcludeList } from "./selector.js";

describe("filterByExcludeList", () => {
  it("removes excluded models from chain", () => {
    const chain = ["a/model-1", "b/model-2", "c/model-3"];
    const excluded = new Set(["b/model-2"]);
    expect(filterByExcludeList(chain, excluded)).toEqual(["a/model-1", "c/model-3"]);
  });

  it("returns original chain if all models excluded (safety net)", () => {
    const chain = ["a/model-1", "b/model-2"];
    const excluded = new Set(["a/model-1", "b/model-2"]);
    expect(filterByExcludeList(chain, excluded)).toEqual(["a/model-1", "b/model-2"]);
  });

  it("returns original chain for empty exclude set", () => {
    const chain = ["a/model-1", "b/model-2"];
    expect(filterByExcludeList(chain, new Set())).toEqual(["a/model-1", "b/model-2"]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/router/selector.test.ts`
Expected: FAIL — `filterByExcludeList` not exported

**Step 3: Write minimal implementation**

Add to `src/router/selector.ts`:

```typescript
/**
 * Filter a model list to remove user-excluded models.
 * When all models are excluded, returns the full list as a fallback
 * (same safety pattern as filterByToolCalling/filterByVision).
 */
export function filterByExcludeList(models: string[], excludeList: Set<string>): string[] {
  if (excludeList.size === 0) return models;
  const filtered = models.filter((m) => !excludeList.has(m));
  return filtered.length > 0 ? filtered : models;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/router/selector.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/router/selector.ts src/router/selector.test.ts
git commit -m "feat: add filterByExcludeList to router selector"
```

---

### Task 3: Wire Exclude Filter into Proxy Fallback Chain

**Files:**

- Modify: `src/proxy.ts` — add exclude filter step, accept excludeList in ProxyOptions, load at startup

**Step 1: Add `excludeModels` to ProxyOptions**

In `src/proxy.ts` at line ~1174, add to `ProxyOptions`:

```typescript
  /**
   * Set of model IDs to exclude from routing.
   * Excluded models are filtered out of fallback chains.
   * Loaded from ~/.openclaw/blockrun/exclude-models.json
   */
  excludeModels?: Set<string>;
```

**Step 2: Wire filter into fallback chain building**

In `src/proxy.ts` around line 3606 (inside the `if (routingDecision)` block), after the context filter and before the tool-calling filter, add:

```typescript
// Filter out user-excluded models
const excludeFiltered = filterByExcludeList(contextFiltered, options.excludeModels ?? new Set());
const excludeExcluded = contextFiltered.filter((m) => !excludeFiltered.includes(m));
if (excludeExcluded.length > 0) {
  console.log(
    `[ClawRouter] Exclude filter: excluded ${excludeExcluded.join(", ")} (user preference)`,
  );
}
```

Then update the next filter to chain from `excludeFiltered` instead of `contextFiltered`:

```typescript
// Change: filterByToolCalling now takes excludeFiltered instead of contextFiltered
let toolFiltered = filterByToolCalling(excludeFiltered, hasTools, supportsToolCalling);
const toolExcluded = excludeFiltered.filter((m) => !toolFiltered.includes(m));
```

**Step 3: Also filter the FREE_MODEL fallback at line 3674**

Change the free model fallback to respect exclusions:

```typescript
// Ensure free model is the last-resort fallback for non-tool requests — unless user excluded it.
if (!hasTools && !modelsToTry.includes(FREE_MODEL) && !options.excludeModels?.has(FREE_MODEL)) {
  modelsToTry.push(FREE_MODEL);
}
```

**Step 4: Add import for filterByExcludeList**

At the top of `proxy.ts`, add `filterByExcludeList` to the selector import:

```typescript
import {
  selectModel,
  getFallbackChain,
  getFallbackChainFiltered,
  calculateModelCost,
  filterByToolCalling,
  filterByVision,
  filterByExcludeList,
} from "./router/selector.js";
```

**Step 5: Load exclude list at proxy startup**

In `startProxy()` (around line 1426), load the exclude list and pass it through:

```typescript
import { loadExcludeList } from "./exclude-models.js";

// Inside startProxy(), before creating the server:
const excludeModels = options.excludeModels ?? loadExcludeList();
// Pass excludeModels into the options object used by request handlers
```

Note: Re-read from disk on each request for hot-reload (the file is tiny, cost is negligible):

```typescript
// In the request handler, before building fallback chain:
const currentExcludeList = loadExcludeList();
```

**Step 6: Run existing tests**

Run: `npx vitest run src/proxy.*.test.ts`
Expected: PASS (existing tests should still pass)

**Step 7: Commit**

```bash
git add src/proxy.ts
git commit -m "feat: wire excludeModels filter into proxy fallback chain"
```

---

### Task 4: `/exclude` Telegram Command

**Files:**

- Modify: `src/index.ts` — add `createExcludeCommand()` + register it

**Step 1: Create the command function**

Add to `src/index.ts` (after `createStatsCommand`):

```typescript
import {
  loadExcludeList,
  addExclusion,
  removeExclusion,
  clearExclusions,
} from "./exclude-models.js";

async function createExcludeCommand(): Promise<OpenClawPluginCommandDefinition> {
  return {
    name: "exclude",
    description: "Manage excluded models — /exclude add|remove|clear <model>",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: PluginCommandContext) => {
      const args = ctx.args?.trim() || "";
      const parts = args.split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || "";
      const modelArg = parts.slice(1).join(" ").trim();

      // /exclude (no args) — show current list
      if (!subcommand) {
        const list = loadExcludeList();
        if (list.size === 0) {
          return {
            text: "No models excluded.\n\nUsage:\n  /exclude add <model>  — block a model\n  /exclude remove <model> — unblock\n  /exclude clear — remove all",
          };
        }
        const models = [...list]
          .sort()
          .map((m) => `  • ${m}`)
          .join("\n");
        return {
          text: `Excluded models (${list.size}):\n${models}\n\nUse /exclude remove <model> to unblock.`,
        };
      }

      // /exclude add <model>
      if (subcommand === "add") {
        if (!modelArg) {
          return {
            text: "Usage: /exclude add <model>\nExample: /exclude add nvidia/gpt-oss-120b",
            isError: true,
          };
        }
        const resolved = addExclusion(modelArg);
        const list = loadExcludeList();
        return {
          text: `Excluded: ${resolved}\n\nActive exclusions (${list.size}):\n${[...list]
            .sort()
            .map((m) => `  • ${m}`)
            .join("\n")}`,
        };
      }

      // /exclude remove <model>
      if (subcommand === "remove") {
        if (!modelArg) {
          return { text: "Usage: /exclude remove <model>", isError: true };
        }
        const removed = removeExclusion(modelArg);
        if (!removed) {
          return { text: `Model "${modelArg}" was not in the exclude list.` };
        }
        const list = loadExcludeList();
        return {
          text: `Unblocked: ${modelArg}\n\nActive exclusions (${list.size}):\n${
            list.size > 0
              ? [...list]
                  .sort()
                  .map((m) => `  • ${m}`)
                  .join("\n")
              : "  (none)"
          }`,
        };
      }

      // /exclude clear
      if (subcommand === "clear") {
        clearExclusions();
        return { text: "All model exclusions cleared." };
      }

      return {
        text: `Unknown subcommand: ${subcommand}\n\nUsage:\n  /exclude — show list\n  /exclude add <model>\n  /exclude remove <model>\n  /exclude clear`,
        isError: true,
      };
    },
  };
}
```

**Step 2: Register the command**

Add after the `/stats` command registration block (~line 971):

```typescript
// Register /exclude command for model exclusion management
createExcludeCommand()
  .then((excludeCommand) => {
    api.registerCommand(excludeCommand);
  })
  .catch((err) => {
    api.logger.warn(
      `Failed to register /exclude command: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
```

**Step 3: Log active exclusions at startup**

In the startup section (after wallet info logging), add:

```typescript
const startupExclusions = loadExcludeList();
if (startupExclusions.size > 0) {
  api.logger.info(
    `Model exclusions active (${startupExclusions.size}): ${[...startupExclusions].join(", ")}`,
  );
}
```

**Step 4: Run all tests**

Run: `npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: add /exclude command for model exclusion management"
```

---

### Task 5: Integration Test

**Files:**

- Create: `src/exclude-models.integration.test.ts`

**Step 1: Write integration test**

```typescript
// src/exclude-models.integration.test.ts
import { describe, it, expect } from "vitest";
import { filterByExcludeList } from "./router/selector.js";
import { DEFAULT_ROUTING_CONFIG } from "./router/config.js";
import { getFallbackChain } from "./router/selector.js";

describe("excludeModels integration", () => {
  it("filters nvidia/gpt-oss-120b from eco SIMPLE chain", () => {
    const chain = getFallbackChain("SIMPLE", DEFAULT_ROUTING_CONFIG.ecoTiers!);
    const excluded = new Set(["nvidia/gpt-oss-120b"]);
    const filtered = filterByExcludeList(chain, excluded);

    expect(filtered).not.toContain("nvidia/gpt-oss-120b");
    expect(filtered.length).toBeGreaterThan(0); // safety: still has models
  });

  it("excludes multiple models across eco tiers", () => {
    const exclude = new Set(["nvidia/gpt-oss-120b", "xai/grok-4-0709"]);

    for (const tier of ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"] as const) {
      const chain = getFallbackChain(tier, DEFAULT_ROUTING_CONFIG.ecoTiers!);
      const filtered = filterByExcludeList(chain, exclude);
      for (const model of exclude) {
        if (chain.includes(model)) {
          // Only check if the model was in the chain to begin with
          expect(filtered).not.toContain(model);
        }
      }
      expect(filtered.length).toBeGreaterThan(0);
    }
  });

  it("gracefully handles excluding ALL models in a tier", () => {
    const chain = getFallbackChain("SIMPLE", DEFAULT_ROUTING_CONFIG.ecoTiers!);
    const excludeAll = new Set(chain);
    const filtered = filterByExcludeList(chain, excludeAll);
    // Safety net: returns original chain when all excluded
    expect(filtered).toEqual(chain);
  });
});
```

**Step 2: Run integration test**

Run: `npx vitest run src/exclude-models.integration.test.ts`
Expected: PASS

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add src/exclude-models.integration.test.ts
git commit -m "test: add exclude-models integration tests"
```

---

### Summary

| Task | What                                       | Files                                    |
| ---- | ------------------------------------------ | ---------------------------------------- |
| 1    | Persistence module (load/add/remove/clear) | `src/exclude-models.ts`, test            |
| 2    | `filterByExcludeList()` in selector        | `src/router/selector.ts`, test           |
| 3    | Wire into proxy fallback chain             | `src/proxy.ts`                           |
| 4    | `/exclude` Telegram command                | `src/index.ts`                           |
| 5    | Integration tests                          | `src/exclude-models.integration.test.ts` |
