/**
 * BlockRun API Key Auth
 *
 * The second way to pay BlockRun. A wallet signs an x402 micropayment per
 * call; an API key draws on account credit the customer topped up with a
 * credit card at https://user.blockrun.ai. Same catalogue, same model ids,
 * same OpenAI-compatible shape — a different host and a different auth header:
 *
 *   wallet    → https://blockrun.ai/api  |  https://sol.blockrun.ai/api  (x402)
 *   API key   → https://api.blockrun.ai                                  (Bearer brk_…)
 *
 * Resolution order, highest first:
 *   1. BLOCKRUN_API_KEY environment variable
 *   2. BlockRun Core — ~/.blockrun/.api-key, shared with other BlockRun products
 *   3. Legacy ClawRouter location — ~/.openclaw/blockrun/api-key
 *
 * SECURITY NOTE (for the OpenClaw scanner):
 * This module reads the BLOCKRUN_API_KEY environment variable and sends it as
 * a bearer token to api.blockrun.ai. That is INTENTIONAL and REQUIRED: it is
 * the credential that authorises the user's own inference, it goes to exactly
 * one host, and it is never written to logs (see maskApiKey).
 * @openclaw-security env-access=BLOCKRUN_API_KEY purpose=blockrun-api-authentication
 *
 * @see https://user.blockrun.ai/dashboard/keys — where a user mints one
 */

import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { readTextFile } from "./fs-read.js";

/** Legacy/ClawRouter-local key file. */
export const API_KEY_FILE = join(homedir(), ".openclaw", "blockrun", "api-key");
/** Canonical cross-product key file, alongside the Core wallet material. */
export const CORE_API_KEY_FILE = join(homedir(), ".blockrun", ".api-key");

/** Where a user signs up, tops up with a card, and mints keys. */
export const PORTAL_URL = "https://user.blockrun.ai";
export const PORTAL_KEYS_URL = `${PORTAL_URL}/dashboard/keys`;
export const PORTAL_CREDITS_URL = `${PORTAL_URL}/dashboard/credits`;

/**
 * The API-key gateway. Note there is no `/api` path segment: api.blockrun.ai
 * serves `/v1/*` at its root, unlike blockrun.ai which serves it under `/api`.
 * Overridable for staging deploys, same as the wallet gateways.
 */
export const BLOCKRUN_API_KEY_API =
  process["env"].BLOCKRUN_API_BASE_URL?.replace(/\/+$/, "") || "https://api.blockrun.ai";

export type ApiKeySource = "env" | "core" | "saved" | "config";

export type ApiKeyResolution = {
  key: string;
  source: ApiKeySource;
};

/**
 * Is this a well-formed BlockRun key?
 *
 * Deliberately loose on the body and strict on the prefix. The server accepts
 * anything starting with `brk_` and today mints `brk_live_<base62>`; pinning
 * the exact length here would reject a future `brk_test_` or a longer body and
 * lock users out for a format change that is not ours to make. The prefix is
 * what stops a wallet key, an OpenAI key, or a pasted password from being
 * saved as a BlockRun credential and then failing as an opaque 401.
 */
export function isValidApiKey(value: string | undefined | null): value is string {
  if (typeof value !== "string") return false;
  return /^brk_[A-Za-z0-9_-]{8,}$/.test(value.trim());
}

/**
 * Render a key for a log line or a status table: enough to tell two keys
 * apart, never enough to use. The portal labels keys by their first 14
 * characters, so the head matches what a user sees on the dashboard.
 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 18) return `${trimmed.slice(0, 8)}…`;
  return `${trimmed.slice(0, 14)}…${trimmed.slice(-4)}`;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return (await readTextFile(path)).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the configured API key without creating anything.
 *
 * Returns undefined when no key is configured — that is the normal state for a
 * wallet user, not an error. A file that exists but holds something that is not
 * a key is reported (once, to stderr) and skipped rather than sent upstream:
 * a malformed credential is a 401 per request, and an unexplained 401 is the
 * hardest failure mode there is to diagnose.
 */
export async function resolveApiKey(): Promise<ApiKeyResolution | undefined> {
  const envKey = process["env"].BLOCKRUN_API_KEY?.trim();
  if (envKey) {
    if (isValidApiKey(envKey)) return { key: envKey, source: "env" };
    console.warn(
      `[ClawRouter] ⚠ BLOCKRUN_API_KEY is set but does not look like a BlockRun key (expected brk_…) — ignoring.`,
    );
  }

  for (const [path, source] of [
    [CORE_API_KEY_FILE, "core"],
    [API_KEY_FILE, "saved"],
  ] as const) {
    const stored = await readOptional(path);
    if (stored === undefined) continue;
    if (isValidApiKey(stored)) return { key: stored, source };
    console.warn(
      `[ClawRouter] ⚠ ${path} does not contain a BlockRun key (expected brk_…) — ignoring.`,
    );
  }

  return undefined;
}

