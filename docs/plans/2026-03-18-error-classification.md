# Error Classification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace ClawRouter's binary `isProviderError` with per-category error classification so that 401 auth failures never pollute the 429 rate-limit cooldown map, each provider's error state is isolated, and `/stats` exposes per-provider error breakdowns.

**Architecture:** Add `ErrorCategory` type + `categorizeError()` function in `proxy.ts`. Extend `ModelRequestResult` to carry the category. Replace the flat `rateLimitedModels`-only tracking with a dual-map (rate-limit + overloaded) plus an in-memory `perProviderErrors` counter. The fallback loop switches on category instead of raw status code. `/stats` merges the runtime map into its JSON response.

**Tech Stack:** TypeScript, Node.js HTTP server, existing proxy.ts patterns. Tests use Bun's native test runner (`bun test`).

---

## Task 1: Add `ErrorCategory` type and `categorizeError()` function

**Files:**

- Modify: `src/proxy.ts` (near line 330, before `rateLimitedModels`)

**Step 1: Locate insertion point**

In `src/proxy.ts`, find the comment block at line ~330:

```
/** Track rate-limited models to avoid hitting them again. */
const rateLimitedModels = ...
```

Insert the new code BEFORE this block.

**Step 2: Insert `ErrorCategory` type and `categorizeError()`**

```typescript
/**
 * Semantic error categories from upstream provider responses.
 * Used to distinguish auth failures from rate limits from server errors
 * so each category can be handled independently without cross-contamination.
 */
export type ErrorCategory =
  | "auth_failure" // 401, 403: Wrong key or forbidden — don't retry with same key
  | "quota_exceeded" // 403 with plan/quota body: Plan limit hit
  | "rate_limited" // 429: Actual throttling — 60s cooldown
  | "overloaded" // 529, 503+overload body: Provider capacity — 15s cooldown
  | "server_error" // 5xx general: Transient — fallback immediately
  | "payment_error" // 402: x402 payment or funds issue
  | "config_error"; // 400, 413: Bad request content — skip this model

/**
 * Classify an upstream error response into a semantic category.
 * Returns null if the status+body is not a provider-side issue worth retrying.
 */
export function categorizeError(status: number, body: string): ErrorCategory | null {
  if (status === 401) return "auth_failure";
  if (status === 402) return "payment_error";
  if (status === 403) {
    if (/plan.*limit|quota.*exceeded|subscription|allowance/i.test(body)) return "quota_exceeded";
    return "auth_failure"; // generic 403 = forbidden = likely auth issue
  }
  if (status === 429) return "rate_limited";
  if (status === 529) return "overloaded";
  if (status === 503 && /overload|capacity|too.*many.*request/i.test(body)) return "overloaded";
  if (status >= 500) return "server_error";
  if (status === 400 || status === 413) {
    // Only fallback on content-size or billing patterns; bare 400 = our bug, don't cycle
    if (PROVIDER_ERROR_PATTERNS.some((p) => p.test(body))) return "config_error";
    return null;
  }
  return null;
}
```

**Step 3: Verify it compiles**

```bash
cd /Users/vickyfu/Documents/blockrun-web/ClawRouter && bun run build 2>&1 | tail -5
```

Expected: no TypeScript errors.

**Step 4: Commit**

```bash
git add src/proxy.ts
git commit -m "feat: add ErrorCategory type and categorizeError() function"
```

---

## Task 2: Add `OVERLOAD_COOLDOWN_MS`, `overloadedModels` tracking, and `perProviderErrors` counter

**Files:**

- Modify: `src/proxy.ts` (near line 116 for constant, and after `markRateLimited` for new functions)

**Step 1: Add `OVERLOAD_COOLDOWN_MS` constant**

Near line 116 (next to `RATE_LIMIT_COOLDOWN_MS`), add:

```typescript
const OVERLOAD_COOLDOWN_MS = 15_000; // 15 seconds cooldown for overloaded providers
```

**Step 2: Add `ProviderErrorCounts` type and `perProviderErrors` map**

After `const rateLimitedModels = new Map<string, number>();` (line ~334), add:

