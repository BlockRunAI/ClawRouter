/**
 * API-key auth: resolution order, validation, and the upstream fetch.
 *
 * The fetch tests are the ones that matter for money and access: a placeholder
 * `authorization` from a local client must not shadow the real key, and the
 * three refusals a key can hit must arrive with the URL that fixes them while
 * keeping the status and error `code` an SDK branches on.
 *
 * Uses a temp HOME set BEFORE importing api-key.js — the key file paths are
 * computed from homedir() at module load (same pattern as
 * auth.payment-chain-default.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEMP_HOME = mkdtempSync(join(tmpdir(), "clawrouter-api-key-"));
process.env.HOME = TEMP_HOME;
process.env.USERPROFILE = TEMP_HOME;
delete process.env.BLOCKRUN_API_KEY;

const {
  resolveApiKey,
  saveApiKey,
  clearApiKey,
  isValidApiKey,
  maskApiKey,
  createApiKeyFetch,
  API_KEY_FILE,
  CORE_API_KEY_FILE,
} = await import("./api-key.js");

const CORE_DIR = join(TEMP_HOME, ".blockrun");
const LEGACY_DIR = join(TEMP_HOME, ".openclaw", "blockrun");
const KEY_A = "brk_live_" + "a".repeat(48);
const KEY_B = "brk_live_" + "b".repeat(48);
const KEY_ENV = "brk_live_" + "c".repeat(48);

beforeEach(() => {
  if (existsSync(CORE_DIR)) rmSync(CORE_DIR, { recursive: true });
  if (existsSync(LEGACY_DIR)) rmSync(LEGACY_DIR, { recursive: true });
});

afterEach(() => {
  delete process.env.BLOCKRUN_API_KEY;
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

function writeCore(value: string): void {
  mkdirSync(CORE_DIR, { recursive: true });
  writeFileSync(CORE_API_KEY_FILE, value + "\n");
}

function writeLegacy(value: string): void {
  mkdirSync(LEGACY_DIR, { recursive: true });
  writeFileSync(API_KEY_FILE, value + "\n");
}

describe("isValidApiKey", () => {
  it("accepts a live key", () => {
    expect(isValidApiKey(KEY_A)).toBe(true);
  });

  it("accepts a prefix we do not mint yet, so a format change cannot lock users out", () => {
    expect(isValidApiKey("brk_test_abcdefgh")).toBe(true);
  });

  it("rejects a wallet key, an OpenAI key, and empty input", () => {
    expect(isValidApiKey("0x" + "ab".repeat(32))).toBe(false);
    expect(isValidApiKey("sk-proj-abcdefghijklmnop")).toBe(false);
    expect(isValidApiKey("")).toBe(false);
    expect(isValidApiKey(undefined)).toBe(false);
  });

  it("rejects a bare prefix with nothing behind it", () => {
    expect(isValidApiKey("brk_")).toBe(false);
    expect(isValidApiKey("brk_short")).toBe(false);
  });
});

describe("maskApiKey", () => {
  it("keeps the portal's 14-character label and the last four, and nothing else", () => {
    const masked = maskApiKey(KEY_A);
    expect(masked.startsWith("brk_live_aaaaa")).toBe(true);
    expect(masked).not.toContain("a".repeat(20));
    expect(masked.length).toBeLessThan(25);
  });
});

describe("resolveApiKey", () => {
  it("returns undefined when nothing is configured — the normal wallet-user state", async () => {
    await expect(resolveApiKey()).resolves.toBeUndefined();
  });

  it("prefers the environment variable over both files", async () => {
    writeCore(KEY_A);
    writeLegacy(KEY_B);
    process.env.BLOCKRUN_API_KEY = KEY_ENV;
    await expect(resolveApiKey()).resolves.toEqual({ key: KEY_ENV, source: "env" });
  });

  it("prefers BlockRun Core over the legacy ClawRouter file", async () => {
    writeCore(KEY_A);
    writeLegacy(KEY_B);
    await expect(resolveApiKey()).resolves.toEqual({ key: KEY_A, source: "core" });
  });

  it("falls back to the legacy file", async () => {
    writeLegacy(KEY_B);
    await expect(resolveApiKey()).resolves.toEqual({ key: KEY_B, source: "saved" });
  });

  it("skips a malformed file rather than sending garbage upstream as a 401", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeCore("not-a-key");
    writeLegacy(KEY_B);
    await expect(resolveApiKey()).resolves.toEqual({ key: KEY_B, source: "saved" });
  });

  it("skips a malformed environment variable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.BLOCKRUN_API_KEY = "0x" + "ab".repeat(32);
    writeCore(KEY_A);
    await expect(resolveApiKey()).resolves.toEqual({ key: KEY_A, source: "core" });
  });
});

describe("saveApiKey / clearApiKey", () => {
  it("writes to BlockRun Core so other BlockRun products see the same key", async () => {
    const path = await saveApiKey(`  ${KEY_A}  `);
    expect(path).toBe(CORE_API_KEY_FILE);
    expect(readFileSync(CORE_API_KEY_FILE, "utf8").trim()).toBe(KEY_A);
    await expect(resolveApiKey()).resolves.toEqual({ key: KEY_A, source: "core" });
  });

  it("refuses a key that is not a BlockRun key", async () => {
    await expect(saveApiKey("sk-proj-nope")).rejects.toThrow(/brk_/);
  });

  it("removes both files and reports an env var it cannot unset", async () => {
    writeCore(KEY_A);
    writeLegacy(KEY_B);
    process.env.BLOCKRUN_API_KEY = KEY_ENV;

    const { removed, envStillSet } = await clearApiKey();
    expect(removed).toEqual([CORE_API_KEY_FILE, API_KEY_FILE]);
    expect(envStillSet).toBe(true);
    expect(existsSync(CORE_API_KEY_FILE)).toBe(false);
    expect(existsSync(API_KEY_FILE)).toBe(false);
  });

  it("is a no-op when there is nothing stored", async () => {
    await expect(clearApiKey()).resolves.toEqual({ removed: [], envStillSet: false });
  });
});

describe("createApiKeyFetch", () => {
  const ok = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("sends the key as a bearer token", async () => {
    const base = vi.fn(async () => ok());
    await createApiKeyFetch(KEY_A, base as unknown as typeof fetch)("https://api.blockrun.ai/v1/x");
    const headers = (base.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Headers;
    expect(headers.get("authorization")).toBe(`Bearer ${KEY_A}`);
  });

  it("REPLACES a placeholder authorization the local client sent", async () => {
    // OpenClaw and the OpenAI SDK both send some key to the proxy; the proxy
    // forwards request headers verbatim. Defaulting instead of overwriting here
    // would 401 every call on a machine that works fine.
    const base = vi.fn(async () => ok());
    await createApiKeyFetch(KEY_A, base as unknown as typeof fetch)(
      "https://api.blockrun.ai/v1/x",
      {
        headers: { authorization: "Bearer sk-placeholder", "content-type": "application/json" },
      },
    );
    const headers = (base.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Headers;
    expect(headers.get("authorization")).toBe(`Bearer ${KEY_A}`);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("strips x-payment and x-api-key so no stray credential rides along", async () => {
    const base = vi.fn(async () => ok());
    await createApiKeyFetch(KEY_A, base as unknown as typeof fetch)(
      "https://api.blockrun.ai/v1/x",
      {
        headers: { "x-payment": "eyJ...", "x-api-key": "sk-placeholder" },
      },
    );
    const headers = (base.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Headers;
    expect(headers.get("x-payment")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
  });

  it("passes a successful response through untouched", async () => {
    const response = ok();
    const wrapped = await createApiKeyFetch(
      KEY_A,
      (async () => response) as unknown as typeof fetch,
    )("https://api.blockrun.ai/v1/x");
    expect(wrapped).toBe(response);
  });

  it("appends the top-up URL to a 402 while preserving status and code", async () => {
    const refusal = () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Balance exhausted — add credit to continue",
            type: "insufficient_quota",
            code: "BALANCE_EXHAUSTED",
          },
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      );
    const wrapped = await createApiKeyFetch(KEY_A, (async () =>
      refusal()) as unknown as typeof fetch)("https://api.blockrun.ai/v1/chat/completions");

    expect(wrapped.status).toBe(402);
    const body = (await wrapped.json()) as { error: { message: string; code: string } };
    expect(body.error.message).toContain("Balance exhausted");
    expect(body.error.message).toContain("user.blockrun.ai/dashboard/credits");
    expect(body.error.code).toBe("BALANCE_EXHAUSTED");
  });

  it("points a 401 at the key page", async () => {
    const wrapped = await createApiKeyFetch(
      KEY_A,
      (async () =>
        new Response(
          JSON.stringify({ error: { message: "Invalid API key", type: "authentication_error" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    )("https://api.blockrun.ai/v1/models");

    expect(wrapped.status).toBe(401);
    const body = (await wrapped.json()) as { error: { message: string } };
    expect(body.error.message).toContain("user.blockrun.ai/dashboard/keys");
  });

  it("explains a 404 for an endpoint the API-key gateway does not carry", async () => {
    const wrapped = await createApiKeyFetch(
      KEY_A,
      (async () =>
        new Response(
          JSON.stringify({
            error: { message: "Unsupported endpoint: /v1/videos/generations" },
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    )("https://api.blockrun.ai/v1/videos/generations");

    const body = (await wrapped.json()) as { error: { message: string } };
    expect(body.error.message).toContain("wallet mode");
  });

  it("leaves an ordinary 404 alone — a bad model id is not our error to rewrite", async () => {
    const wrapped = await createApiKeyFetch(
      KEY_A,
      (async () =>
        new Response(JSON.stringify({ error: { message: "Unknown model: nope/nope" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    )("https://api.blockrun.ai/v1/chat/completions");

    const body = (await wrapped.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Unknown model: nope/nope");
  });

  it("leaves a non-JSON error body alone", async () => {
    const html = new Response("<html>502</html>", {
      status: 402,
      headers: { "content-type": "text/html" },
    });
    const wrapped = await createApiKeyFetch(
      KEY_A,
      (async () => html) as unknown as typeof fetch,
    )("https://api.blockrun.ai/v1/chat/completions");
    expect(wrapped).toBe(html);
  });
});