/**
 * Persist a key to BlockRun Core so every BlockRun product on this machine
 * picks it up. Written 0600 — it is a bearer credential for the user's money.
 */
export async function saveApiKey(key: string): Promise<string> {
  const trimmed = key.trim();
  if (!isValidApiKey(trimmed)) {
    throw new Error(
      `Not a BlockRun API key: expected it to start with "brk_". Mint one at ${PORTAL_KEYS_URL}`,
    );
  }
  await mkdir(join(homedir(), ".blockrun"), { recursive: true });
  await writeFile(CORE_API_KEY_FILE, trimmed + "\n", { mode: 0o600 });
  return CORE_API_KEY_FILE;
}

/**
 * Remove every stored key. Returns the files it actually deleted so the caller
 * can say what changed; an env-var key is reported separately because only the
 * user's shell can unset that one.
 */
export async function clearApiKey(): Promise<{ removed: string[]; envStillSet: boolean }> {
  const removed: string[] = [];
  for (const path of [CORE_API_KEY_FILE, API_KEY_FILE]) {
    if ((await readOptional(path)) === undefined) continue;
    await rm(path, { force: true });
    removed.push(path);
  }
  return { removed, envStillSet: Boolean(process["env"].BLOCKRUN_API_KEY?.trim()) };
}

/**
 * The upstream fetch for API-key mode — the counterpart of the x402 payFetch.
 *
 * Two jobs, and the second is the one that matters. It attaches the bearer
 * token, and it REPLACES whatever `authorization` the local client sent.
 * OpenClaw and the OpenAI SDK both send a placeholder key to the proxy
 * ("blockrun", "sk-noop", whatever the user typed), and those headers are
 * forwarded upstream verbatim by the proxy's header pass-through. Setting
 * rather than defaulting is what stops a placeholder from shadowing the real
 * credential and turning every call into a 401.
 */
export function createApiKeyFetch(
  apiKey: string,
  baseFetch: typeof fetch = fetch,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set("authorization", `Bearer ${apiKey}`);
    // An x402 header on an API-key request is a payment nobody asked for.
    headers.delete("x-payment");
    headers.delete("x-api-key");
    const response = await baseFetch(input, { ...init, headers });
    return response.ok ? response : explainApiKeyFailure(response);
  };
}

/**
 * Turn the three refusals a key can hit into something the person reading an
 * agent transcript can act on.
 *
 * The gateway's own messages are correct but terse ("Invalid API key",
 * "Balance exhausted — add credit to continue"), and they surface inside an
 * agent's tool output where nobody has the dashboard open. Appending the URL
 * that fixes it is the difference between a dead end and a two-click recovery.
 *
 * Rewrites only the human-readable `message`. The status code, the error
 * `type` and `code` are what SDKs branch on, so they pass through untouched —
 * an OpenAI client must still see 402/`insufficient_quota` and back off the
 * same way it always did. Anything that is not JSON, or does not carry an
 * error object, is returned exactly as it arrived.
 */
async function explainApiKeyFailure(response: Response): Promise<Response> {
  const hint = HINTS[response.status];
  if (!hint) return response;
  if (!(response.headers.get("content-type") ?? "").includes("json")) return response;

  let parsed: { error?: { message?: string } };
  try {
    parsed = (await response.clone().json()) as { error?: { message?: string } };
  } catch {
    return response;
  }
  if (!parsed?.error || typeof parsed.error.message !== "string") return response;
  // A 404 for an endpoint the enterprise gateway does not publish is the only
  // one that needs its own wording; a 404 for a bad model id is not ours.
  if (response.status === 404 && !/unsupported endpoint/i.test(parsed.error.message)) {
    return response;
  }

  parsed.error.message = `${parsed.error.message} ${hint}`;
  const headers = new Headers(response.headers);
  headers.delete("content-length"); // the body just changed length
  return new Response(JSON.stringify(parsed), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const HINTS: Record<number, string> = {
  401: `Check BLOCKRUN_API_KEY, or mint a new key at ${PORTAL_KEYS_URL}.`,
  402: `Top up your BlockRun credit at ${PORTAL_CREDITS_URL}.`,
  404:
    `api.blockrun.ai does not serve this endpoint yet — it currently carries chat and text ` +
    `completions. For media and partner APIs, run ClawRouter in wallet mode (unset BLOCKRUN_API_KEY ` +
    `and run "clawrouter logout").`,
};
