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
    return (await readTextFile(path)).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      "Cannot read the configured API key file. Fix its permissions before selecting a payment method.",
      { cause: error },
    );
  }
}

/**
 * Resolve the configured API key without creating anything.
 *
 * Returns undefined when no key is configured — that is the normal state for a
 * wallet user, not an error. A configured but invalid or unreadable key is an
 * error: it must never silently select another account or a wallet.
 */
export async function resolveApiKey(): Promise<ApiKeyResolution | undefined> {
  const envKey = process["env"].BLOCKRUN_API_KEY?.trim();
  if (envKey !== undefined) {
    if (isValidApiKey(envKey)) return { key: envKey, source: "env" };
    throw new Error(
      "Invalid BLOCKRUN_API_KEY. Correct or unset it before selecting a payment method.",
    );
  }

  for (const [path, source] of [
    [CORE_API_KEY_FILE, "core"],
    [API_KEY_FILE, "saved"],
  ] as const) {
    const stored = await readOptional(path);
    if (stored === undefined) continue;
    if (isValidApiKey(stored)) return { key: stored, source };
    throw new Error(
      `Invalid API key in ${path}. Correct or remove it before selecting a payment method.`,
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
  return { removed, envStillSet: process["env"].BLOCKRUN_API_KEY !== undefined };
}

/**
 * What `GET /v1/credits` reports for the calling key.
 *
 * `remainingUsd` is deliberately nullable and that is not an error path: an
 * account with `billingMode: "ungated"` has no granted allowance to draw down,
 * so the gateway reports `remaining_usd: null` and only `spent_usd` is
 * meaningful. Rendering a null as "$0.00" would tell such a user they are broke
 * when they are not, so every consumer has to branch on it.
 */
export type CreditBalance = {
  accountId?: string;
  billingMode?: string;
  currency: string;
  grantedUsd: number | null;
  spentUsd: number | null;
  remainingUsd: number | null;
  blocked: boolean;
  blockedReason?: string;
};

/**
 * Read the account's credit position, so a card-paying user can see where they
 * stand without opening the dashboard.
 *
 * Returns undefined on any failure — this is a status nicety, and a gateway
 * hiccup must never turn `clawrouter status` into an error. Note the endpoint
 * answers 401 for a bad key and 404 only if the gateway's endpoint gate
 * regresses (it did, briefly, on the day it shipped), so the two are worth
 * telling apart when diagnosing.
 */
export async function fetchCreditBalance(
  apiKey: string,
  timeoutMs = 5000,
): Promise<CreditBalance | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${BLOCKRUN_API_KEY_API}/v1/credits`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const b = (await res.json()) as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
    return {
      accountId: typeof b.account_id === "string" ? b.account_id : undefined,
      billingMode: typeof b.billing_mode === "string" ? b.billing_mode : undefined,
      currency: typeof b.currency === "string" ? b.currency : "USD",
      grantedUsd: num(b.granted_usd),
      spentUsd: num(b.spent_usd),
      remainingUsd: num(b.remaining_usd),
      blocked: b.blocked === true,
      blockedReason: typeof b.blocked_reason === "string" ? b.blocked_reason : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Render a credit position for a status table, honouring the nullable fields. */
export function formatCreditBalance(b: CreditBalance): string {
  const money = (v: number | null): string | undefined =>
    v === null ? undefined : `$${v.toFixed(v < 0.01 && v > 0 ? 6 : 2)}`;
  const remaining = money(b.remainingUsd);
  const spent = money(b.spentUsd);
  if (remaining) return `${remaining} remaining${spent ? ` (spent ${spent})` : ""}`;
  // Ungated account: no allowance to run down, so spend-to-date is the number
  // that means anything.
  const mode = b.billingMode === "ungated" ? "no prepaid limit" : (b.billingMode ?? "unknown");
  return `${spent ? `spent ${spent}` : "unknown"} — ${mode}`;
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
export function normalizeApiKeyBase(raw: string): string {
  const base = raw.replace(/\/+$/, "").replace(/\/v1$/, "");
  const url = new URL(base);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  ) {
    throw new Error(
      "Account API URL requires HTTPS (except localhost) and no credentials, query or fragment.",
    );
  }
  return base;
}

export function createApiKeyFetch(
  apiKey: string,
  baseFetch: typeof fetch = fetch,
  apiBase: string = BLOCKRUN_API_KEY_API,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const base = new URL(normalizeApiKeyBase(apiBase));
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input), `${base}/`);
    if (url.origin !== base.origin || url.username || url.password)
      throw new Error("Refusing to forward a BlockRun account key to another origin.");
    if (base.pathname === "/" && url.pathname.startsWith("/api/v1/"))
      url.pathname = url.pathname.slice(4);
    const headers = new Headers(init?.headers ?? request?.headers);
    for (const name of [...headers.keys()])
      if (/payment/i.test(name) || name.toLowerCase() === "x-api-key") headers.delete(name);
    headers.set("authorization", `Bearer ${apiKey}`);
    const response = await baseFetch(request ? new Request(url, request) : url.href, {
      ...init,
      headers,
      redirect: "error",
    });
    return response.ok ? response : explainApiKeyFailure(response);
  };
}

/** Complete first-response async account jobs (music/image editing) without x402. */
export async function pollApiKeyJob(
  response: Response,
  payFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  apiBase: string,
  signal: AbortSignal,
  intervalMs = 2000,
): Promise<Response> {
  if (response.status !== 202) return response;
  const initial = (await response.json()) as { poll_url?: string };
  if (!initial.poll_url) throw new Error("Async account response missing poll_url");
  const pollUrl = new URL(initial.poll_url, `${normalizeApiKeyBase(apiBase)}/`).href;
  const abort = AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]);
  while (!abort.aborted) {
    const polled = await payFetch(pollUrl, { signal: abort });
    if ([502, 503, 504, 522, 524].includes(polled.status)) {
      await polled.body?.cancel();
    } else {
      if (!polled.ok) return polled;
      // Fully consume each queued response, including its original body.
      // Parsing a clone alone would retain the unread original across polls.
      const raw = await polled.text();
      const data = JSON.parse(raw) as { status?: string };
      if (data.status === "completed")
        return new Response(raw, { status: polled.status, headers: polled.headers });
      if (["failed", "cancelled", "canceled"].includes(data.status || ""))
        throw new Error("Account job failed or was cancelled");
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(abort.reason);
      };
      const timer = setTimeout(() => {
        abort.removeEventListener("abort", onAbort);
        resolve();
      }, intervalMs);
      abort.addEventListener("abort", onAbort, { once: true });
      if (abort.aborted) onAbort();
    });
  }
  throw new Error("Account job polling stopped; check job before resubmitting.");
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
    `api.blockrun.ai does not serve this endpoint. Chat, Anthropic-shaped messages, images, ` +
    `speech, video and the partner APIs (Surf, Exa, prediction markets, phone lookup) all work ` +
    `on an API key. The wallet-only exceptions are the routes that bind a lease or a position to ` +
    `a payer address — buying/renewing/releasing phone numbers, and Polymarket trading — which ` +
    `need a wallet to own the thing being bought. For those, unset BLOCKRUN_API_KEY and run ` +
    `"clawrouter logout".`,
};