```typescript
/** Per-model overload tracking (529/503 capacity errors) — shorter cooldown than rate limits. */
const overloadedModels = new Map<string, number>();

/** Per-model error category counts (in-memory, resets on restart). */
type ProviderErrorCounts = {
  auth_failure: number;
  quota_exceeded: number;
  rate_limited: number;
  overloaded: number;
  server_error: number;
  payment_error: number;
  config_error: number;
};
const perProviderErrors = new Map<string, ProviderErrorCounts>();

/** Record an error category hit for a model. */
function recordProviderError(modelId: string, category: ErrorCategory): void {
  if (!perProviderErrors.has(modelId)) {
    perProviderErrors.set(modelId, {
      auth_failure: 0,
      quota_exceeded: 0,
      rate_limited: 0,
      overloaded: 0,
      server_error: 0,
      payment_error: 0,
      config_error: 0,
    });
  }
  perProviderErrors.get(modelId)![category]++;
}
```

**Step 3: Add `markOverloaded()` and `isOverloaded()` functions**

After the existing `markRateLimited()` function (line ~357), add:

```typescript
/**
 * Mark a model as temporarily overloaded (529/503 capacity).
 * Shorter cooldown than rate limits since capacity restores quickly.
 */
function markOverloaded(modelId: string): void {
  overloadedModels.set(modelId, Date.now());
  console.log(`[ClawRouter] Model ${modelId} overloaded, will deprioritize for 15s`);
}

/** Check if a model is in its overload cooldown period. */
function isOverloaded(modelId: string): boolean {
  const hitTime = overloadedModels.get(modelId);
  if (!hitTime) return false;
  if (Date.now() - hitTime >= OVERLOAD_COOLDOWN_MS) {
    overloadedModels.delete(modelId);
    return false;
  }
  return true;
}
```

**Step 4: Update `prioritizeNonRateLimited` to also exclude overloaded models**

Find the existing `prioritizeNonRateLimited` function (line ~362) and update it:

OLD:

```typescript
function prioritizeNonRateLimited(models: string[]): string[] {
  const available: string[] = [];
  const rateLimited: string[] = [];

  for (const model of models) {
    if (isRateLimited(model)) {
      rateLimited.push(model);
    } else {
      available.push(model);
    }
  }

  return [...available, ...rateLimited];
}
```

NEW:

```typescript
function prioritizeNonRateLimited(models: string[]): string[] {
  const available: string[] = [];
  const degraded: string[] = [];

  for (const model of models) {
    if (isRateLimited(model) || isOverloaded(model)) {
      degraded.push(model);
    } else {
      available.push(model);
    }
  }

  return [...available, ...degraded];
}
```

**Step 5: Build to verify**

```bash
cd /Users/vickyfu/Documents/blockrun-web/ClawRouter && bun run build 2>&1 | tail -5
```

**Step 6: Commit**

```bash
git add src/proxy.ts
git commit -m "feat: add overload tracking and per-provider error counters"
```

---

## Task 3: Thread `errorCategory` through `ModelRequestResult`

**Files:**

- Modify: `src/proxy.ts` (lines ~2077-2205)

**Step 1: Update `ModelRequestResult` type**

Find the type definition (line ~2077):

```typescript
type ModelRequestResult = {
  success: boolean;
  response?: Response;
  errorBody?: string;
  errorStatus?: number;
  isProviderError?: boolean;
};
```

Replace with:

```typescript
type ModelRequestResult = {
  success: boolean;
  response?: Response;
  errorBody?: string;
  errorStatus?: number;
  isProviderError?: boolean;
  errorCategory?: ErrorCategory; // Semantic error classification
};
```

**Step 2: Update `tryModelRequest` to set `errorCategory`**

Find the block in `tryModelRequest` that currently does (line ~2159):

```typescript
const isProviderErr = isProviderError(response.status, errorBody);

return {
  success: false,
  errorBody,
  errorStatus: response.status,
  isProviderError: isProviderErr,
};
```

Replace with:

```typescript
const category = categorizeError(response.status, errorBody);

return {
  success: false,
  errorBody,
  errorStatus: response.status,
  isProviderError: category !== null,
  errorCategory: category ?? undefined,
};
```

Note: This removes the call to the now-redundant `isProviderError()` function. The function itself can stay (it's referenced by degraded-response checks for body patterns).

**Step 3: Build to verify**

```bash
cd /Users/vickyfu/Documents/blockrun-web/ClawRouter && bun run build 2>&1 | tail -5
```

**Step 4: Commit**

```bash
git add src/proxy.ts
git commit -m "feat: thread errorCategory through ModelRequestResult"
```

---

## Task 4: Update fallback loop to act on error category

**Files:**

- Modify: `src/proxy.ts` (lines ~3463-3500)

**Step 1: Find the fallback loop's error handling block**

Find this code (around line 3463):

```typescript
// Track 429 rate limits to deprioritize this model for future requests
if (result.errorStatus === 429) {
  markRateLimited(tryModel);
  // Check for server-side update hint
  try {
    const parsed = JSON.parse(result.errorBody || "{}");
    if (parsed.update_available) {
      // ... update hint logging
    }
  } catch {
    /* ignore parse errors */
  }
}
```

**Step 2: Replace with category-based handling**

Replace the entire block (from the `// Track 429` comment up to but NOT including the `// Payment error` comment) with:

```typescript
// Record error and apply category-specific handling
const errorCat = result.errorCategory;
if (errorCat) {
  recordProviderError(tryModel, errorCat);
}

if (errorCat === "rate_limited") {
  markRateLimited(tryModel);
  // Check for server-side update hint in 429 response
  try {
    const parsed = JSON.parse(result.errorBody || "{}");
    if (parsed.update_available) {
      console.log("");
      console.log(
        `\x1b[33m⬆️  ClawRouter ${parsed.update_available} available (you have ${VERSION})\x1b[0m`,
      );
      console.log(
        `   Run: \x1b[36mcurl -fsSL ${parsed.update_url || "https://blockrun.ai/ClawRouter-update"} | bash\x1b[0m`,
      );
      console.log("");
    }
  } catch {
    /* ignore parse errors */
  }
} else if (errorCat === "overloaded") {
  markOverloaded(tryModel);
} else if (errorCat === "auth_failure" || errorCat === "quota_exceeded") {
  console.log(
    `[ClawRouter] 🔑 ${errorCat === "auth_failure" ? "Auth failure" : "Quota exceeded"} for ${tryModel} — check provider config`,
  );
}
```

**Step 3: Build to verify**

```bash
cd /Users/vickyfu/Documents/blockrun-web/ClawRouter && bun run build 2>&1 | tail -5
```

**Step 4: Commit**

```bash
git add src/proxy.ts
git commit -m "feat: category-based error handling in fallback loop"
```

---

## Task 5: Expose `providerErrors` in `/stats` response

**Files:**

- Modify: `src/proxy.ts` (lines ~1567-1587)

**Step 1: Find the `/stats` GET handler**

Find this code (around line 1567):

```typescript
if (req.url === "/stats" || req.url?.startsWith("/stats?")) {
  try {
    const url = new URL(req.url, "http://localhost");
    const days = parseInt(url.searchParams.get("days") || "7", 10);
    const stats = await getStats(Math.min(days, 30));

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    });
    res.end(JSON.stringify(stats, null, 2));
```

**Step 2: Augment response with runtime error counts**

Replace `res.end(JSON.stringify(stats, null, 2));` with:

```typescript
res.end(
  JSON.stringify(
    {
      ...stats,
      providerErrors: Object.fromEntries(perProviderErrors),
    },
    null,
    2,
  ),
);
```

This adds a `providerErrors` field to the JSON response, e.g.:

```json
{
  "providerErrors": {
    "openai/gpt-4o": {
      "auth_failure": 0,
      "rate_limited": 2,
      "overloaded": 1,
      "server_error": 0,
      "payment_error": 0,
      "config_error": 0,
      "quota_exceeded": 0
    },
    "anthropic/claude-3-7-sonnet": {
      "auth_failure": 1,
      "rate_limited": 0,
      "overloaded": 0,
      "server_error": 3,
      "payment_error": 0,
      "config_error": 0,
      "quota_exceeded": 0
    }
  }
}
```

**Step 3: Build to verify**

```bash
cd /Users/vickyfu/Documents/blockrun-web/ClawRouter && bun run build 2>&1 | tail -5
```

**Step 4: Commit**

```bash
git add src/proxy.ts
git commit -m "feat: expose per-provider error stats in /stats endpoint"
```

---

## Task 6: Write tests for `categorizeError()`

**Files:**

- Create: `src/error-classification.test.ts`

**Step 1: Create test file**

```typescript
import { describe, it, expect } from "bun:test";
import { categorizeError } from "./proxy.js";

describe("categorizeError", () => {
  it("classifies 401 as auth_failure", () => {
    expect(categorizeError(401, "Unauthorized")).toBe("auth_failure");
    expect(categorizeError(401, "api key invalid")).toBe("auth_failure");
    expect(categorizeError(401, "")).toBe("auth_failure");
  });

  it("classifies 403 with quota body as quota_exceeded", () => {
    expect(categorizeError(403, "plan limit reached")).toBe("quota_exceeded");
    expect(categorizeError(403, "quota exceeded for this month")).toBe("quota_exceeded");
    expect(categorizeError(403, "subscription required")).toBe("quota_exceeded");
  });

  it("classifies 403 without quota body as auth_failure", () => {
    expect(categorizeError(403, "Forbidden")).toBe("auth_failure");
    expect(categorizeError(403, "")).toBe("auth_failure");
  });

  it("classifies 402 as payment_error", () => {
    expect(categorizeError(402, "payment required")).toBe("payment_error");
    expect(categorizeError(402, "")).toBe("payment_error");
  });

  it("classifies 429 as rate_limited", () => {
    expect(categorizeError(429, "rate limit exceeded")).toBe("rate_limited");
    expect(categorizeError(429, "")).toBe("rate_limited");
  });

  it("classifies 529 as overloaded", () => {
    expect(categorizeError(529, "")).toBe("overloaded");
    expect(categorizeError(529, "overloaded")).toBe("overloaded");
  });

  it("classifies 503 with overload body as overloaded", () => {
    expect(categorizeError(503, "service overloaded, try again")).toBe("overloaded");
    expect(categorizeError(503, "over capacity")).toBe("overloaded");
    expect(categorizeError(503, "too many requests")).toBe("overloaded");
  });

  it("classifies 503 without overload body as server_error", () => {
    expect(categorizeError(503, "service unavailable")).toBe("server_error");
    expect(categorizeError(503, "")).toBe("server_error");
  });

  it("classifies 5xx as server_error", () => {
    expect(categorizeError(500, "internal server error")).toBe("server_error");
    expect(categorizeError(502, "bad gateway")).toBe("server_error");
    expect(categorizeError(504, "gateway timeout")).toBe("server_error");
  });

  it("classifies 413 with size body as config_error", () => {
    expect(categorizeError(413, "request too large")).toBe("config_error");
    expect(categorizeError(413, "payload too large")).toBe("config_error");
  });

  it("classifies 200 as null (not a provider error)", () => {
    expect(categorizeError(200, "ok")).toBeNull();
  });

  it("classifies bare 400 with no pattern match as null", () => {
    expect(categorizeError(400, "bad request")).toBeNull();
  });

  it("classifies 400 with billing body as config_error", () => {
    expect(categorizeError(400, "billing issue with account")).toBe("config_error");
    expect(categorizeError(400, "insufficient balance")).toBe("config_error");
  });
});
```

**Step 2: Run tests**

```bash
cd /Users/vickyfu/Documents/blockrun-web/ClawRouter && bun test src/error-classification.test.ts
```

Expected: all tests pass.

**Step 3: Commit**

```bash
git add src/error-classification.test.ts
git commit -m "test: add error classification unit tests"
```

---

## Task 7: Version bump and full test run

**Files:**

- Modify: `package.json`

**Step 1: Bump version**

In `package.json`, change `"version": "0.12.57"` to `"version": "0.12.58"`.

Add changelog entry comment in the commit message.

**Step 2: Run full test suite**

```bash
cd /Users/vickyfu/Documents/blockrun-web/ClawRouter && bun test 2>&1 | tail -20
```

Expected: all existing tests still pass (new tests pass from Task 6).

**Step 3: Build final**

```bash
cd /Users/vickyfu/Documents/blockrun-web/ClawRouter && bun run build 2>&1
```

**Step 4: Final commit**

```bash
git add package.json
git commit -m "chore: bump version to 0.12.58 (error classification)"
```

---

## Summary

Total changes: all in `src/proxy.ts` + new `src/error-classification.test.ts` + `package.json`.

Key behavioral changes:

- **401** → `auth_failure` — logged with 🔑, fallback triggered, NOT added to `rateLimitedModels`
- **403** → `quota_exceeded` or `auth_failure` — never contaminates rate-limit cooldown
- **429** → `rate_limited` — existing 60s cooldown, unchanged
- **529/503+overload** → `overloaded` — new 15s cooldown via `overloadedModels` map
- **5xx** → `server_error` — immediate fallback, no cooldown
- `prioritizeNonRateLimited()` updated to deprioritize both rate-limited AND overloaded models
- `/stats` response gains `providerErrors` field with per-model breakdown
- `categorizeError()` is exported for testing
