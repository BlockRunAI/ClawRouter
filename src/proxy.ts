/**
 * Local x402 Proxy Server
 *
 * Sits between OpenClaw's pi-ai (which makes standard OpenAI-format requests)
 * and BlockRun's API (which requires x402 micropayments).
 *
 * Flow:
 *   pi-ai → http://localhost:{port}/v1/chat/completions
 *        → proxy forwards to https://blockrun.ai/api/v1/chat/completions
 *        → gets 402 → @x402/fetch signs payment → retries
 *        → streams response back to pi-ai
 *
 * Optimizations (v0.3.0):
 *   - SSE heartbeat: for streaming requests, sends headers + heartbeat immediately
 *     before the x402 flow, preventing OpenClaw's 10-15s timeout from firing.
 *   - Response dedup: hashes request bodies and caches responses for 30s,
 *     preventing double-charging when OpenClaw retries after timeout.
 *   - Smart routing: when model is "blockrun/auto", classify query and pick cheapest model.
 *   - Usage logging: log every request as JSON line to ~/.openclaw/blockrun/logs/
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// Per-request payment tracking via AsyncLocalStorage (safe for concurrent requests).
// The x402 onAfterPaymentCreation hook writes the actual payment amount into the
// request-scoped store, and the logging code reads it after payFetch completes.
// `amountUsd` is what an x402 payment actually signed for; `estimatedUsd` is
// what THIS attempt is expected to cost, published for the API-key rail's
// spend-window check, which has no 402 quote to read (#329).
const paymentStore = new AsyncLocalStorage<{ amountUsd: number; estimatedUsd?: number }>();
import { finished, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile, readFile, stat as fsStat } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/fetch";
import { createPayFetchWithPreAuth } from "./payment-preauth.js";
import { withBuilderCodeServiceCode } from "./builder-code.js";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import {
  route,
  getFallbackChain,
  filterCandidatesByCapacity,
  filterByToolCalling,
  filterByVision,
  filterByExcludeList,
  calculateModelCost,
  DEFAULT_ROUTING_CONFIG,
  inferToolRequirement,
  type RouterOptions,
  type RoutingDecision,
  type RoutingConfig,
  type ModelPricing,
  type ModelCapabilities,
  type Tier,
} from "./router/index.js";
import { classifyByRules } from "./router/index.js";
import {
  BLOCKRUN_MODELS,
  MODEL_ALIASES,
  OPENCLAW_MODELS,
  resolveModelAlias,
  isReasoningModel,
  supportsToolCalling,
  supportsVision,
  getActivePromoPrice,
} from "./models.js";
import { DEFAULT_MAX_TOKENS, resolveMaxTokens } from "./max-tokens.js";
import { logUsage, type UsageEntry } from "./logger.js";
import { getStats, clearStats, resolveStatsDays } from "./stats.js";
import { RequestDeduplicator } from "./dedup.js";
import { ResponseCache, type ResponseCacheConfig } from "./response-cache.js";
import { BalanceMonitor, ApiKeyBalanceMonitor } from "./balance.js";
import type { SolanaBalanceMonitor } from "./solana-balance.js";

/** Union type for chain- and auth-agnostic balance monitoring */
type AnyBalanceMonitor = BalanceMonitor | SolanaBalanceMonitor | ApiKeyBalanceMonitor;
import { resolvePaymentChain } from "./auth.js";
import {
  BLOCKRUN_API_KEY_API,
  PORTAL_CREDITS_URL,
  createApiKeyFetch,
  normalizeApiKeyBase,
  pollApiKeyJob,
  fetchCreditBalance,
  formatCreditBalance,
  isValidApiKey,
  maskApiKey,
} from "./api-key.js";
import {
  getSharedSpendControl,
  registerSpendPolicyHook,
  withSpendPolicy,
  POLICY_LISTS,
  SpendControl,
  SpendPolicyError,
} from "./spend-control.js";
import { compressContext, shouldCompress, type NormalizedMessage } from "./compression/index.js";
// Balance error classes are available for programmatic use but not used in the
// proxy (universal free fallback means we don't throw balance errors anymore):
// import { InsufficientFundsError, EmptyWalletError } from "./errors.js";
import { describeFetchError } from "./errors.js";
import { USER_AGENT, VERSION } from "./version.js";
import {
  SessionStore,
  getSessionId,
  deriveSessionId,
  hashRequestContent,
  type SessionConfig,
} from "./session.js";
import { checkForUpdates } from "./updater.js";
import { loadExcludeList } from "./exclude-models.js";
import { PROXY_PORT } from "./config.js";
import { SessionJournal } from "./journal.js";
import { applyUpstreamProxy } from "./upstream-proxy.js";
import { extractTextualToolCalls } from "./textual-tool-calls.js";
import {
  appendResponse,
  getById,
  getLast,
  listRecent,
  summarizeRequest,
} from "./response-store.js";
import { isSharePreset, transform } from "./share-formatters.js";

const BLOCKRUN_API = "https://blockrun.ai/api";
const BLOCKRUN_SOLANA_API = "https://sol.blockrun.ai/api";
const DESKTOP_SERVICE_TOKEN_FILE =
  process.env.CLAWROUTER_DESKTOP_TOKEN_FILE ??
  join(homedir(), ".clawrouter-desktop", "service-token");
const IMAGE_DIR = join(homedir(), ".openclaw", "blockrun", "images");
const AUDIO_DIR = join(homedir(), ".openclaw", "blockrun", "audio");
const VIDEO_DIR = join(homedir(), ".openclaw", "blockrun", "videos");
// Routing profile models - virtual models that trigger intelligent routing
const AUTO_MODEL = "blockrun/auto";

const ROUTING_PROFILES = new Set([
  "blockrun/eco",
  "eco",
  "blockrun/auto",
  "auto",
  "blockrun/premium",
  "premium",
]);
// Default free model first (auto-pick order). 2026-06-07 sweep dropped
// qwen3-next (NVIDIA EOL 2026-05-21, HTTP 410), glm-4.7 (NIM hung —
// server-redirected to qwen3-coder), and mistral-small-4-119b (upstream
// timing out, 3/3 probes >60s). gpt-oss-120b is the historical
// default — heavy users rely on it. Pulled from /v1/models 2026-04-28 over
// privacy concerns, then re-enabled with `available: true` 2026-04-30 so
// direct callers (ClawRouter using the full ID) still get HTTP 200; only
// the public picker hides them. New entries appended in chain order.
// gpt-oss stays at the head (heavy-user default, deliberately kept despite BlockRun
// hiding it). Mid/back strengthened 2026-06-14 with BlockRun's newly-featured free
// flagships (mistral-large-3-675b, qwen3.5-122b). deepseek-v4-flash dropped from
// auto-pick (BlockRun hid it) but stays catalog-routable for direct calls.
// Auto-pick cascade (order = priority for pickFreeModel) + free cost-classification
// set. Refreshed 2026-07-17 for blockrun's live re-probe (PR #257): gpt-oss stays
// head (heavy-user red line); qwen3.5-122b, qwen3-next-80b and llama-4-maverick
// dropped (all hidden + server-redirected to gpt-oss-120b upstream, so keeping
// them here would silently defeat /exclude); deepseek-v4-flash recovered.
// 2026-08-02, following blockrun's 07-28 re-probe (baa967b): mistral-large-3-675b
// is HTTP 410 Gone at NVIDIA (EOL, redirected to gpt-oss-120b) — dropped for the
// same /exclude reason.
// 2026-08-12: deepseek-v4-flash EOL'd too (blockrun #367 — published 410 on both
// probe passes, prod gate fired kind=gone; server-redirected to gpt-oss-120b) —
// dropped for the same /exclude reason. That was the last 1M-ctx free model.
// Insertion order IS the cascade order (pickFreeModel walks it). The head must
// match router-core's ecoTiers.SIMPLE primary and the `free` alias in models.ts.
// gpt-oss-120b/20b were dropped 2026-08-29: dead upstream since 2026-08-16 (a
// completion hangs; the gateway 400s the `free/` id) and hidden from the
// public catalog over NVIDIA's prompt-retention terms since 2026-04-28.
// (They RECOVERED on blockrun's 2026-08-30 probe, but stay withheld from the
// public catalog over those same terms — so they stay off this cascade and only
// remain reachable through the pins that name them.)
//
// 2026-08-30 REBUILD (blockrun #448). NVIDIA retired FOUR of the five visible
// free models in one sweep — step-3.7-flash (the head), nemotron-nano-9b-v2 and
// nemotron-nano-12b-v2-vl published 410 Gone; mistral-nemotron went the quiet
// way, still listed but >150s and zero bytes. Only nano-omni survived. Nothing
// looked broken because blockrun server-redirects retired free ids: the caller
// kept getting answers, from a different model — which is exactly the shape that
// silently defeats /exclude.
//
// Order below is deliberate, from blockrun's measurements plus a 2026-08-30
// gateway probe of every rung:
//   1. lightning  — blockrun's own retarget of the old head, so the proxy and
//                   the gateway name the same model. 1M ctx, 1.3s with tools.
//   2. nano-30b   — fastest in the tier (~121 tok/s).
//   3/4. laguna + north-mini — both sub-second coders, and deliberately adjacent
//                   because they sit on DIFFERENT capacity pools (our NVIDIA key
//                   vs OpenRouter's $0 pool), so one pool's outage does not take
//                   both rungs.
//   5. nano-omni  — the only vision-capable free model left.
//   6. ultra-550b — 1M ctx and the largest we list, but 16.8s and blockrun
//                   measured 3 of 15 calls returning an HTTP 200 that carried an
//                   upstream 502/503 error object instead of choices.
//   7. llama-vision — slowest (~18 tok/s), so last; it is here because it is the
//                   only free Llama NVIDIA still serves.
const FREE_MODELS = new Set([
  "free/nemotron-3.5-lightning", // free-tier default — 1M ctx, thinking mode
  "free/nemotron-3-nano-30b", // fastest free model (~121 tok/s)
  "free/laguna-xs-2.1", // coding, ~161 tok/s — on our NVIDIA key
  "free/north-mini-code", // coding, 607ms median — OpenRouter $0 pool
  "free/nemotron-3-nano-omni-30b-a3b-reasoning", // vision (text/image/video/audio)
  "free/nemotron-3-ultra-550b", // largest free model, 1M ctx — but slow + flaky
  "free/llama-3.2-11b-vision", // only free Llama left; slowest, so last
]);
/**
 * Upstream ids the ACTIVE chain's gateway actually lists, or `undefined` while
 * unknown. Populated once at startup by `loadGatewayCatalog()`.
 *
 * This exists because the two gateways do NOT carry the same free tier. BlockRun
 * on Base rebuilt to seven free models on 2026-08-30; sol.blockrun.ai carries one
 * of them, and answers HTTP 400 "Unknown model" for the other six. Solana has
 * been the default chain for new installs since v0.12.246, so a fresh install
 * would walk four hard 400s before reaching a rung its own gateway serves.
 *
 * Note these ids are NOT covered by the gateways' never-retire redirect rule —
 * that only protects ids a gateway once shipped. A model that never existed on a
 * chain hard-400s there, so this cannot be left to the fallback chain to absorb.
 */
let gatewayModelIds: Set<string> | undefined;

/**
 * Fetch the active gateway's catalog once, so the free cascade can skip rungs
 * this chain does not serve.
 *
 * Deliberately advisory: it filters, it never *chooses*. The cascade head stays
 * a committed literal because `free` in the alias map, `FREE_MODELS[0]`,
 * `FREE_MODEL` and router-core's `ecoTiers.SIMPLE.primary` must agree, and
 * `free-model-liveness.test.ts` checks that at build time — a runtime-derived
 * head would make the invariant unverifiable. Any failure here leaves
 * `gatewayModelIds` unset and every rung eligible, which is the pre-existing
 * behaviour: a catalog we could not read must never disable the free tier.
 */
async function loadGatewayCatalog(apiBase: string, apiKey?: string): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GATEWAY_CATALOG_TIMEOUT_MS);
    // api.blockrun.ai authenticates its catalog too; an unauthenticated read
    // there is a 401, which would leave every free rung eligible forever.
    const res = await (apiKey ? createApiKeyFetch(apiKey, fetch, apiBase) : fetch)(
      `${apiBase}/v1/models`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return;
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
    if (ids.length === 0) return; // an empty catalog is a bad read, not a bare gateway
    gatewayModelIds = new Set(ids);

    const unserved = [...FREE_MODELS].filter((m) => !gatewayModelIds!.has(toUpstreamModelId(m)));
    if (unserved.length > 0) {
      console.log(
        `[ClawRouter] Free models not served by this gateway (skipped in the cascade): ${unserved.join(", ")}`,
      );
    }
  } catch {
    // Offline, slow, or an unexpected shape — stay permissive.
  }
}

/** Does the active gateway list this model? Permissive while the catalog is unknown. */
function isServedByGateway(modelId: string): boolean {
  if (!gatewayModelIds) return true;
  return gatewayModelIds.has(toUpstreamModelId(modelId));
}

/** Pick the best available free model that isn't excluded. */
function pickFreeModel(excludeList?: Set<string>): string | undefined {
  for (const m of FREE_MODELS) {
    if (excludeList?.has(m)) continue;
    if (!isServedByGateway(m)) continue;
    return m;
  }
  // Every rung was filtered out by the catalog. Fall back to the unfiltered walk:
  // a stale or wrong catalog read must not be able to turn the free tier off.
  for (const m of FREE_MODELS) {
    if (!excludeList?.has(m)) return m;
  }
  return undefined; // all free models excluded
}
// Keep backward-compat constant for places that don't have excludeList in scope
const FREE_MODEL = "free/nemotron-3.5-lightning";
/**
 * Free models whose upstream id is NOT `nvidia/<basename>`.
 *
 * The free tier stopped being NVIDIA-only on 2026-08-30 (blockrun #448): two of
 * the seven are hosted under their own maker's namespace upstream. The `free/`
 * prefix stays ClawRouter's picker convention for all of them — a picker row
 * reading `cohere/north-mini-code` gives a user no way to tell it is free — so
 * the exceptions are named here instead of leaking into the id.
 *
 * A wrong value here is a 400 on every request to that model, so each one is
 * covered by a unit test.
 */
const FREE_UPSTREAM_OVERRIDES: Record<string, string> = {
  "free/north-mini-code": "cohere/north-mini-code",
  "free/laguna-xs-2.1": "poolside/laguna-xs-2.1",
};

/**
 * Map free/xxx model IDs to their upstream BlockRun ID.
 * The "free/" prefix is a ClawRouter convention for the /model picker; upstream
 * they are `nvidia/xxx` by default, or whatever FREE_UPSTREAM_OVERRIDES says.
 */
export function toUpstreamModelId(modelId: string): string {
  const override = FREE_UPSTREAM_OVERRIDES[modelId];
  if (override) return override;
  if (modelId.startsWith("free/")) {
    return "nvidia/" + modelId.slice("free/".length);
  }
  return modelId;
}
const MAX_MESSAGES = 200; // BlockRun API limit - truncate older messages if exceeded
const CONTEXT_LIMIT_KB = 5120; // Server-side limit: 5MB in KB
const HEARTBEAT_INTERVAL_MS = 2_000;
// Hard ceiling on the pre-request balance check. It runs before SSE headers
// are flushed, so a slow RPC must not eat into OpenClaw's ~10-15s silence
// timeout. On expiry the request proceeds optimistically.
const BALANCE_CHECK_TIMEOUT_MS = 2_500;
// Startup catalog read. Advisory only — see loadGatewayCatalog().
const GATEWAY_CATALOG_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000; // 5 minutes (allows reasoning model first-attempt + non-reasoning fallback)
const PER_MODEL_TIMEOUT_MS = 60_000; // 60s per non-reasoning model attempt (fallback to next on exceed)
const REASONING_MODEL_TIMEOUT_MS = 180_000; // 3min per reasoning model attempt — first-token cold-start can take 60-120s on V4 Pro / Claude opus thinking / GPT-5 reasoning_effort=high

const REASONING_MODEL_IDS: Set<string> = new Set(
  BLOCKRUN_MODELS.filter((m) => m.reasoning).map((m) => m.id),
);

function timeoutForModel(modelId: string): number {
  return REASONING_MODEL_IDS.has(modelId) ? REASONING_MODEL_TIMEOUT_MS : PER_MODEL_TIMEOUT_MS;
}
const MAX_FALLBACK_ATTEMPTS = 5; // Maximum models to try in fallback chain (increased from 3 to ensure cheap models are tried)
const HEALTH_CHECK_TIMEOUT_MS = 2_000; // Timeout for checking existing proxy
const RATE_LIMIT_COOLDOWN_MS = 60_000; // 60 seconds cooldown for rate-limited models
const OVERLOAD_COOLDOWN_MS = 15_000; // 15 seconds cooldown for overloaded providers
const PORT_RETRY_ATTEMPTS = 5; // Max attempts to bind port (handles TIME_WAIT)
const PORT_RETRY_DELAY_MS = 1_000; // Delay between retry attempts
const MODEL_BODY_READ_TIMEOUT_MS = 300_000; // 5 minutes for model responses (reasoning models are slow)
const ERROR_BODY_READ_TIMEOUT_MS = 30_000; // 30 seconds for error/partner body reads

/** Thrown inside proxyRequest when the upstream was aborted because the client hung up. */
class ClientDisconnectedError extends Error {
  constructor() {
    super("Client disconnected");
    this.name = "ClientDisconnectedError";
  }
}

async function readBodyWithTimeout(
  body: ReadableStream<Uint8Array> | null,
  timeoutMs: number = MODEL_BODY_READ_TIMEOUT_MS,
): Promise<Uint8Array[]> {
  if (!body) return [];

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (true) {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Body read timeout")), timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (result.done) break;
      chunks.push(result.value);
    }
  } catch (err) {
    // Cancel the stream so the underlying connection is released instead of
    // buffering until GC (releaseLock alone leaves it open).
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }

  return chunks;
}

/**
 * Transform upstream payment errors into user-friendly messages.
 * Parses the raw x402 error and formats it nicely.
 */
export function transformPaymentError(errorBody: string): string {
  try {
    // Try to parse the error JSON
    const parsed = JSON.parse(errorBody) as {
      error?: string;
      details?: string;
      // blockrun-sol (Solana) format uses code+debug instead of details
      code?: string;
      debug?: string;
      payer?: string;
    };

    // Check if this is a payment verification error
    if (parsed.error === "Payment verification failed" && parsed.details) {
      // Extract the nested JSON from details
      // Format: "Verification failed: {json}\n"
      const match = parsed.details.match(/Verification failed:\s*(\{.*\})/s);
      if (match) {
        const innerJson = JSON.parse(match[1]) as {
          invalidMessage?: string;
          invalidReason?: string;
          payer?: string;
        };

        if (innerJson.invalidReason === "insufficient_funds" && innerJson.invalidMessage) {
          // Parse "insufficient balance: 251 < 11463"
          const balanceMatch = innerJson.invalidMessage.match(
            /insufficient balance:\s*(\d+)\s*<\s*(\d+)/i,
          );
          if (balanceMatch) {
            const currentMicros = parseInt(balanceMatch[1], 10);
            const requiredMicros = parseInt(balanceMatch[2], 10);
            const currentUSD = (currentMicros / 1_000_000).toFixed(6);
            const requiredUSD = (requiredMicros / 1_000_000).toFixed(6);
            const wallet = innerJson.payer || "unknown";
            const shortWallet =
              wallet.length > 12 ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : wallet;

            return JSON.stringify({
              error: {
                message: `Insufficient USDC balance. Current: $${currentUSD}, Required: ~$${requiredUSD}`,
                type: "insufficient_funds",
                wallet: wallet,
                current_balance_usd: currentUSD,
                required_usd: requiredUSD,
                help: `Fund wallet ${shortWallet} with USDC on Base, or use free model: /model free`,
              },
            });
          }
        }

        // Handle invalid_payload errors (signature issues, malformed payment)
        if (innerJson.invalidReason === "invalid_payload") {
          return JSON.stringify({
            error: {
              message: "Payment signature invalid. This may be a temporary issue.",
              type: "invalid_payload",
              help: "Try again. If this persists, reinstall ClawRouter: curl -fsSL https://blockrun.ai/ClawRouter-update | bash",
            },
          });
        }

        // Handle transaction simulation failures (Solana on-chain validation)
        if (innerJson.invalidReason === "transaction_simulation_failed") {
          console.error(
            `[ClawRouter] Solana transaction simulation failed: ${innerJson.invalidMessage || "unknown"}`,
          );
          return JSON.stringify({
            error: {
              message: "Solana payment simulation failed. Retrying with a different model.",
              type: "transaction_simulation_failed",
              help: "This is usually temporary. If it persists, check your Solana USDC balance or try: /model free",
            },
          });
        }
      }
    }

    // Handle code=PAYMENT_INVALID + debug format (used by blockrun-sol, can also
    // appear from blockrun Base when CDP returns non-200 with structured JSON body)
    if (
      parsed.error === "Payment verification failed" &&
      parsed.code === "PAYMENT_INVALID" &&
      parsed.debug
    ) {
      const debugLower = parsed.debug.toLowerCase();
      const wallet = parsed.payer || "unknown";
      const shortWallet =
        wallet.length > 12 ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : wallet;
      // Detect chain from payer address format (0x = EVM, else Solana)
      const chain = wallet.startsWith("0x") ? "Base" : "Solana";

      if (debugLower.includes("insufficient")) {
        return JSON.stringify({
          error: {
            message: `Insufficient ${chain} USDC balance.`,
            type: "insufficient_funds",
            wallet,
            help:
              chain === "Solana"
                ? `Fund wallet ${shortWallet} with USDC on Solana, or switch to Base: /wallet base`
                : `Fund wallet ${shortWallet} with USDC on Base, or use free model: /model free`,
          },
        });
      }

      if (
        debugLower.includes("transaction_simulation_failed") ||
        debugLower.includes("simulation")
      ) {
        console.error(`[ClawRouter] ${chain} transaction simulation failed: ${parsed.debug}`);
        return JSON.stringify({
          error: {
            message: `${chain} payment simulation failed. Retrying with a different model.`,
            type: "transaction_simulation_failed",
            help: "This is usually temporary. If it persists, try: /model free",
          },
        });
      }

      if (debugLower.includes("invalid signature") || debugLower.includes("invalid_signature")) {
        return JSON.stringify({
          error: {
            message: `${chain} payment signature invalid.`,
            type: "invalid_payload",
            help: "Try again. If this persists, reinstall ClawRouter: curl -fsSL https://blockrun.ai/ClawRouter-update | bash",
          },
        });
      }

      if (debugLower.includes("expired")) {
        return JSON.stringify({
          error: {
            message: `${chain} payment expired. Retrying.`,
            type: "expired",
            help: "This is usually temporary.",
          },
        });
      }

      // Unknown verification error — surface the debug reason
      console.error(
        `[ClawRouter] ${chain} payment verification failed: ${parsed.debug} payer=${wallet}`,
      );
      return JSON.stringify({
        error: {
          message: `${chain} payment verification failed: ${parsed.debug}`,
          type: "payment_invalid",
          wallet,
          help:
            chain === "Solana"
              ? "Try again or switch to Base: /wallet base"
              : "Try again. If this persists, try: /model free",
        },
      });
    }

    // Handle settlement failures (gas estimation, on-chain errors)
    if (
      parsed.error === "Settlement failed" ||
      parsed.error === "Payment settlement failed" ||
      parsed.details?.includes("Settlement failed") ||
      parsed.details?.includes("transaction_simulation_failed")
    ) {
      const details = parsed.details || "";
      const gasError = details.includes("unable to estimate gas");

      return JSON.stringify({
        error: {
          message: gasError
            ? "Payment failed: network congestion or gas issue. Try again."
            : "Payment settlement failed. Try again in a moment.",
          type: "settlement_failed",
          help: "This is usually temporary. If it persists, try: /model free",
        },
      });
    }
  } catch {
    // If parsing fails, return original
  }
  return errorBody;
}

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

/**
 * Track rate-limited models to avoid hitting them again.
 * Maps model ID to the timestamp when the rate limit was hit.
 */
const rateLimitedModels = new Map<string, number>();

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

/**
 * Check if a model is currently rate-limited (in cooldown period).
 */
function isRateLimited(modelId: string): boolean {
  const hitTime = rateLimitedModels.get(modelId);
  if (!hitTime) return false;

  const elapsed = Date.now() - hitTime;
  if (elapsed >= RATE_LIMIT_COOLDOWN_MS) {
    rateLimitedModels.delete(modelId);
    return false;
  }
  return true;
}

/**
 * Mark a model as rate-limited.
 */
function markRateLimited(modelId: string): void {
  rateLimitedModels.set(modelId, Date.now());
  console.log(`[ClawRouter] Model ${modelId} rate-limited, will deprioritize for 60s`);
}

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

/**
 * Reorder models to put rate-limited ones at the end.
 */
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

/**
 * Check if response socket is writable (prevents write-after-close errors).
 * Returns true only if all conditions are safe for writing.
 */
function canWrite(res: ServerResponse): boolean {
  return (
    !res.writableEnded &&
    !res.destroyed &&
    res.socket !== null &&
    !res.socket.destroyed &&
    res.socket.writable
  );
}

/**
 * Safe write with backpressure handling.
 * Returns true if write succeeded, false if socket is closed or write failed.
 */
function safeWrite(res: ServerResponse, data: string | Buffer): boolean {
  if (!canWrite(res)) {
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    console.warn(`[ClawRouter] safeWrite: socket not writable, dropping ${bytes} bytes`);
    return false;
  }
  return res.write(data);
}

// Extra buffer for balance check (on top of estimateAmount's 20% buffer)
// Total effective buffer: 1.2 * 1.5 = 1.8x (80% safety margin)
// This prevents x402 payment failures after streaming headers are sent,
// which would trigger OpenClaw's 5-24 hour billing cooldown.
const BALANCE_CHECK_BUFFER = 1.5;
const BALANCE_PREFLIGHT_OUTPUT_TOKEN_CAP = 4096;

/**
 * Make a string safe for use as an HTTP header value.
 *
 * Node rejects header values containing chars outside Latin-1 with
 * ERR_INVALID_CHAR ("Invalid character in header content"). Routing reasoning
 * includes matched keywords from the multilingual lists in router/config.ts
 * (e.g. Cyrillic "функция"), so non-Russian/CJK prompts produce reasoning that
 * crashes res.writeHead AFTER the upstream call has completed and the x402
 * payment has settled — the client then retries and pays again.
 *
 * Percent-encodes everything outside printable ASCII (stricter than Node's
 * Latin-1 allowance, so intermediaries can't choke either). Reversible via
 * decodeURIComponent for debugging.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[^\t\x20-\x7E]/gu, (c) => {
    try {
      return encodeURIComponent(c);
    } catch {
      return "?"; // lone surrogate — not encodable
    }
  });
}

/**
 * Whether x-clawrouter-* debug headers (profile/tier/model/reasoning) should
 * be emitted. On by default; kill switch via CLAWROUTER_DEBUG_HEADERS=off|false|0
 * for clients that can't set the x-clawrouter-debug request header.
 */
export function debugHeadersEnabledFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = (env.CLAWROUTER_DEBUG_HEADERS ?? "").toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

/**
 * Get the proxy port from pre-loaded configuration.
 * Port is validated at module load time, this just returns the cached value.
 */
export function getProxyPort(): number {
  return PROXY_PORT;
}

/**
 * Check if a proxy is already running on the given port.
 * Returns the wallet address if running, undefined otherwise.
 */
async function checkExistingProxy(
  port: number,
): Promise<
  { wallet: string; paymentChain?: string; authMode: AuthMode; apiKeyLabel?: string } | undefined
> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = (await response.json()) as {
        status?: string;
        wallet?: string;
        paymentChain?: string;
        authMode?: string;
        apiKey?: string;
      };
      // An API-key proxy has no wallet to report, so `wallet` alone can no
      // longer be the liveness signal. Anything that does not name its mode is
      // a pre-v0.12.268 instance, which could only have been a wallet proxy.
      const authMode: AuthMode = data.authMode === "api-key" ? "api-key" : "wallet";
      if (data.status === "ok" && (data.wallet || authMode === "api-key")) {
        return {
          wallet: data.wallet ?? "",
          paymentChain: data.paymentChain,
          authMode,
          apiKeyLabel: typeof data.apiKey === "string" ? data.apiKey : undefined,
        };
      }
    }
    return undefined;
  } catch {
    clearTimeout(timeoutId);
    return undefined;
  }
}

/**
 * Error patterns that indicate a provider-side issue (not user's fault).
 * These errors should trigger fallback to the next model in the chain.
 */
const PROVIDER_ERROR_PATTERNS = [
  /billing/i,
  /insufficient.*balance/i,
  /credits/i,
  /quota.*exceeded/i,
  /rate.*limit/i,
  /model.*unavailable/i,
  /model.*not.*available/i,
  /service.*unavailable/i,
  /capacity/i,
  /overloaded/i,
  /temporarily.*unavailable/i,
  /api.*key.*invalid/i,
  /authentication.*failed/i,
  /request too large/i,
  /request.*size.*exceeds/i,
  /payload too large/i,
  /payment.*verification.*failed/i,
  /model.*not.*allowed/i,
  /unknown.*model/i,
  /reasoning_content.*missing/i, // Thinking model multi-turn: missing reasoning_content → fallback
  /thinking.*reasoning_content/i,
];

/**
 * "Successful" response bodies that are actually provider degradation placeholders.
 * Some upstream providers occasionally return these with HTTP 200.
 */
const DEGRADED_RESPONSE_PATTERNS = [
  /the ai service is temporarily overloaded/i,
  /service is temporarily overloaded/i,
  /please try again in a moment/i,
];

/**
 * Known low-quality loop signatures seen during provider degradation windows.
 */
const DEGRADED_LOOP_PATTERNS = [
  /the boxed is the response\./i,
  /the response is the text\./i,
  /the final answer is the boxed\./i,
];

function extractAssistantContent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") return undefined;
  const choice = firstChoice as Record<string, unknown>;
  const message = choice.message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

function hasKnownLoopSignature(text: string): boolean {
  const matchCount = DEGRADED_LOOP_PATTERNS.reduce(
    (count, pattern) => (pattern.test(text) ? count + 1 : count),
    0,
  );
  if (matchCount >= 2) return true;

  // Generic repetitive loop fallback for short repeated lines.
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 8) return false;

  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  const maxRepeat = Math.max(...counts.values());
  const uniqueRatio = counts.size / lines.length;
  return maxRepeat >= 3 && uniqueRatio <= 0.45;
}

/**
 * Detect degraded 200-response payloads that should trigger model fallback.
 * Returns a short reason when fallback should happen, otherwise undefined.
 */
export function detectDegradedSuccessResponse(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;

  // Plain-text placeholder response.
  if (DEGRADED_RESPONSE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return "degraded response: overloaded placeholder";
  }

  // Plain-text looping garbage response.
  if (hasKnownLoopSignature(trimmed)) {
    return "degraded response: repetitive loop output";
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    // Some providers return JSON error payloads with HTTP 200.
    const errorField = parsed.error;
    let errorText = "";
    if (typeof errorField === "string") {
      errorText = errorField;
    } else if (errorField && typeof errorField === "object") {
      const errObj = errorField as Record<string, unknown>;
      errorText = [
        typeof errObj.message === "string" ? errObj.message : "",
        typeof errObj.type === "string" ? errObj.type : "",
        typeof errObj.code === "string" ? errObj.code : "",
      ]
        .filter(Boolean)
        .join(" ");
    }
    if (errorText && PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(errorText))) {
      return `degraded response: ${errorText.slice(0, 120)}`;
    }

    // Detect empty-turn responses: model returned 200 but no content and no tool calls.
    // Happens when models like gemini-3.1-flash-lite receive complex agentic requests
    // (e.g. Roo Code tool schemas) and produce zero output instead of refusing.
    const choices = parsed.choices;
    // A 200 whose `choices` array is EMPTY carries no answer at all. Distinct
    // from the empty-turn case below (which has a choice whose content is
    // blank), and previously passed straight through to the caller as a
    // success. Seen when a relay reports upstream congestion in the envelope
    // rather than the body — the shape blockrun #448 hit on
    // nemotron-3-ultra-550b at ~3 in 15 calls. Guarded on the key being present
    // so a non-chat response (images, audio, embeddings) is untouched.
    if (Array.isArray(choices) && choices.length === 0) {
      return "degraded response: no choices returned";
    }
    if (Array.isArray(choices) && choices.length > 0) {
      const choice = choices[0] as Record<string, unknown>;
      const msg = (choice.message ?? choice.delta) as Record<string, unknown> | undefined;
      if (msg) {
        const content = msg.content;
        const toolCalls = msg.tool_calls;
        const hasContent = typeof content === "string" && content.trim().length > 0;
        const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
        const finishReason = choice.finish_reason as string | null | undefined;
        if (!hasContent && !hasToolCalls && finishReason === "stop") {
          return "degraded response: empty turn (no content or tool calls)";
        }
      }
    }

    // Successful wrapper with bad assistant content.
    const assistantContent = extractAssistantContent(parsed);
    if (!assistantContent) return undefined;
    if (DEGRADED_RESPONSE_PATTERNS.some((pattern) => pattern.test(assistantContent))) {
      return "degraded response: overloaded assistant content";
    }
    if (hasKnownLoopSignature(assistantContent)) {
      return "degraded response: repetitive assistant loop";
    }
  } catch {
    // Not JSON - handled by plaintext checks above.
  }

  return undefined;
}

/**
 * Valid message roles for OpenAI-compatible APIs.
 * Some clients send non-standard roles (e.g., "developer" instead of "system").
 */
const VALID_ROLES = new Set(["system", "user", "assistant", "tool", "function"]);

/**
 * Role mappings for non-standard roles.
 * Maps client-specific roles to standard OpenAI roles.
 */
const ROLE_MAPPINGS: Record<string, string> = {
  developer: "system", // OpenAI's newer API uses "developer" for system messages
  model: "assistant", // Some APIs use "model" instead of "assistant"
};

type ChatMessage = { role: string; content: string | unknown };

/**
 * Anthropic tool ID pattern: only alphanumeric, underscore, and hyphen allowed.
 * Error: "messages.X.content.Y.tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'"
 */
const VALID_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Sanitize a tool ID to match Anthropic's required pattern.
 * Replaces invalid characters with underscores.
 */
function sanitizeToolId(id: string | undefined): string | undefined {
  if (!id || typeof id !== "string") return id;
  if (VALID_TOOL_ID_PATTERN.test(id)) return id;

  // Replace invalid characters with underscores
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Type for messages with tool calls (OpenAI format).
 */
type MessageWithTools = ChatMessage & {
  tool_calls?: Array<{ id?: string; type?: string; function?: unknown }>;
  tool_call_id?: string;
};

/**
 * Type for content blocks that may contain tool IDs (Anthropic format in OpenAI wrapper).
 */
type ContentBlock = {
  type?: string;
  id?: string;
  tool_use_id?: string;
  [key: string]: unknown;
};

/**
 * Sanitize all tool IDs in messages to match Anthropic's pattern.
 * Handles both OpenAI format (tool_calls, tool_call_id) and content block formats.
 */
function sanitizeToolIds(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return messages;

  let hasChanges = false;
  const sanitized = messages.map((msg) => {
    const typedMsg = msg as MessageWithTools;
    let msgChanged = false;
    let newMsg = { ...msg } as MessageWithTools;

    // Sanitize tool_calls[].id in assistant messages
    if (typedMsg.tool_calls && Array.isArray(typedMsg.tool_calls)) {
      const newToolCalls = typedMsg.tool_calls.map((tc) => {
        if (tc.id && typeof tc.id === "string") {
          const sanitized = sanitizeToolId(tc.id);
          if (sanitized !== tc.id) {
            msgChanged = true;
            return { ...tc, id: sanitized };
          }
        }
        return tc;
      });
      if (msgChanged) {
        newMsg = { ...newMsg, tool_calls: newToolCalls };
      }
    }

    // Sanitize tool_call_id in tool messages
    if (typedMsg.tool_call_id && typeof typedMsg.tool_call_id === "string") {
      const sanitized = sanitizeToolId(typedMsg.tool_call_id);
      if (sanitized !== typedMsg.tool_call_id) {
        msgChanged = true;
        newMsg = { ...newMsg, tool_call_id: sanitized };
      }
    }

    // Sanitize content blocks if content is an array (Anthropic-style content)
    if (Array.isArray(typedMsg.content)) {
      const newContent = (typedMsg.content as ContentBlock[]).map((block) => {
        if (!block || typeof block !== "object") return block;

        let blockChanged = false;
        let newBlock = { ...block };

        // tool_use blocks have "id"
        if (block.type === "tool_use" && block.id && typeof block.id === "string") {
          const sanitized = sanitizeToolId(block.id);
          if (sanitized !== block.id) {
            blockChanged = true;
            newBlock = { ...newBlock, id: sanitized };
          }
        }

        // tool_result blocks have "tool_use_id"
        if (
          block.type === "tool_result" &&
          block.tool_use_id &&
          typeof block.tool_use_id === "string"
        ) {
          const sanitized = sanitizeToolId(block.tool_use_id);
          if (sanitized !== block.tool_use_id) {
            blockChanged = true;
            newBlock = { ...newBlock, tool_use_id: sanitized };
          }
        }

        if (blockChanged) {
          msgChanged = true;
          return newBlock;
        }
        return block;
      });

      if (msgChanged) {
        newMsg = { ...newMsg, content: newContent };
      }
    }

    if (msgChanged) {
      hasChanges = true;
      return newMsg;
    }
    return msg;
  });

  return hasChanges ? sanitized : messages;
}

/**
 * Normalize message roles to standard OpenAI format.
 * Converts non-standard roles (e.g., "developer") to valid ones.
 */
function normalizeMessageRoles(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return messages;

  let hasChanges = false;
  const normalized = messages.map((msg) => {
    if (VALID_ROLES.has(msg.role)) return msg;

    const mappedRole = ROLE_MAPPINGS[msg.role];
    if (mappedRole) {
      hasChanges = true;
      return { ...msg, role: mappedRole };
    }

    // Unknown role - default to "user" to avoid API errors
    hasChanges = true;
    return { ...msg, role: "user" };
  });

  return hasChanges ? normalized : messages;
}

/**
 * Normalize messages for Google models.
 * Google's Gemini API requires the first non-system message to be from "user".
 * If conversation starts with "assistant"/"model", prepend a placeholder user message.
 */

function normalizeMessagesForGoogle(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return messages;

  // Find first non-system message
  let firstNonSystemIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "system") {
      firstNonSystemIdx = i;
      break;
    }
  }

  // If no non-system messages, return as-is
  if (firstNonSystemIdx === -1) return messages;

  const firstRole = messages[firstNonSystemIdx].role;

  // If first non-system message is already "user", no change needed
  if (firstRole === "user") return messages;

  // If first non-system message is "assistant" or "model", prepend a user message
  if (firstRole === "assistant" || firstRole === "model") {
    const normalized = [...messages];
    normalized.splice(firstNonSystemIdx, 0, {
      role: "user",
      content: "(continuing conversation)",
    });
    return normalized;
  }

  return messages;
}

/**
 * Check if a model is a Google model that requires message normalization.
 */
function isGoogleModel(modelId: string): boolean {
  return modelId.startsWith("google/") || modelId.startsWith("gemini");
}

/**
 * Extended message type for thinking-enabled conversations.
 */
type ExtendedChatMessage = ChatMessage & {
  tool_calls?: unknown[];
  reasoning_content?: unknown;
};

/**
 * Normalize messages for thinking-enabled requests.
 * When thinking/extended_thinking is enabled, ALL assistant messages in history
 * must have reasoning_content (can be empty string if not present).
 *
 * Reasoning models like Kimi K2.5, DeepSeek-R1, etc. strip their thinking tokens
 * before we forward the response to the client. So when the client sends back the
 * assistant message in a follow-up turn, it lacks reasoning_content. These models
 * reject the multi-turn history with 400 if any assistant message is missing it.
 *
 * Previously only tool-call messages were patched — this missed plain text assistant
 * messages, causing 100% failures on existing (multi-turn) chats.
 *
 * Error examples:
 *   "400 thinking is enabled but reasoning_content is missing in assistant tool call message"
 *   "400 thinking is enabled but reasoning_content is missing in assistant message"
 */
export function normalizeMessagesForThinking(
  messages: ExtendedChatMessage[],
): ExtendedChatMessage[] {
  if (!messages || messages.length === 0) return messages;

  let hasChanges = false;
  const normalized = messages.map((msg) => {
    // Skip if not assistant or already has reasoning_content
    if (msg.role !== "assistant" || msg.reasoning_content !== undefined) {
      return msg;
    }

    // Add reasoning_content: "" to ALL assistant messages.
    // Reasoning models require it on every assistant turn in history, not just tool-call turns.
    hasChanges = true;
    return { ...msg, reasoning_content: "" };
  });

  return hasChanges ? normalized : messages;
}

/**
 * Remove "blockrun" branding from system messages before sending upstream.
 *
 * OpenClaw embeds `model=blockrun/auto` and `default_model=blockrun/auto` in its
 * system prompt Runtime section. LLMs pick up "blockrun" and adopt it as their
 * identity (e.g. "I'm Blockrun"), overriding the user's SOUL.md persona.
 *
 * This function replaces `blockrun/<profile>` references with the actual resolved
 * model name, and strips any remaining "blockrun/" prefix so the upstream LLM
 * never sees "blockrun" as an identity to adopt.
 */
export function debrandSystemMessages(
  messages: ChatMessage[],
  resolvedModel: string,
): ChatMessage[] {
  // Routing profile names that get replaced with the actual model
  const PROFILE_NAMES = ["auto", "free", "eco", "premium"];
  const profilePattern = new RegExp(`\\bblockrun/(${PROFILE_NAMES.join("|")})\\b`, "gi");
  // Also handle "blockrun/<provider>/<model>" → "<provider>/<model>"
  const prefixPattern = /\bblockrun\/(?=[a-z])/gi;

  let hasChanges = false;
  const result = messages.map((msg) => {
    if (msg.role !== "system" || typeof msg.content !== "string") return msg;

    let content = msg.content;

    // Replace routing profiles (blockrun/auto etc.) with resolved model
    const afterProfiles = content.replace(profilePattern, resolvedModel);

    // Replace remaining blockrun/ prefix (e.g. blockrun/openai/gpt-4o → openai/gpt-4o)
    const afterPrefix = afterProfiles.replace(prefixPattern, "");

    if (afterPrefix !== content) {
      hasChanges = true;
      content = afterPrefix;
    }

    return content !== msg.content ? { ...msg, content } : msg;
  });

  return hasChanges ? result : messages;
}

/**
 * Result of truncating messages.
 */
type TruncationResult<T> = {
  messages: T[];
  wasTruncated: boolean;
  originalCount: number;
  truncatedCount: number;
};

/**
 * True for a message that answers a prior assistant tool call and therefore
 * cannot stand alone at the head of a conversation: OpenAI-style
 * `role: "tool"`, or an Anthropic-in-OpenAI-wrapper `user` turn whose content
 * blocks are `tool_result`s.
 */
function isToolResultMessage(msg: { role: string; content?: unknown }): boolean {
  if (msg.role === "tool") return true;
  if (Array.isArray(msg.content)) {
    return (msg.content as ContentBlock[]).some(
      (b) => b && typeof b === "object" && b.type === "tool_result",
    );
  }
  return false;
}

/**
 * Truncate messages to stay under BlockRun's MAX_MESSAGES limit.
 * Keeps all system messages and the most recent conversation history.
 * Returns the messages and whether truncation occurred.
 */
export function truncateMessages<T extends { role: string }>(messages: T[]): TruncationResult<T> {
  if (!messages || messages.length <= MAX_MESSAGES) {
    return {
      messages,
      wasTruncated: false,
      originalCount: messages?.length ?? 0,
      truncatedCount: messages?.length ?? 0,
    };
  }

  // Separate system messages from conversation
  const systemMsgs = messages.filter((m) => m.role === "system");
  const conversationMsgs = messages.filter((m) => m.role !== "system");

  // Keep all system messages + most recent conversation messages
  const maxConversation = MAX_MESSAGES - systemMsgs.length;
  let start = Math.max(0, conversationMsgs.length - maxConversation);

  // #252: never open the kept window on a tool result whose parent assistant
  // `tool_calls` turn was just dropped — providers 400 on the orphan
  // (Anthropic: "tool_use block without matching tool_result"; OpenAI:
  // "tool_calls referenced but tool response missing"). Walk the boundary
  // FORWARD past the orphaned results so the whole exchange is dropped
  // together; walking backward could exceed MAX_MESSAGES. A parallel tool
  // call's results are contiguous, so this also handles the multi-result
  // case where the slice landed mid-exchange.
  while (start < conversationMsgs.length && isToolResultMessage(conversationMsgs[start])) {
    start++;
  }
  const truncatedConversation = conversationMsgs.slice(start);

  const result = [...systemMsgs, ...truncatedConversation];

  console.log(
    `[ClawRouter] Truncated messages: ${messages.length} → ${result.length} (kept ${systemMsgs.length} system + ${truncatedConversation.length} recent)`,
  );

  return {
    messages: result,
    wasTruncated: true,
    originalCount: messages.length,
    truncatedCount: result.length,
  };
}

// Kimi/Moonshot models use special Unicode tokens for thinking boundaries.
// Pattern: <｜begin▁of▁thinking｜>content<｜end▁of▁thinking｜>
// The ｜ is fullwidth vertical bar (U+FF5C), ▁ is lower one-eighth block (U+2581).

// Match full Kimi thinking blocks: <｜begin...｜>content<｜end...｜>
const KIMI_BLOCK_RE = /<[｜|][^<>]*begin[^<>]*[｜|]>[\s\S]*?<[｜|][^<>]*end[^<>]*[｜|]>/gi;

// Match standalone Kimi tokens like <｜end▁of▁thinking｜>
const KIMI_TOKEN_RE = /<[｜|][^<>]*[｜|]>/g;

// Standard thinking tags that may leak through from various models
// Includes namespaced antml:thinking (Anthropic internal monologue, stripped by OpenClaw v2026.4.2+)
const THINKING_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking|antml:thinking)\b[^>]*>/gi;

// Full thinking blocks: <think>content</think>
const THINKING_BLOCK_RE =
  /<\s*(?:think(?:ing)?|thought|antthinking|antml:thinking)\b[^>]*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking|antml:thinking)\s*>/gi;

/**
 * Strip thinking tokens and blocks from model response content.
 * Handles both Kimi-style Unicode tokens and standard XML-style tags.
 *
 * NOTE: DSML tags (<｜DSML｜...>) are NOT stripped - those are tool calls
 * that should be handled by the API, not hidden from users.
 */
function stripThinkingTokens(content: string): string {
  if (!content) return content;
  // Strip full Kimi thinking blocks first (begin...end with content)
  let cleaned = content.replace(KIMI_BLOCK_RE, "");
  // Strip remaining standalone Kimi tokens
  cleaned = cleaned.replace(KIMI_TOKEN_RE, "");
  // Strip full thinking blocks (<think>...</think>)
  cleaned = cleaned.replace(THINKING_BLOCK_RE, "");
  // Strip remaining standalone thinking tags
  cleaned = cleaned.replace(THINKING_TAG_RE, "");
  return cleaned;
}

/**
 * Whether a turn that carries `tool_calls` may also carry prose to the user.
 *
 * Models routinely address the user on the same turn they call a tool ("not
 * sent yet, checking first"), and OpenAI-compatible clients expect that text
 * in `content` alongside `tool_calls`. Suppressing it mutes the agent for the
 * whole tool-using stretch of a conversation. Set
 * CLAWROUTER_TOOL_CALL_PROSE=off for models that dump untagged
 * chain-of-thought into `content` rather than into a thinking block.
 */
function forwardToolCallProse(): boolean {
  return process.env.CLAWROUTER_TOOL_CALL_PROSE?.trim().toLowerCase() !== "off";
}

/** Callback info for low balance warning */
export type LowBalanceInfo = {
  balanceUSD: string;
  walletAddress: string;
};

/** Callback info for insufficient funds error */
export type InsufficientFundsInfo = {
  balanceUSD: string;
  requiredUSD: string;
  walletAddress: string;
};

/**
 * Wallet config: either a plain EVM private key string, or the full
 * resolution object from resolveOrGenerateWalletKey() which may include
 * Solana keys. Using the full object prevents callers from accidentally
 * forgetting to forward Solana key bytes.
 */
export type WalletConfig = string | { key: string; solanaPrivateKeyBytes?: Uint8Array };

export type PaymentChain = "base" | "solana";

/**
 * How this proxy pays BlockRun.
 * - "wallet"  — x402 micropayments signed per call from a local USDC wallet.
 * - "api-key" — a `brk_…` bearer token drawing on account credit topped up by
 *               card at https://user.blockrun.ai. No wallet, no chain, no gas.
 */
export type AuthMode = "wallet" | "api-key";

export type ProxyOptions = {
  /**
   * Wallet material for x402 mode. Optional only when `apiKey` is set — one of
   * the two must be present or the proxy has no way to pay for anything.
   */
  wallet?: WalletConfig;
  /**
   * BlockRun API key (`brk_…`). When present it wins over `wallet`: the proxy
   * talks to api.blockrun.ai with a bearer token and signs no payments at all.
   * Also readable from BLOCKRUN_API_KEY / ~/.blockrun/.api-key via
   * resolveApiKey(); callers resolve it and pass it in.
   */
  apiKey?: string;
  apiBase?: string;
  /**
   * Payment chain: "base" or "solana". New installs persist "solana" at wallet
   * generation; absent config resolves to "base" for pre-existing installs.
   * Can also be set via CLAWROUTER_PAYMENT_CHAIN env var.
   */
  paymentChain?: PaymentChain;
  /** Port to listen on (default: 8402) */
  port?: number;
  /**
   * Reuse a compatible process already listening on the requested port.
   * Desktop disables this because it must only configure agents against a
   * process whose lifecycle it owns.
   */
  allowExistingProxy?: boolean;
  routingConfig?: Partial<RoutingConfig>;
  /** Request timeout in ms (default: 180000 = 3 minutes). Covers on-chain tx + LLM response. */
  requestTimeoutMs?: number;
  /** Skip balance checks (for testing only). Default: false */
  skipBalanceCheck?: boolean;
  /** Override the balance monitor with a mock (for testing only). */
  _balanceMonitorOverride?: AnyBalanceMonitor;
  /**
   * Session persistence config. When enabled, maintains model selection
   * across requests within a session to prevent mid-task model switching.
   */
  sessionConfig?: Partial<SessionConfig>;
  /**
   * Auto-compress large requests to reduce network usage.
   * When enabled, requests are automatically compressed using
   * LLM-safe context compression (15-40% reduction).
   * Default: true
   */
  autoCompressRequests?: boolean;
  /**
   * Threshold in KB to trigger auto-compression (default: 180).
   * Requests larger than this are compressed before sending.
   * Set to 0 to compress all requests.
   */
  compressionThresholdKB?: number;
  /**
   * Response caching config. When enabled, identical requests return
   * cached responses instead of making new API calls.
   * Default: enabled with 10 minute TTL, 200 max entries.
   */
  cacheConfig?: ResponseCacheConfig;
  /**
   * Maximum total spend (in USD) per session run.
   * Default: undefined (no limit). Example: 0.5 = $0.50 per session.
   */
  maxCostPerRunUsd?: number;
  /**
   * How to enforce the per-run cost cap.
   * - 'graceful' (default): when budget runs low, downgrade to cheaper models; use free model
   *   as last resort. Only hard-stops when no model can serve the request.
   * - 'strict': immediately return 429 once the session spend reaches the cap.
   */
  maxCostPerRunMode?: "graceful" | "strict";
  /**
   * Set of model IDs to exclude from routing.
   * Excluded models are filtered out of fallback chains.
   * Loaded from ~/.openclaw/blockrun/exclude-models.json
   */
  excludeModels?: Set<string>;
  onReady?: (port: number) => void;
  onError?: (error: Error) => void;
  onPayment?: (info: { model: string; amount: string; network: string }) => void;
  onRouted?: (decision: RoutingDecision) => void;
  /** Local comparison only; it never changes the serving request or sends another completion. */
  onShadowRouted?: (comparison: {
    executed: RoutingDecision;
    shadow: RoutingDecision;
    sameModel: boolean;
    hasTools: boolean;
    hasVision: boolean;
    requiresStructuredOutput: boolean;
  }) => void;
  /** Called when balance drops below $1.00 (warning, request still proceeds) */
  onLowBalance?: (info: LowBalanceInfo) => void;
  /** Called when balance is insufficient for a request (request fails) */
  onInsufficientFunds?: (info: InsufficientFundsInfo) => void;
  /**
   * Spend / counterparty policy. Default: FileSpendControlStorage at
   * ~/.openclaw/blockrun/spending.json. Inject in tests.
   */
  spendControl?: SpendControl;
  /**
   * Upstream proxy URL for all outgoing requests.
   * Supports http://, https://, and socks5:// schemes.
   * Also readable via BLOCKRUN_UPSTREAM_PROXY environment variable.
   * Example: "socks5://127.0.0.1:1080"
   */
  upstreamProxy?: string;
};

export type ProxyHandle = {
  port: number;
  baseUrl: string;
  /** The x402 signer's address, or "" in API-key mode (there is no wallet). */
  walletAddress: string;
  solanaAddress?: string;
  /** Which credential this proxy is paying with. */
  authMode: AuthMode;
  /** Masked API key, for status display. Only set in API-key mode. */
  apiKeyLabel?: string;
  balanceMonitor: AnyBalanceMonitor;
  close: () => Promise<void>;
};

/**
 * Build model pricing map from BLOCKRUN_MODELS.
 */
function buildModelPricing(): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const m of BLOCKRUN_MODELS) {
    if (m.id === AUTO_MODEL) continue; // skip meta-model
    const promoPrice = getActivePromoPrice(m);
    map.set(m.id, {
      inputPrice: m.inputPrice,
      outputPrice: m.outputPrice,
      ...(promoPrice !== undefined && { flatPrice: promoPrice }),
    });
  }
  return map;
}

function buildModelCapabilities(): Record<string, ModelCapabilities> {
  return Object.fromEntries(
    BLOCKRUN_MODELS.map((model) => [
      model.id,
      {
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutput,
        supportsTools: model.toolCalling === true,
        supportsVision: model.vision === true,
      },
    ]),
  );
}

type ModelListEntry = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  name: string;
  context_window: number;
  max_output: number;
  input_price: number;
  output_price: number;
  reasoning: boolean;
  vision: boolean;
  agentic: boolean;
  tool_calling: boolean;
};

/**
 * Build `/v1/models` response entries from the full OpenClaw model registry.
 * This includes alias IDs (e.g., `flash`, `kimi`) so `/model <alias>` works reliably.
 * The picker visibility filter lives at the openclaw.json allowlist layer, not here —
 * `/v1/models` stays open for API-level discovery.
 */
export function buildProxyModelList(
  createdAt: number = Math.floor(Date.now() / 1000),
): ModelListEntry[] {
  const seen = new Set<string>();
  return OPENCLAW_MODELS.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  }).map((model) => {
    const targetId = MODEL_ALIASES[model.id] ?? model.id;
    const canonical = BLOCKRUN_MODELS.find((entry) => entry.id === targetId);
    return {
      id: model.id,
      object: "model",
      created: createdAt,
      owned_by: targetId.includes("/") ? (targetId.split("/")[0] ?? "blockrun") : "blockrun",
      name: model.name,
      context_window: model.contextWindow,
      max_output: model.maxTokens,
      input_price: model.cost.input,
      output_price: model.cost.output,
      reasoning: model.reasoning,
      vision: model.input.includes("image"),
      agentic: canonical?.agentic ?? false,
      tool_calling: canonical?.toolCalling ?? false,
    };
  });
}

/**
 * Merge partial routing config overrides with defaults.
 */
function mergeRoutingConfig(overrides?: Partial<RoutingConfig>): RoutingConfig {
  if (!overrides) return DEFAULT_ROUTING_CONFIG;
  // Merge tier sets per-tier so users can override a single tier
  // (e.g. just COMPLEX) without having to redefine all four.
  // `null` explicitly disables a tier set (e.g. `agenticTiers: null` forces
  // all requests through regular tiers even when tools are present).
  const mergeTiers = (
    defaults: RoutingConfig["tiers"] | null | undefined,
    user: Partial<RoutingConfig["tiers"]> | null | undefined,
  ): RoutingConfig["tiers"] | null => {
    if (user === null) return null;
    if (user === undefined) return defaults ?? null;
    return { ...(defaults ?? {}), ...user } as RoutingConfig["tiers"];
  };
  return {
    ...DEFAULT_ROUTING_CONFIG,
    ...overrides,
    classifier: { ...DEFAULT_ROUTING_CONFIG.classifier, ...overrides.classifier },
    scoring: { ...DEFAULT_ROUTING_CONFIG.scoring, ...overrides.scoring },
    tiers:
      mergeTiers(DEFAULT_ROUTING_CONFIG.tiers, overrides.tiers) ?? DEFAULT_ROUTING_CONFIG.tiers,
    agenticTiers: mergeTiers(DEFAULT_ROUTING_CONFIG.agenticTiers, overrides.agenticTiers),
    ecoTiers: mergeTiers(DEFAULT_ROUTING_CONFIG.ecoTiers, overrides.ecoTiers),
    premiumTiers: mergeTiers(DEFAULT_ROUTING_CONFIG.premiumTiers, overrides.premiumTiers),
    overrides: { ...DEFAULT_ROUTING_CONFIG.overrides, ...overrides.overrides },
  };
}

/**
 * Build the `usage.cost` breakdown that ClawRouter injects into responses.
 * This uses ACTUAL token counts from the upstream usage field (not estimates)
 * and falls back to gracefully returning undefined when token counts or
 * routing info aren't available.
 *
 * OpenClaw's `session-cost-usage` module reads the standard `{total,input,output}`
 * fields. The extra fields (`baseline`, `savings_pct`, `model`, `tier`) are
 * forward-compat metadata for future OpenClaw UI or external analytics.
 *
 * Exported for unit tests.
 */
export type CostBreakdown = {
  /** Total cost in USD for this request (server-margin included). */
  total: number;
  /** Input-token cost in USD. */
  input: number;
  /** Output-token cost in USD. */
  output: number;
  /** What the baseline (Opus) would have cost for the same tokens. */
  baseline: number;
  /** Savings % vs baseline, integer 0..100. Omitted for `premium` profile. */
  savings_pct?: number;
  /** Actual model that answered (mirrors top-level `model` field). */
  model: string;
  /** Routing tier (SIMPLE / MEDIUM / COMPLEX / REASONING) if known. */
  tier?: string;
};

export function buildCostBreakdown(params: {
  actualModelUsed: string;
  routingProfile: "free" | "eco" | "auto" | "premium" | undefined;
  routingDecision: { tier?: string } | undefined;
  modelPricing: Map<string, ModelPricing>;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  tier: string | undefined;
}): CostBreakdown | undefined {
  const { actualModelUsed, routingProfile, modelPricing, inputTokens, outputTokens, tier } = params;
  // We need both token counts to produce meaningful actual-cost numbers.
  // If upstream didn't send usage (some providers omit it), skip cost injection
  // rather than publish misleading zero or estimate-based numbers.
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    return undefined;
  }

  const pricing = modelPricing.get(actualModelUsed);
  const inputPrice = pricing?.inputPrice ?? 0;
  const outputPrice = pricing?.outputPrice ?? 0;
  const input = (inputTokens / 1_000_000) * inputPrice;
  const output = (outputTokens / 1_000_000) * outputPrice;

  // Use calculateModelCost to get server-margin-adjusted total and baseline
  // with the same logic as the pre-request estimator. This keeps total and
  // baseline internally consistent (same margin, same min-payment floor).
  const costs = calculateModelCost(
    actualModelUsed,
    modelPricing,
    inputTokens,
    outputTokens,
    routingProfile,
  );

  const total = costs.costEstimate;
  const baseline = costs.baselineCost;
  const savingsPct =
    routingProfile === "premium" || baseline <= 0
      ? undefined
      : Math.max(0, Math.min(100, Math.round(costs.savings * 100)));

  return {
    total,
    input,
    output,
    baseline,
    ...(savingsPct !== undefined ? { savings_pct: savingsPct } : {}),
    model: actualModelUsed,
    ...(tier ? { tier } : {}),
  };
}

/** Model lookup by id — estimateAmount runs in per-request loops (the budget
 *  pre-check scans every model), so a linear find would be O(n²) per request. */
const BLOCKRUN_MODEL_BY_ID = new Map(BLOCKRUN_MODELS.map((m) => [m.id, m]));

// Re-exported so `proxy.js` stays the single import surface for proxy internals.
export { DEFAULT_MAX_TOKENS, resolveMaxTokens } from "./max-tokens.js";

/**
 * Estimate USDC cost for a request based on model pricing.
 * Returns amount string in USDC smallest unit (6 decimals) or undefined if unknown.
 */
export function estimateAmount(
  modelId: string,
  bodyLength: number,
  maxTokens: number,
): string | undefined {
  const model = BLOCKRUN_MODEL_BY_ID.get(modelId);
  if (!model) return undefined;

  let costUsd: number;
  const promoPrice = getActivePromoPrice(model);
  if (promoPrice !== undefined) {
    // Active promo: fixed cost per request, no token estimation needed
    costUsd = promoPrice;
  } else {
    // Rough estimate: ~4 chars per token for input
    const estimatedInputTokens = Math.ceil(bodyLength / 4);
    const estimatedOutputTokens = maxTokens || model.maxOutput || 4096;
    costUsd =
      (estimatedInputTokens / 1_000_000) * model.inputPrice +
      (estimatedOutputTokens / 1_000_000) * model.outputPrice;
  }

  // blockrun charges a flat $0.001 per-transaction fee on every PAID product
  // (covers gas; included in the server's 402 quote). Introduced at $0.002 on
  // 2026-07-14, reverted to $0.001 on 2026-07-29 (blockrun #319). Mirror it so
  // balance pre-checks and usage logs track what the gateway actually charges.
  // Free models ($0 estimate) never pay it.
  if (costUsd > 0) costUsd += 0.001;

  // Convert to USDC 6-decimal integer, add 20% buffer for estimation error
  // Minimum 1000 ($0.001) to match CDP Facilitator's enforced minimum payment
  const amountMicros = Math.max(1000, Math.ceil(costUsd * 1.2 * 1_000_000));
  return amountMicros.toString();
}

export function estimateBalancePreflightAmount(
  modelId: string,
  bodyLength: number,
  maxTokens: number,
): string | undefined {
  // Clients like OpenClaw may send the model's huge default max output
  // (for example 128k) even when the user did not request that much output.
  // Keep this as a preflight-only spend estimate; the real request is unchanged
  // and x402 still enforces the actual server quote.
  const preflightMaxTokens = Math.min(
    maxTokens || BALANCE_PREFLIGHT_OUTPUT_TOKEN_CAP,
    BALANCE_PREFLIGHT_OUTPUT_TOKEN_CAP,
  );
  return estimateAmount(modelId, bodyLength, preflightMaxTokens);
}

// Image pricing table (must match server's IMAGE_MODELS in blockrun/src/lib/models.ts)
// Server applies 5% margin on top of these prices.
const IMAGE_PRICING: Record<string, { default: number; sizes?: Record<string, number> }> = {
  "openai/gpt-image-1": {
    default: 0.02,
    sizes: { "1024x1024": 0.02, "1536x1024": 0.04, "1024x1536": 0.04 },
  },
  "openai/gpt-image-2": {
    default: 0.06,
    sizes: { "1024x1024": 0.06, "1536x1024": 0.12, "1024x1536": 0.12 },
  },
  "bytedance/seedream-5-pro": {
    default: 0.045,
    // Full size list live-probed 2026-08-23 (gateway 402 quotes, base price):
    // the 2K portrait/landscape tiers bill at the 2048x2048 rate.
    sizes: {
      "1024x1024": 0.045,
      "1280x720": 0.045,
      "2048x1024": 0.045,
      "2048x2048": 0.09,
      "2304x1728": 0.09,
      "1728x2304": 0.09,
      "2848x1600": 0.09,
      "1600x2848": 0.09,
    },
  },
  "google/nano-banana": { default: 0.05, sizes: { "1024x1024": 0.05 } },
  // Nano Banana 2 (Gemini 3.1 Flash imagegen, blockrun #329): $0.09/image at 1K.
  "google/nano-banana-2": { default: 0.09, sizes: { "1024x1024": 0.09 } },
  "google/nano-banana-pro": {
    default: 0.1,
    sizes: { "1024x1024": 0.1, "2048x2048": 0.1, "4096x4096": 0.15 },
  },
  "xai/grok-imagine-image": { default: 0.02, sizes: { "1024x1024": 0.02 } },
  "xai/grok-imagine-image-pro": { default: 0.07, sizes: { "1024x1024": 0.07 } },
  "zai/cogview-4": {
    default: 0.015,
    sizes: {
      "512x512": 0.015,
      "768x768": 0.015,
      "1024x1024": 0.015,
      "768x1344": 0.015,
      "1344x768": 0.015,
      "1440x1440": 0.02,
    },
  },
};

/**
 * Image model ids the gateway can actually serve, in IMAGE_PRICING declaration
 * order (the picker in index.ts curates its own order — default model first —
 * so the pinning test compares sorted copies).
 *
 * Derived from IMAGE_PRICING, which v0.12.227 re-synced against blockrun's
 * IMAGE_MODELS — so an id missing here is an id the gateway will reject.
 * Exported so the image picker advertised by buildImageGenerationProvider
 * (index.ts) can be pinned against it: the picked id is forwarded to
 * /v1/images/generations verbatim, with no alias resolution in between.
 */
export const IMAGE_MODEL_IDS: readonly string[] = Object.freeze(Object.keys(IMAGE_PRICING));

/**
 * Union of every size the gateway accepts across all image models, live-probed
 * 2026-08-23 (the gateway rejects invalid sizes pre-payment with the model's
 * accepted list). Derived from the per-model `sizes` maps above, which mirror
 * those probes — every model entry now carries its full accepted-size map.
 * Pins the `geometry.sizes` list advertised by buildImageGenerationProvider
 * (index.ts): a size listed there that no model accepts is a guaranteed 400.
 */
export const IMAGE_MODEL_SIZES: readonly string[] = Object.freeze(
  [...new Set(Object.values(IMAGE_PRICING).flatMap((p) => Object.keys(p.sizes ?? {})))].sort(),
);

/**
 * Shorthand → full-id aliases for the `/cr-imagegen` chat command. Module-scope
 * and exported so tests can pin every target against IMAGE_MODEL_IDS — an alias
 * pointing at a delisted id is the same guaranteed-400 drift class the picker
 * test guards against.
 */
export const IMAGE_MODEL_ALIASES: Record<string, string> = Object.freeze({
  // dall-e-3 delisted upstream 2026-05-25 — legacy aliases route to
  // the OpenAI successor instead of a guaranteed 400.
  "dall-e-3": "openai/gpt-image-2",
  dalle3: "openai/gpt-image-2",
  dalle: "openai/gpt-image-2",
  "gpt-image": "openai/gpt-image-1",
  "gpt-image-1": "openai/gpt-image-1",
  "gpt-image-2": "openai/gpt-image-2",
  seedream: "bytedance/seedream-5-pro",
  banana: "google/nano-banana",
  "nano-banana": "google/nano-banana",
  "banana-2": "google/nano-banana-2",
  "nano-banana-2": "google/nano-banana-2",
  "banana-pro": "google/nano-banana-pro",
  "nano-banana-pro": "google/nano-banana-pro",
  "grok-imagine": "xai/grok-imagine-image",
  "grok-imagine-pro": "xai/grok-imagine-image-pro",
  cogview: "zai/cogview-4",
});

// Video pricing (must match server's VIDEO_MODELS in blockrun/src/lib/models.ts).
// pricePerSecond is the BASE rate (no margin). estimateVideoCost applies the
// same 5% margin server-side uses, so values land on blockrun's quote.
// Seedance is token-priced upstream — base $/sec = tokensPerSec × $/1M tokens.
// As of blockrun e6dc1f1 (2026-05-22) the videos route defaults Seedance to
// resolution=720p + generate_audio=true(t2v) / false(i2v), which doubles the
// per-second token count from 10128 → 20256 vs. the older 480p baseline.
// pricePerSecondImageInput, when set, is used if the request body has image_url.
// Since blockrun 403e61e (2026-06-01) image-to-video is NOT discounted upstream
// (only video-to-video is cheaper) — i2v rates equal the text rates.
// Telemetry-only caveat: blockrun's RESOLUTION_TOKEN_FACTOR (1080p = 2.25×) is
// not modeled here, so non-720p clips under-log; payment is server-dictated.
const VIDEO_PRICING: Record<
  string,
  {
    pricePerSecond: number;
    pricePerSecondImageInput?: number;
    defaultDurationSeconds: number;
  }
> = {
  "xai/grok-imagine-video": { pricePerSecond: 0.05, defaultDurationSeconds: 8 },
  // Seedance rates re-synced 2026-08-08 from blockrun's models.ts after the
  // family reprice (blockrun #351/#354). All three were carrying pre-reprice
  // numbers, which only ever skewed the usage log — the charge comes from the
  // x402 header, and estimateVideoCost is the fallback for when it is absent.
  "bytedance/seedance-1.5-pro": { pricePerSecond: 0.07, defaultDurationSeconds: 5 },
  "bytedance/seedance-2.0-fast": {
    pricePerSecond: 0.165,
    defaultDurationSeconds: 5,
  },
  "bytedance/seedance-2.0": {
    pricePerSecond: 0.227,
    defaultDurationSeconds: 5,
  },
  // Seedance 2.0 Mini (blockrun #366/#368, 2026-08-12): 720p + synced audio at
  // half the flagship rate, 480p/720p only, 4–15s. blockrun signs the 3dp-floored
  // per-second value (0.079, not the raw 0.0797) — mirror the signed number.
  "bytedance/seedance-2.0-mini": {
    pricePerSecond: 0.079,
    defaultDurationSeconds: 5,
  },
  // Seedance 2.5: 720p with synced audio, up to 30s. Not a replacement for 2.0
  // Pro — that is still the one for 1080p/4K. No OpenRouter failover exists for
  // 2.5, so a token360 outage surfaces as an error instead of quietly rendering
  // on another model.
  "bytedance/seedance-2.5": {
    pricePerSecond: 0.315,
    defaultDurationSeconds: 5,
  },
  // Sora 2 via Azure AI Foundry — flat $0.10/s for both t2v and i2v.
  "azure/sora-2": { pricePerSecond: 0.1, defaultDurationSeconds: 4 },
};

// Phone & Voice pricing (must match server's PHONE_PRICING/BLAND_PRICING in
// blockrun/src/lib/twilio.ts + bland.ts). Keys are server-side operation paths
// relative to /v1/. estimatePhoneCost() does longest-prefix matching so
// `/v1/voice/call/abc123` (poll URL) resolves to the same $0.54 row as the
// initiating POST — actual cost is read from the x402 payment header when
// available, this table is just the telemetry fallback for the rare path
// where paymentStore is empty.
const PHONE_PRICING: Record<string, number> = {
  "phone/lookup/fraud": 0.05,
  "phone/lookup": 0.01,
  "phone/numbers/buy": 5.0,
  "phone/numbers/renew": 5.0,
  "phone/numbers/list": 0.001,
  "phone/numbers/release": 0,
  "voice/call": 0.54,
};

export function estimatePhoneCost(urlPath: string): number {
  const op = urlPath.replace(/^\/v1\//, "").split("?")[0];
  // Sort by length desc so /phone/lookup/fraud wins over /phone/lookup.
  for (const key of Object.keys(PHONE_PRICING).sort((a, b) => b.length - a.length)) {
    if (op === key || op.startsWith(`${key}/`)) return PHONE_PRICING[key];
  }
  return 0.05; // safe fallback for unknown phone/voice operation
}

/**
 * Resolve the telemetry-only cost to log for a /v1/phone or /v1/voice request.
 *
 * Logging policy (telemetry only — actual settlement is always server-dictated via x402):
 *
 *  1. If we captured an actual x402 payment amount > 0, use that — the
 *     authoritative truth from the payment header.
 *  2. Otherwise (paymentStore empty: cached pre-auth, FREE endpoints, or
 *     failed settlement), fall back to PHONE_PRICING **only when all three
 *     gates hold**:
 *       • the request is to /v1/phone or /v1/voice (`isPhone`)
 *       • the upstream returned 2xx (so settlement plausibly succeeded)
 *       • the method was POST (the GET `/v1/voice/call/{id}` poll endpoint is
 *         FREE upstream — without this gate every transcript poll would be
 *         miscounted as another $0.54 voice call)
 *  3. Else log $0 — never inflate stats with phantom charges the wallet didn't see.
 */
export function resolvePhoneTelemetryCost(args: {
  paidAmount: number;
  isPhone: boolean;
  upstreamStatus: number;
  method: string | undefined;
  urlPath: string;
}): number {
  if (args.paidAmount > 0) return args.paidAmount;
  const upstreamSucceeded = args.upstreamStatus >= 200 && args.upstreamStatus < 300;
  const isPostRequest = (args.method ?? "").toUpperCase() === "POST";
  if (args.isPhone && upstreamSucceeded && isPostRequest) {
    return estimatePhoneCost(args.urlPath);
  }
  return args.paidAmount;
}

/**
 * Estimate the cost of a video generation request (pricePerSecond × duration + 5% margin).
 * When hasImageInput=true and the model has a discounted image rate, use that instead.
 */
function estimateVideoCost(
  model: string,
  durationSeconds?: number,
  hasImageInput?: boolean,
): number {
  const p = VIDEO_PRICING[model];
  if (!p) return 0.4 * 1.05; // fallback: ~$0.40/clip + margin
  const dur = durationSeconds ?? p.defaultDurationSeconds;
  const rate =
    hasImageInput && p.pricePerSecondImageInput ? p.pricePerSecondImageInput : p.pricePerSecond;
  return rate * dur * 1.05;
}

/**
 * Estimate the cost of an image generation/editing request.
 * Matches server-side calculateImagePrice() including 5% margin.
 */
function estimateImageCost(model: string, size?: string, n: number = 1): number {
  const pricing = IMAGE_PRICING[model];
  if (!pricing) return 0.04 * n * 1.05; // fallback: assume $0.04/image + margin
  const sizePrice = size && pricing.sizes ? pricing.sizes[size] : undefined;
  const pricePerImage = sizePrice ?? pricing.default;
  return pricePerImage * n * 1.05; // 5% server margin
}

/**
 * Proxy a paid BlockRun data request through x402 payment flow.
 *
 * Used for partner endpoints (/v1/partner/*, /v1/pm/*), market data
 * (/v1/stocks/*, /v1/usstock/*, /v1/crypto/*, /v1/fx/*, /v1/commodity/*),
 * wallet-backed data tools such as BlockRun Exa (/v1/exa/*), and the Surf
 * unified crypto data API (/v1/surf/*). No smart routing, SSE, compression,
 * or sessions — just collect body, forward via payFetch (which handles 402
 * automatically), and stream back.
 */
/**
 * The gateway's id for a response, from `x-blockrun-request-id`.
 *
 * Undefined when the response never came from BlockRun (a locally served cache
 * hit, a refusal) — recorded in the usage journal as the join key for billing
 * reconciliation. See UsageEntry.requestId.
 */
function blockrunRequestId(response: Response | undefined): string | undefined {
  if (!response) return undefined;
  // The three gateways do NOT agree on the header name, and reading only the
  // BlockRun-prefixed one meant this returned undefined on both wallet rails —
  // so the reconciliation join key was always empty in wallet mode, and a
  // failing paid call on Solana had no id to report (ClawRouter-Hermes#38).
  // Measured 2026-09-05:
  //   api.blockrun.ai   x-blockrun-request-id, x-request-id, request-id
  //   sol.blockrun.ai   x-request-id only
  //   blockrun.ai       none at all — Base publishes no id, so undefined here
  //                     is the honest answer rather than a bug to work around.
  for (const name of ["x-blockrun-request-id", "x-request-id", "request-id"]) {
    const value = response.headers.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Remaining account credit, from `x-blockrun-credit-remaining-usd`.
 *
 * Same contract as the cost header: absent means "nothing to report", never
 * zero. The gateway omits it entirely on ungated accounts — which have no
 * allowance to run down — and a genuine zero balance is written "0.000000". A
 * client that read absence as 0 would refuse to call on behalf of an account
 * with no limit at all, which is the failure this header exists to prevent,
 * inverted. So this returns `number | undefined`, like its sibling.
 *
 * The gateway derives it net of every concurrent in-flight hold, so it can
 * understate what is left but never overstate it. For a warning that is the
 * right error direction: warn slightly early under concurrency, never too late.
 */
function gatewayRemainingCreditUsd(response: Response | undefined): number | undefined {
  const raw = response?.headers.get("x-blockrun-credit-remaining-usd");
  if (raw === null || raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined; // Number("") is 0, not NaN
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * What a MEDIA call actually cost, in priority order.
 *
 * The media branches used `paymentStore.getStore()?.amountUsd ?? <estimate>`,
 * and `??` does not catch 0. On the API-key rail no x402 payment happens, the
 * store reports 0, and `0 ?? estimate` is 0 — so every image, img2img, audio and
 * video call was journaled at $0 and `/stats` showed `IMAGE: {count: 4, cost: 0}`
 * while the account was really charged $0.0525 each. Same shape as the 152x
 * chat bug in the other direction: spend that silently is not there.
 *
 * These routes are luckier than the rest: the gateway puts the settled amount in
 * the response body as `price.amount`, so the true figure is available even
 * where the cost header is not.
 *
 *   1. `x-blockrun-cost-usd` — the gateway's settled charge
 *   2. `price.amount` in the response body — same number, media routes carry it
 *   3. a non-zero x402 payment — the wallet rail's real amount
 *   4. the local estimate — last resort, and the only one that can be wrong
 */
function settledMediaCostUsd(
  upstream: Response | undefined,
  body: unknown,
  x402AmountUsd: number | undefined,
  estimate: number,
): number {
  const header = gatewaySettledCostUsd(upstream);
  if (header !== undefined) return header;
  const price = (body as { price?: { amount?: unknown } } | undefined)?.price?.amount;
  if (typeof price === "string" || typeof price === "number") {
    const parsed = Number(price);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  if (typeof x402AmountUsd === "number" && x402AmountUsd > 0) return x402AmountUsd;
  return estimate;
}

/**
 * Declare what the dispatch about to happen is expected to cost, in USD.
 *
 * Read and cleared by the API-key rail's spend-window wrapper (`withSpendPolicy`),
 * so it must be published immediately before a BILLABLE upstream call and never
 * before a status poll — an unpublished dispatch is treated as free, which is
 * what keeps an async media job from being charged once at submit and again on
 * the poll that completes it. Pass 0 for routes ClawRouter cannot price locally
 * (flat-priced partner endpoints); the gateway's settled charge then governs.
 *
 * A no-op on the wallet rail, where the 402 quote is the authority.
 */
function publishDispatchCost(usd: number): void {
  const store = paymentStore.getStore();
  if (store) store.estimatedUsd = Number.isFinite(usd) && usd > 0 ? usd : 0;
}

/** $1.00, matching the wallet rail's low-balance threshold. */
const LOW_CREDIT_USD = 1.0;
/** Warn on a threshold crossing, not per call; re-arms when credit goes back up. */
let lowCreditWarned = false;

/**
 * Warn before the account runs out, rather than after.
 *
 * Until the gateway published a remaining figure a card-paying user had no
 * warning at all: the first sign of trouble was a request failing with 402.
 * Wallet users have had a live balance all along. Fires once per crossing so a
 * busy agent does not get the same line on every call, and re-arms after a
 * top-up so the next drop is reported.
 */
function noteRemainingCredit(response: Response | undefined): void {
  const remaining = gatewayRemainingCreditUsd(response);
  if (remaining === undefined) return; // ungated account, or nothing to report
  if (remaining > LOW_CREDIT_USD) {
    lowCreditWarned = false;
    return;
  }
  if (lowCreditWarned) return;
  lowCreditWarned = true;
  console.warn(
    remaining <= 0
      ? `[ClawRouter] ⚠ BlockRun account credit is exhausted — calls will fail with 402. Top up: ${PORTAL_CREDITS_URL}`
      : `[ClawRouter] ⚠ BlockRun account credit low: $${remaining.toFixed(2)} remaining. Top up: ${PORTAL_CREDITS_URL}`,
  );
}

/**
 * The amount BlockRun actually settled for this response, from
 * `x-blockrun-cost-usd`, or undefined when the header is absent.
 *
 * Absent is NOT zero — the gateway writes a genuine zero charge as "0.000000"
 * and omits the header when nothing settled at response time (the chat path,
 * where the charge commits after the response, and async media billed on a
 * later settlement). Callers must fall back rather than record $0, so a value
 * of exactly 0 has to stay distinguishable from a missing header; that is why
 * this returns `number | undefined` and not a defaulted number.
 *
 * A malformed or negative value is treated as absent: an unparseable charge is
 * not evidence of a free call, and letting NaN through would poison every
 * total computed from the journal.
 */
function gatewaySettledCostUsd(response: Response | undefined): number | undefined {
  const raw = response?.headers.get("x-blockrun-cost-usd");
  if (raw === null || raw === undefined) return undefined;
  const trimmed = raw.trim();
  // Number("") is 0, not NaN — an empty header would otherwise read as a
  // settled zero charge, which is the exact confusion this header exists to
  // avoid, and would record $0 against a call that really was billed.
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

async function proxyPaidApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apiBase: string,
  payFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  getActualPaymentUsd: () => number,
  accountPassthrough = false,
  authMode: AuthMode = "wallet",
): Promise<void> {
  const startTime = Date.now();
  const upstreamUrl = `${apiBase}${req.url}`;
  const isBlockrunExa = req.url?.startsWith("/v1/exa/") ?? false;
  const isModalSandbox = req.url?.startsWith("/v1/modal/") ?? false;
  const isPhone =
    (req.url?.startsWith("/v1/phone/") ?? false) || (req.url?.startsWith("/v1/voice/") ?? false);
  const isSurf = req.url?.startsWith("/v1/surf/") ?? false;
  const requestLabel = isBlockrunExa
    ? "BlockRun Exa"
    : isModalSandbox
      ? "Modal Sandbox"
      : isPhone
        ? "Phone/Voice"
        : isSurf
          ? "Surf"
          : "Partner";

  // Collect request body
  const bodyChunks: Buffer[] = [];
  for await (const chunk of req) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(bodyChunks);

  // Forward headers (strip hop-by-hop + SDK/provider-specific)
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      key === "host" ||
      key === "connection" ||
      key === "transfer-encoding" ||
      key === "content-length"
    )
      continue;
    if (key.startsWith("x-stainless-") || key.startsWith("anthropic-")) continue;
    if (typeof value === "string") headers[key] = value;
  }
  if (!headers["content-type"]) headers["content-type"] = "application/json";
  headers["user-agent"] = USER_AGENT;

  console.log(`[ClawRouter] ${requestLabel} request: ${req.method} ${req.url}`);

  // Cancel the upstream call (and its payment) if the client disconnects.
  const clientAbort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) clientAbort.abort();
  });

  // Billable, but ClawRouter has no local price for partner endpoints — publish
  // 0 and let the gateway's settled charge feed the windows.
  publishDispatchCost(0);
  const upstream = await payFetch(upstreamUrl, {
    method: req.method ?? "POST",
    headers,
    body: body.length > 0 ? new Uint8Array(body) : undefined,
    signal: clientAbort.signal,
  });

  // Forward response headers. content-length must be dropped along with
  // content-encoding: fetch transparently decompresses the body, so the
  // upstream length describes the compressed bytes — forwarding it would
  // truncate the decompressed response. Node falls back to chunked encoding.
  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (
      key === "transfer-encoding" ||
      key === "connection" ||
      key === "content-encoding" ||
      key === "content-length"
    )
      return;
    responseHeaders[key] = value;
  });

  // An authenticated account response must never be cached: caches downstream
  // key on the URL, not the credential, so switching API keys on one proxy port
  // could otherwise serve one account's data to another — `/v1/phone/numbers`
  // answers "which numbers do I own", and upstream marks it public/max-age.
  //
  // Keyed on the CREDENTIAL, not on which route handled the request. The
  // partner prefixes (/v1/phone, /v1/surf, /v1/pm, ...) are matched before the
  // generic account passthrough and would otherwise keep the upstream's caching
  // headers while still being account-authenticated.
  if (accountPassthrough || authMode === "api-key") {
    responseHeaders["cache-control"] = "no-store";
  }
  res.writeHead(upstream.status, responseHeaders);

  if (accountPassthrough) {
    // Stream rather than buffer, so these routes keep their native payload,
    // status and SSE contract instead of arriving all at once.
    //
    // NOTE: this deliberately does NOT skip the usage log below. Account billing
    // is authoritative in the portal, but a local journal that silently omits
    // paid calls is how Surf/Exa/prediction-market spend became invisible in
    // `/stats` on this rail in the first place (fixed in 934bea4). The gateway
    // now returns `x-blockrun-cost-usd`, so the charge is knowable here and
    // there is no longer a reason to drop the row.
    if (upstream.body) {
      await pipeline(
        Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>),
        res,
        { signal: clientAbort.signal },
      );
    } else {
      res.end();
    }
  } else {
    // Stream response body
    if (upstream.body) {
      const chunks = await readBodyWithTimeout(upstream.body, ERROR_BODY_READ_TIMEOUT_MS);
      for (const chunk of chunks) {
        safeWrite(res, Buffer.from(chunk));
      }
    }
    res.end();
  }

  const latencyMs = Date.now() - startTime;
  console.log(`[ClawRouter] ${requestLabel} response: ${upstream.status} (${latencyMs}ms)`);

  // Log paid tool usage with the actual amount charged.
  //
  // On the wallet rail that is the x402 payment. On the API-key rail no x402
  // ever happens, so this was 0 for every paid partner call — Surf, Exa,
  // prediction markets, images, speech all landed in the journal at $0 and were
  // invisible in `/stats`. That is the mirror of the 152x chat overstatement:
  // there we inherited an x402 cost model that did not apply, here we inherited
  // an x402 payment that never occurs. Unlike chat we have no local price model
  // for these services, so the gateway's own figure is the only truthful source.
  //
  // BlockRun publishes it as `x-blockrun-cost-usd` on pre-priced (non-chat)
  // services. Its contract, per the gateway: ABSENT means "no charge settled at
  // the time of the response", NOT "this call was free" — a charge that really
  // is zero is written explicitly as 0.000000. So absence must fall back to the
  // previous behaviour rather than assert $0, or async media (billed on a later
  // settlement) would be under-counted instead of over-counted.
  //
  // Phone/voice telemetry rules — see resolvePhoneTelemetryCost.
  noteRemainingCredit(upstream);
  const settledCostUsd = gatewaySettledCostUsd(upstream);
  const paidAmount = settledCostUsd ?? getActualPaymentUsd();
  const requestCost =
    settledCostUsd !== undefined
      ? settledCostUsd
      : resolvePhoneTelemetryCost({
          paidAmount,
          isPhone,
          upstreamStatus: upstream.status,
          method: req.method,
          urlPath: req.url ?? "",
        });
  logUsage({
    timestamp: new Date().toISOString(),
    ...(blockrunRequestId(upstream) ? { requestId: blockrunRequestId(upstream) } : {}),
    model: isBlockrunExa
      ? "blockrun-exa"
      : isModalSandbox
        ? "modal-sandbox"
        : isPhone
          ? (req.url ?? "").replace(/^\/v1\//, "").split("?")[0] // e.g. "phone/lookup", "voice/call"
          : isSurf
            ? (req.url ?? "").replace(/^\/v1\//, "").split("?")[0] // e.g. "surf/onchain/sql"
            : "partner",
    tier: isPhone ? "PHONE" : isSurf ? "SURF" : "PARTNER",
    cost: requestCost,
    baselineCost: requestCost,
    savings: 0,
    latencyMs,
    partnerId:
      (req.url?.split("?")[0] ?? "").replace(/^\/v1\//, "").replace(/\//g, "_") || "unknown",
    service: isBlockrunExa
      ? "web_search"
      : isModalSandbox
        ? "modal"
        : isPhone
          ? "phone"
          : isSurf
            ? "surf"
            : "partner",
  }).catch(() => {});
}

/**
 * Read a local image file and return it as a base64 data URI.
 * Supports ~/ home directory expansion.
 */
function readImageFileAsDataUri(filePath: string): string {
  const resolved = filePath.startsWith("~/") ? join(homedir(), filePath.slice(2)) : filePath;

  if (!existsSync(resolved)) {
    throw new Error(`Image file not found: ${resolved}`);
  }

  const ext = resolved.split(".").pop()?.toLowerCase() ?? "png";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  };
  const mime = mimeMap[ext] ?? "image/png";
  const data = readFileSync(resolved);
  return `data:${mime};base64,${data.toString("base64")}`;
}

/**
 * Upload a base64 data URI to catbox.moe and return a public URL.
 * Google image models (nano-banana) return data URIs instead of hosted URLs,
 * which breaks Telegram and other clients that can't render raw base64.
 */
async function uploadDataUriToHost(dataUri: string): Promise<string> {
  const match = dataUri.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) throw new Error("Invalid data URI format");
  const [, mimeType, b64Data] = match;
  const ext = mimeType === "image/jpeg" ? "jpg" : (mimeType.split("/")[1] ?? "png");

  const buffer = Buffer.from(b64Data, "base64");
  const blob = new Blob([buffer], { type: mimeType });

  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("fileToUpload", blob, `image.${ext}`);

  const uploadController = new AbortController();
  const uploadTimeout = setTimeout(() => uploadController.abort(), 30_000);
  try {
    const resp = await fetch("https://catbox.moe/user/api.php", {
      method: "POST",
      body: form,
      signal: uploadController.signal,
    });

    if (!resp.ok) throw new Error(`catbox.moe upload failed: HTTP ${resp.status}`);
    const result = await resp.text();
    if (result.startsWith("https://")) {
      return result.trim();
    }
    throw new Error(`catbox.moe upload failed: ${result}`);
  } finally {
    clearTimeout(uploadTimeout);
  }
}

/**
 * Tell the operator which parts of `clawrouter policy` cannot fire on this rail.
 *
 * Since #329 the amount windows DO hold on the API-key rail — `withSpendPolicy`
 * enforces them at the dispatch boundary, reading the same `spending.json`. What
 * still cannot fire are the counterparty lists: `blockedPayees`,
 * `allowedPayees`, `allowedNetworks` and `allowedAssets` each presuppose a
 * payee, a network and an on-chain asset, and account credit has one
 * counterparty and no asset. They are vacuous here, not merely disabled — but an
 * operator who configured one is entitled to hear that it is not doing anything.
 *
 * Silent when none are configured, which is the common path.
 */
function warnIfSpendLimitsUnenforced(spendControl: SpendControl | undefined): void {
  let configured: string[];
  try {
    const limits = (spendControl ?? new SpendControl()).getStatus().limits;
    configured = POLICY_LISTS.filter((list) => (limits[list]?.length ?? 0) > 0);
  } catch {
    return; // an unreadable policy file is its own problem, reported elsewhere
  }
  if (configured.length === 0) return;

  console.warn(
    `[ClawRouter] \u26A0 Counterparty policy (${configured.join(", ")}) does not apply in API-key mode — there is one counterparty and no on-chain asset.`,
  );
  console.warn(
    `[ClawRouter]   Your perRequest/hourly/daily/session limits DO apply here and are enforced per call.`,
  );
}

/**
 * Refuse to attach to a proxy that is not billing what this process configured.
 *
 * Two paths reach an already-running proxy: the pre-listen probe, and the
 * EADDRINUSE race when another process wins the bind between that probe and
 * `listen()`. Only the first one checked credentials, so the race path could
 * hand an API-key caller a wallet proxy — the caller believes it is billing
 * account credit while every request spends USDC, and the handle it gets back
 * even reports `authMode: "api-key"` and the key's label. Both paths validate
 * here so the rule is one rule and not two.
 *
 * The three refusals, all for the same reason (reuse would spend money the
 * caller did not mean to spend):
 *
 *   - a different auth mode: the two rails bill different accounts from
 *     different hosts
 *   - a different API key: `clawrouter login` with a second key on a port
 *     already serving the first used to attach silently, and every request was
 *     charged to the old account. An older proxy that reports no label cannot
 *     be verified, and an unverifiable credential on a money path is refused
 *     rather than assumed to match.
 *   - a different payment chain: a different signer and a different gateway
 */
function assertExistingProxyBillsUs(
  existing: { wallet: string; paymentChain?: string; authMode: AuthMode; apiKeyLabel?: string },
  requested: {
    listenPort: number;
    authMode: AuthMode;
    apiKeyLabel?: string;
    paymentChain: string;
  },
): void {
  const { listenPort } = requested;
  const describe = (mode: AuthMode) => (mode === "api-key" ? "a BlockRun API key" : "a wallet");

  if (existing.authMode !== requested.authMode) {
    throw new Error(
      `Existing proxy on port ${listenPort} is authenticating with ${describe(existing.authMode)} but ${describe(requested.authMode)} was requested. ` +
        `Stop the existing proxy first or use a different port.`,
    );
  }

  if (requested.authMode === "api-key") {
    if (existing.apiKeyLabel !== requested.apiKeyLabel) {
      throw new Error(
        `Existing proxy on port ${listenPort} is billing ${existing.apiKeyLabel ?? "an unidentified BlockRun account"}, ` +
          `but this process is configured for ${requested.apiKeyLabel}. Reusing it would charge the other account. ` +
          `Stop that proxy first, or use a different port.`,
      );
    }
    return;
  }

  if (existing.paymentChain) {
    if (existing.paymentChain !== requested.paymentChain) {
      throw new Error(
        `Existing proxy on port ${listenPort} is using ${existing.paymentChain} but ${requested.paymentChain} was requested. ` +
          `Stop the existing proxy first or use a different port.`,
      );
    }
  } else if (requested.paymentChain !== "base") {
    // Old proxy doesn't report chain — assume Base. Reject if Solana was requested.
    console.warn(
      `[ClawRouter] Existing proxy on port ${listenPort} does not report paymentChain (pre-v0.11 instance). Assuming Base.`,
    );
    throw new Error(
      `Existing proxy on port ${listenPort} is a pre-v0.11 instance (assumed Base) but ${requested.paymentChain} was requested. ` +
        `Stop the existing proxy first or use a different port.`,
    );
  }
}

/**
 * Start the local x402 proxy server.
 *
 * If a proxy is already running on the target port, reuses it instead of failing.
 * Port can be configured via BLOCKRUN_PROXY_PORT environment variable.
 *
 * Returns a handle with the assigned port, base URL, and a close function.
 */
export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  // Apply upstream proxy (SOCKS5/HTTP) before any outgoing requests
  const upstreamProxy = await applyUpstreamProxy(options.upstreamProxy);
  if (upstreamProxy) {
    console.log(`[ClawRouter] Upstream proxy: ${upstreamProxy}`);
  }

  // An API key takes precedence over a wallet: it is the explicit, newer
  // credential, and a machine that has both (a legacy wallet plus a key the
  // user just added) means "bill my account", not "keep spending my USDC".
  const apiKey = options.apiKey?.trim() || undefined;
  if (apiKey && !isValidApiKey(apiKey)) {
    throw new Error(
      `BlockRun API key is malformed (expected it to start with "brk_"). Mint one at https://user.blockrun.ai/dashboard/keys`,
    );
  }
  const authMode: AuthMode = apiKey ? "api-key" : "wallet";
  if (!apiKey && !options.wallet) {
    throw new Error(
      `startProxy needs a credential: pass either a wallet (x402) or an apiKey (brk_…, from https://user.blockrun.ai/dashboard/keys).`,
    );
  }

  // Normalize wallet config: string = EVM-only, object = full resolution
  const walletKey =
    options.wallet === undefined
      ? undefined
      : typeof options.wallet === "string"
        ? options.wallet
        : options.wallet.key;
  const solanaPrivateKeyBytes =
    options.wallet === undefined || typeof options.wallet === "string"
      ? undefined
      : options.wallet.solanaPrivateKeyBytes;

  // Payment chain: options > env var > persisted file > default "base".
  // No dynamic switching — user selects chain via /wallet solana or /wallet base.
  // Meaningless in API-key mode (there is no chain to sign on), and reported as
  // undefined there so /health never advertises a rail this proxy cannot use.
  const paymentChain = options.paymentChain ?? (await resolvePaymentChain());
  const requestedApiBase =
    options.apiBase ??
    (authMode === "api-key"
      ? BLOCKRUN_API_KEY_API
      : paymentChain === "solana" && solanaPrivateKeyBytes
        ? BLOCKRUN_SOLANA_API
        : BLOCKRUN_API);
  // Validated once here rather than per request: an unusable account URL should
  // fail at startup, not on the first paid call.
  const apiBase = authMode === "api-key" ? normalizeApiKeyBase(requestedApiBase) : requestedApiBase;
  if (authMode === "api-key") {
    console.log(`[ClawRouter] Auth: BlockRun API key ${maskApiKey(apiKey!)} (${apiBase})`);
    console.log(`[ClawRouter] Billing: account credit — top up at ${PORTAL_CREDITS_URL}`);
    // `clawrouter policy` limits are enforced in the x402 pre-sign hook, which
    // does not exist here — there is no signature to refuse. Say so at startup
    // rather than letting an operator believe a cap they configured is live.
    // `maxCostPerRun` is unaffected: it is enforced by the router, not the signer.
    warnIfSpendLimitsUnenforced(options.spendControl);
  } else if (paymentChain === "solana" && !solanaPrivateKeyBytes) {
    console.warn(
      `[ClawRouter] ⚠ Payment chain is Solana but no mnemonic found — falling back to Base (EVM).`,
    );
    console.warn(
      `[ClawRouter]   To fix: run "npx @blockrun/clawrouter wallet recover" if your mnemonic exists,`,
    );
    console.warn(`[ClawRouter]   or run "npx @blockrun/clawrouter chain base" to switch to EVM.`);
  } else if (paymentChain === "solana") {
    console.log(`[ClawRouter] Payment chain: Solana (${BLOCKRUN_SOLANA_API})`);
  } else {
    // Base said nothing, so the one rail that never announced itself was also
    // the default. Three rails, three gateways — each should say which.
    console.log(`[ClawRouter] Payment chain: Base (${apiBase})`);
  }

  // Learn which models THIS chain's gateway serves, so the free cascade can skip
  // rungs it does not carry (the two gateways do not share a free tier). Kicked
  // off without awaiting: startup must not block on it, and until it resolves
  // every rung stays eligible, which is the old behaviour.
  void loadGatewayCatalog(apiBase, apiKey);

  // Determine port: options.port > env var > default
  const listenPort = options.port ?? getProxyPort();

  // Check if a proxy is already running on this port
  const existingProxy =
    options.allowExistingProxy === false ? undefined : await checkExistingProxy(listenPort);
  const ourApiKeyLabel = apiKey ? maskApiKey(apiKey) : undefined;
  if (existingProxy) {
    // Proxy already running — reuse it instead of failing with EADDRINUSE
    const baseUrl = `http://127.0.0.1:${listenPort}`;

    assertExistingProxyBillsUs(existingProxy, {
      listenPort,
      authMode,
      apiKeyLabel: ourApiKeyLabel,
      paymentChain,
    });

    if (authMode === "api-key") {
      options.onReady?.(listenPort);
      return {
        port: listenPort,
        baseUrl,
        walletAddress: "",
        authMode,
        apiKeyLabel: ourApiKeyLabel!,
        balanceMonitor: new ApiKeyBalanceMonitor(),
        // No-op: we didn't start this proxy, so we shouldn't close it
        close: async () => {},
      };
    }

    const account = privateKeyToAccount(walletKey as `0x${string}`);

    // Verify the existing proxy is using the same wallet (or warn if different)
    if (existingProxy.wallet !== account.address) {
      console.warn(
        `[ClawRouter] Existing proxy on port ${listenPort} uses wallet ${existingProxy.wallet}, but current config uses ${account.address}. Reusing existing proxy.`,
      );
    }

    // Derive Solana address if keys are available (for wallet status display)
    let reuseSolanaAddress: string | undefined;
    if (solanaPrivateKeyBytes) {
      const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
      const solanaSigner = await createKeyPairSignerFromPrivateKeyBytes(solanaPrivateKeyBytes);
      reuseSolanaAddress = solanaSigner.address;
    }

    // Use chain-appropriate balance monitor (lazy import to avoid loading @solana/kit on Base chain)
    let balanceMonitor: AnyBalanceMonitor;
    if (paymentChain === "solana" && reuseSolanaAddress) {
      const { SolanaBalanceMonitor } = await import("./solana-balance.js");
      balanceMonitor = new SolanaBalanceMonitor(reuseSolanaAddress);
    } else {
      balanceMonitor = new BalanceMonitor(account.address);
    }

    options.onReady?.(listenPort);

    return {
      port: listenPort,
      baseUrl,
      walletAddress: existingProxy.wallet,
      solanaAddress: reuseSolanaAddress,
      authMode,
      balanceMonitor,
      close: async () => {
        // No-op: we didn't start this proxy, so we shouldn't close it
      },
    };
  }

  // In API-key mode there is nothing to sign: no EVM account, no x402 client,
  // no spend policy hook (the policy it enforces is "which counterparty may I
  // pay", and we pay no one — the gateway bills the account server-side).
  // `account` stays undefined and every wallet-shaped field reads off it.
  const account = walletKey ? privateKeyToAccount(walletKey as `0x${string}`) : undefined;
  const x402 = authMode === "wallet" ? new x402Client() : undefined;
  if (x402 && account) {
    const evmPublicClient = createPublicClient({ chain: base, transport: http() });
    const evmSigner = toClientEvmSigner(account, evmPublicClient);
    const spendControl = options.spendControl ?? getSharedSpendControl();
    registerSpendPolicyHook(x402, spendControl);
    registerExactEvmScheme(x402, { signer: evmSigner });
  }

  // Register Solana scheme if key is available
  // Uses registerExactSvmScheme helper which registers:
  //   - solana:* wildcard (catches any CAIP-2 Solana network)
  //   - V1 compat names: "solana", "solana-devnet", "solana-testnet"
  let solanaAddress: string | undefined;
  if (x402 && solanaPrivateKeyBytes) {
    const { registerExactSvmScheme } = await import("@x402/svm/exact/client");
    const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
    const solanaSigner = await createKeyPairSignerFromPrivateKeyBytes(solanaPrivateKeyBytes);
    solanaAddress = solanaSigner.address;
    // Unlike EIP-3009 on Base, signing a Solana payment is NOT purely local:
    // the exact-SVM client reads the payment asset's mint account over RPC
    // before it can build the transfer, and with no `rpcUrl` it uses the
    // library default (api.mainnet-beta.solana.com). A host that cannot reach
    // that endpoint — blocked egress, or the public node refusing its IP —
    // fails EVERY paid Solana call with a bare "fetch failed" while the gateway
    // itself answers fine (ClawRouter-Hermes#38). Honour the same override the
    // balance monitor takes, so such a host can sign against its own RPC.
    const solanaRpcUrl = process["env"].CLAWROUTER_SOLANA_RPC_URL;
    registerExactSvmScheme(x402, { signer: solanaSigner });
    if (solanaRpcUrl) {
      // registerExactSvmScheme builds its schemes from the signer alone and
      // takes no RPC, so the override has to be applied by re-registering the
      // same keys with rpc-aware instances — a later register wins for a given
      // version+network+scheme. Everything else the helper set up stays.
      const { ExactSvmScheme } = await import("@x402/svm/exact/client");
      const { ExactSvmSchemeV1, NETWORKS: SVM_V1_NETWORKS } = await import("@x402/svm/v1");
      x402.register("solana:*", new ExactSvmScheme(solanaSigner, { rpcUrl: solanaRpcUrl }));
      for (const network of SVM_V1_NETWORKS) {
        x402.registerV1(network, new ExactSvmSchemeV1(solanaSigner, { rpcUrl: solanaRpcUrl }));
      }
    }
    console.log(`[ClawRouter] Solana wallet: ${solanaAddress}`);
    if (solanaRpcUrl) {
      console.log(`[ClawRouter] Solana RPC (payment signing + balance): ${solanaRpcUrl}`);
    }
  }

  // Stamp BlockRun's builder-code service code (`s`) onto every signed EVM
  // payment for on-chain attribution. Mirrors @x402/extensions'
  // BuilderCodeClientExtension but fires without the server having to advertise
  // the extension and needs no @x402 upgrade. The EIP-712 signature covers the
  // authorization, not the extensions, so stamping post-creation is safe. Any app
  // code (`a`) the server echoed back is preserved.
  //
  // Gated to EVM (`eip155:*`): builder-code / ERC-8021 is Ethereum-only, so
  // stamping it onto Solana (`solana:*`) payloads would attach a field the SVM
  // facilitator never expects — a no-op at best, a settlement risk at worst.
  x402?.onAfterPaymentCreation(async (context) => {
    if (!context.selectedRequirements.network.startsWith("eip155")) return;
    const payload = context.paymentPayload as {
      extensions?: Record<string, unknown>;
    };
    payload.extensions = withBuilderCodeServiceCode(payload.extensions);
  });

  // Log which chain is used for each payment and capture actual payment amount
  x402?.onAfterPaymentCreation(async (context) => {
    const network = context.selectedRequirements.network;
    const chain = network.startsWith("eip155")
      ? "Base (EVM)"
      : network.startsWith("solana")
        ? "Solana"
        : network;
    // Capture actual payment amount in USD (amount is in USDC micro units, 6 decimals)
    const amountMicros = parseInt(context.selectedRequirements.amount || "0", 10);
    const amountUsd = amountMicros / 1_000_000;
    // Write to request-scoped store (if available)
    const store = paymentStore.getStore();
    if (store) store.amountUsd = amountUsd;
    console.log(`[ClawRouter] Payment signed on ${chain} (${network}) — $${amountUsd.toFixed(6)}`);
  });

  // The upstream fetch. Same signature on both rails, which is what lets every
  // handler below stay unaware of how the call is being paid for: one settles a
  // 402 by signing USDC, the other never sees a 402 because the bearer token
  // was already good for the request (or was not, and the gateway says so).
  //
  // The key rail's wrapper is where its spend windows live. On the wallet rail
  // the same windows are enforced inside the signer (`registerSpendPolicyHook`
  // above); there is no signer here, so they move to the only other place every
  // paid call on this rail passes through (#329).
  const payFetch =
    authMode === "api-key"
      ? withSpendPolicy(
          createApiKeyFetch(apiKey!, fetch, apiBase),
          options.spendControl ?? getSharedSpendControl(),
          () => {
            const store = paymentStore.getStore();
            const published = store?.estimatedUsd;
            if (store) store.estimatedUsd = undefined; // consume: polls are not billable
            return published;
          },
        )
      : createPayFetchWithPreAuth(fetch, x402!, undefined, {
          skipPreAuth: paymentChain === "solana",
          // Per-request cost estimate so pre-auth is only reused when the cached
          // payment still covers the (possibly larger) request — BlockRun prices per
          // token, so one model can cost different amounts across requests.
          estimateAmount,
          // Only the wallet rail settles per call. The API-key rail is billed
          // server-side against account credit, so there is no per-request
          // settlement for an observer to report.
          onPayment: options.onPayment,
        });

  // Create balance monitor for pre-request checks (lazy import to avoid loading @solana/kit on Base chain)
  let balanceMonitor: AnyBalanceMonitor;
  if (options._balanceMonitorOverride) {
    balanceMonitor = options._balanceMonitorOverride;
  } else if (authMode === "api-key") {
    balanceMonitor = new ApiKeyBalanceMonitor();
  } else if (paymentChain === "solana" && solanaAddress) {
    const { SolanaBalanceMonitor } = await import("./solana-balance.js");
    balanceMonitor = new SolanaBalanceMonitor(solanaAddress);
  } else {
    balanceMonitor = new BalanceMonitor(account!.address);
  }

  // Build router options (100% local — no external API calls for routing)
  const routingConfig = mergeRoutingConfig(options.routingConfig);
  const modelPricing = buildModelPricing();
  const routerOpts: RouterOptions = {
    config: routingConfig,
    modelPricing,
    modelCapabilities: buildModelCapabilities(),
  };

  // Request deduplicator (shared across all requests)
  const deduplicator = new RequestDeduplicator();

  // Response cache for identical requests (longer TTL than dedup)
  const responseCache = new ResponseCache(options.cacheConfig);

  // Session store for model persistence (prevents mid-task model switching)
  const sessionStore = new SessionStore(options.sessionConfig);

  // Session journal for memory (enables agents to recall earlier work)
  const sessionJournal = new SessionJournal();

  // Track active connections for graceful cleanup
  const connections = new Set<import("net").Socket>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Wrap in paymentStore.run() so x402 hook can write actual payment amount per-request
    const handled: Promise<void> = paymentStore.run({ amountUsd: 0 }, async () => {
      // Add stream error handlers to prevent server crashes
      req.on("error", (err) => {
        console.error(`[ClawRouter] Request stream error: ${err.message}`);
        // Don't throw - just log and let request handler deal with it
      });

      res.on("error", (err) => {
        console.error(`[ClawRouter] Response stream error: ${err.message}`);
        // Don't try to write to failed socket - just log
      });

      // Finished wrapper for guaranteed cleanup on response completion/error
      finished(res, (err) => {
        if (err && err.code !== "ERR_STREAM_DESTROYED") {
          console.error(`[ClawRouter] Response finished with error: ${err.message}`);
        }
        // Note: heartbeatInterval cleanup happens in res.on("close") handler
        // Note: completed and dedup cleanup happens in the res.on("close") handler below
      });

      // Request finished wrapper for complete stream lifecycle tracking
      finished(req, (err) => {
        if (err && err.code !== "ERR_STREAM_DESTROYED") {
          console.error(`[ClawRouter] Request finished with error: ${err.message}`);
        }
      });

      // Health check with optional balance info
      if (req.url === "/health" || req.url?.startsWith("/health?")) {
        const url = new URL(req.url, "http://localhost");
        const full = url.searchParams.get("full") === "true";

        const response: Record<string, unknown> = {
          status: "ok",
          authMode,
        };
        if (authMode === "api-key") {
          // No wallet, no chain, and deliberately no full key: /health is
          // unauthenticated on localhost and a bearer token is not a status field.
          response.apiKey = maskApiKey(apiKey!);
          response.gateway = apiBase;
        } else {
          response.wallet = account!.address;
          response.paymentChain = paymentChain;
          // Name the gateway on the wallet rails too. It was reported only in
          // API-key mode, so a wallet user could not tell from /health whether
          // they were pointed at blockrun.ai or sol.blockrun.ai — the single
          // most useful fact when a paid call fails, and the one missing from
          // every report that took a round trip to diagnose.
          response.gateway = apiBase;
          if (solanaAddress) {
            response.solana = solanaAddress;
          }
        }
        if (upstreamProxy) {
          response.upstreamProxy = upstreamProxy;
        }

        if (full) {
          // Time-bound the RPC: `catch` alone covers a rejection but not a
          // hang, and health is the one endpoint that must always answer.
          try {
            const balanceInfo = await Promise.race([
              balanceMonitor.checkBalance(),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error("balance check timed out")),
                  BALANCE_CHECK_TIMEOUT_MS,
                ).unref(),
              ),
            ]);
            if (authMode === "api-key") {
              // The gateway now publishes a key-readable credit position at
              // GET /v1/credits, so this no longer has to report `null`. Note
              // `remaining` is legitimately null on an ungated account (no
              // granted allowance to draw down) — that is not a failure, and a
              // consumer must not render it as $0.00. An unreachable gateway
              // leaves every field null and health still answers.
              const credit = await fetchCreditBalance(apiKey!, BALANCE_CHECK_TIMEOUT_MS);
              response.balance = credit?.remainingUsd ?? null;
              response.creditSpent = credit?.spentUsd ?? null;
              response.creditGranted = credit?.grantedUsd ?? null;
              response.billingMode = credit?.billingMode ?? null;
              response.creditSummary = credit ? formatCreditBalance(credit) : null;
              response.blocked = credit?.blocked ?? false;
              if (credit?.blockedReason) response.blockedReason = credit.blockedReason;
              response.isEmpty = credit?.remainingUsd !== null && (credit?.remainingUsd ?? 1) <= 0;
              response.billing = "BlockRun account credit";
              response.topUpUrl = PORTAL_CREDITS_URL;
            } else {
              response.balance = balanceInfo.balanceUSD;
              response.isLow = balanceInfo.isLow;
              response.isEmpty = balanceInfo.isEmpty;
            }
          } catch {
            response.balanceError = "Could not fetch balance";
          }
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        };
        const challengeValue = req.headers["x-clawrouter-challenge"];
        const challenge = Array.isArray(challengeValue) ? challengeValue[0] : challengeValue;
        if (challenge && /^[a-f0-9]{64}$/i.test(challenge)) {
          try {
            const token = readFileSync(DESKTOP_SERVICE_TOKEN_FILE, "utf8").trim();
            if (/^[a-f0-9]{64}$/i.test(token)) {
              headers["X-ClawRouter-Proof"] = createHmac("sha256", token)
                .update(challenge)
                .digest("hex");
            }
          } catch {
            // Desktop identity proof is optional for ordinary health clients.
          }
        }
        res.writeHead(200, headers);
        res.end(JSON.stringify(response));
        return;
      }

      // Cache stats endpoint
      if (req.url === "/cache" || req.url?.startsWith("/cache?")) {
        const stats = responseCache.getStats();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        });
        res.end(JSON.stringify(stats, null, 2));
        return;
      }

      // Stats clear endpoint - delete all log files
      if (req.url === "/stats" && req.method === "DELETE") {
        try {
          const result = await clearStats();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ cleared: true, deletedFiles: result.deletedFiles }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `Failed to clear stats: ${err instanceof Error ? err.message : String(err)}`,
            }),
          );
        }
        return;
      }

      // Stats API endpoint - returns JSON for programmatic access
      if (req.url === "/stats" || req.url?.startsWith("/stats?")) {
        try {
          const url = new URL(req.url, "http://localhost");
          const days = resolveStatsDays(url.searchParams.get("days"));
          const stats = await getStats(days);

          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
          });
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
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `Failed to get stats: ${err instanceof Error ? err.message : String(err)}`,
            }),
          );
        }
        return;
      }

      // --- Handle /v1/models locally (no upstream call needed) ---
      if (req.url === "/v1/models" && req.method === "GET") {
        const models = buildProxyModelList();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: models }));
        return;
      }

      // --- Share routes: serve persisted response bodies for `clawrouter share` ---
      if (req.url?.startsWith("/share") && req.method === "GET") {
        try {
          const url = new URL(req.url, "http://localhost");
          const path = url.pathname;
          // /share/list?limit=20
          if (path === "/share/list") {
            const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 100);
            const entries = await listRecent(limit);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify(
                entries.map((e) => ({
                  id: e.id,
                  timestamp: e.timestamp,
                  model: e.model,
                  sessionId: e.sessionId,
                  requestSummary: e.requestSummary,
                  responseLength: e.responseText.length,
                })),
              ),
            );
            return;
          }
          // /share/last
          if (path === "/share/last") {
            const sessionId = url.searchParams.get("sessionId") || undefined;
            const entry = await getLast(sessionId);
            if (!entry) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "no responses yet" }));
              return;
            }
            const preset = url.searchParams.get("as");
            if (preset && isSharePreset(preset)) {
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Cache-Control": "no-cache",
              });
              res.end(
                JSON.stringify({
                  id: entry.id,
                  timestamp: entry.timestamp,
                  model: entry.model,
                  preset,
                  rendered: transform(entry.responseText, preset),
                }),
              );
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(entry));
            return;
          }
          // /share/:id  or  /share/:id/render?as=preset
          const idMatch = path.match(/^\/share\/(resp_[A-Za-z0-9_]+)(?:\/render)?$/);
          if (idMatch) {
            const id = idMatch[1];
            const entry = await getById(id);
            if (!entry) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `no response with id ${id}` }));
              return;
            }
            const preset = url.searchParams.get("as");
            if (preset && isSharePreset(preset)) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  id: entry.id,
                  timestamp: entry.timestamp,
                  model: entry.model,
                  preset,
                  rendered: transform(entry.responseText, preset),
                }),
              );
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(entry));
            return;
          }
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unknown share endpoint" }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `share failed: ${err instanceof Error ? err.message : String(err)}`,
            }),
          );
        }
        return;
      }

      // --- Serve locally cached images (~/.openclaw/blockrun/images/) ---
      if (req.url?.startsWith("/images/") && req.method === "GET") {
        const filename = req.url
          .slice("/images/".length)
          .split("?")[0]!
          .replace(/[^a-zA-Z0-9._-]/g, "");
        if (!filename) {
          res.writeHead(400);
          res.end("Bad request");
          return;
        }
        const filePath = join(IMAGE_DIR, filename);
        try {
          const s = await fsStat(filePath);
          if (!s.isFile()) throw new Error("not a file");
          const ext = filename.split(".").pop()?.toLowerCase() ?? "png";
          const mime: Record<string, string> = {
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            webp: "image/webp",
            gif: "image/gif",
          };
          const data = await readFile(filePath);
          res.writeHead(200, {
            "Content-Type": mime[ext] ?? "application/octet-stream",
            "Content-Length": data.length,
          });
          res.end(data);
        } catch {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Image not found" }));
        }
        return;
      }

      // --- Serve locally cached audio (~/.openclaw/blockrun/audio/) ---
      if (req.url?.startsWith("/audio/") && req.method === "GET") {
        const filename = req.url
          .slice("/audio/".length)
          .split("?")[0]!
          .replace(/[^a-zA-Z0-9._-]/g, "");
        if (!filename) {
          res.writeHead(400);
          res.end("Bad request");
          return;
        }
        const filePath = join(AUDIO_DIR, filename);
        try {
          const s = await fsStat(filePath);
          if (!s.isFile()) throw new Error("not a file");
          const ext = filename.split(".").pop()?.toLowerCase() ?? "mp3";
          const mime: Record<string, string> = {
            mp3: "audio/mpeg",
            wav: "audio/wav",
            ogg: "audio/ogg",
            m4a: "audio/mp4",
          };
          const data = await readFile(filePath);
          res.writeHead(200, {
            "Content-Type": mime[ext] ?? "audio/mpeg",
            "Content-Length": data.length,
          });
          res.end(data);
        } catch {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Audio not found" }));
        }
        return;
      }

      // --- Serve locally cached videos (~/.openclaw/blockrun/videos/) ---
      if (req.url?.startsWith("/videos/") && req.method === "GET") {
        const filename = req.url
          .slice("/videos/".length)
          .split("?")[0]!
          .replace(/[^a-zA-Z0-9._-]/g, "");
        if (!filename) {
          res.writeHead(400);
          res.end("Bad request");
          return;
        }
        const filePath = join(VIDEO_DIR, filename);
        try {
          const s = await fsStat(filePath);
          if (!s.isFile()) throw new Error("not a file");
          const ext = filename.split(".").pop()?.toLowerCase() ?? "mp4";
          const mime: Record<string, string> = {
            mp4: "video/mp4",
            webm: "video/webm",
            mov: "video/quicktime",
          };
          const data = await readFile(filePath);
          res.writeHead(200, {
            "Content-Type": mime[ext] ?? "video/mp4",
            "Content-Length": data.length,
          });
          res.end(data);
        } catch {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Video not found" }));
        }
        return;
      }

      // --- Handle /v1/images/generations: proxy with x402 payment + save data URIs locally ---
      // NOTE: image generation endpoints bypass maxCostPerRun budget tracking entirely.
      // Cost is charged via x402 micropayment directly — no session accumulation or cap enforcement.
      if (req.url === "/v1/images/generations" && req.method === "POST") {
        const imgStartTime = Date.now();
        // Stop all upstream work if the client goes away — especially the poll
        // loop below, whose first `completed` poll settles the x402 payment.
        const clientAbort = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) clientAbort.abort();
        });
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const reqBody = Buffer.concat(chunks);
        // Parse request for usage logging
        let imgModel = "unknown";
        let imgCost = 0;
        try {
          const parsed = JSON.parse(reqBody.toString());
          imgModel = parsed.model || "google/nano-banana";
          const n = parsed.n || 1;
          imgCost = estimateImageCost(imgModel, parsed.size, n);
        } catch {
          /* use defaults */
        }
        try {
          // Step 1: submit job. Fast models return 200 + image data inline within
          // BlockRun's 30s window. Slow models (e.g. openai/gpt-image-2) return
          // 202 + { id, poll_url } and we poll below — same pattern as video.
          publishDispatchCost(imgCost);
          const upstream = await payFetch(`${apiBase}/v1/images/generations`, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": USER_AGENT },
            body: reqBody,
            signal: clientAbort.signal,
          });
          const text = await upstream.text();
          if (!upstream.ok && upstream.status !== 202) {
            res.writeHead(upstream.status, { "Content-Type": "application/json" });
            res.end(text);
            return;
          }
          let result: {
            created?: number;
            data?: Array<{ url?: string; revised_prompt?: string }>;
            id?: string;
            poll_url?: string;
            status?: string;
          };
          try {
            result = JSON.parse(text);
          } catch {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(text);
            return;
          }

          // Step 2: slow path — BlockRun returned 202 + poll_url (slow model > 30s
          // inline window). Poll upstream until completed; client sees a single
          // blocking POST. Mirrors the video polling loop below.
          if (result.poll_url && result.id && !result.data?.length) {
            const apiOrigin = new URL(apiBase).origin;
            const pollUrl = result.poll_url.startsWith("http")
              ? result.poll_url
              : `${apiOrigin}${result.poll_url}`;
            console.log(
              `[ClawRouter] Image job submitted (id=${result.id}), polling upstream — typical 30–120s...`,
            );
            // Poll every 3s, bail after ~5min total. Server auth window is 10min.
            const pollDeadline = Date.now() + 300_000;
            const pollInterval = 3_000;
            // Small initial delay so upstream has a chance to make progress.
            await new Promise((r) => setTimeout(r, 2_000));
            let pollError: string | undefined;
            let completed = false;
            while (Date.now() < pollDeadline) {
              if (clientAbort.signal.aborted) {
                console.log(
                  `[ClawRouter] Client disconnected — abandoning image poll (id=${result.id})`,
                );
                return;
              }
              const pollResp = await payFetch(pollUrl, {
                method: "GET",
                headers: { "user-agent": USER_AGENT },
                signal: clientAbort.signal,
              });
              const pollText = await pollResp.text();
              let pollBody: typeof result & { error?: string } = {};
              try {
                pollBody = JSON.parse(pollText);
              } catch {
                pollError = `Non-JSON poll response (${pollResp.status}): ${pollText.slice(0, 200)}`;
                break;
              }
              if (
                pollResp.status === 202 ||
                pollBody.status === "queued" ||
                pollBody.status === "in_progress"
              ) {
                await new Promise((r) => setTimeout(r, pollInterval));
                continue;
              }
              if (pollBody.status === "failed") {
                pollError = pollBody.error ?? "Upstream image generation failed";
                break;
              }
              if (pollResp.ok && pollBody.status === "completed") {
                result = pollBody;
                completed = true;
                break;
              }
              if (!pollResp.ok) {
                res.writeHead(pollResp.status, { "Content-Type": "application/json" });
                res.end(pollText);
                return;
              }
              // OK but no recognized status — hand through.
              result = pollBody;
              completed = true;
              break;
            }
            if (pollError) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Image generation failed", details: pollError }));
              return;
            }
            if (!completed) {
              res.writeHead(504, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "Image generation timed out",
                  details: `Upstream did not complete within 5 minutes (job id=${result.id}). No payment has been settled.`,
                }),
              );
              return;
            }
          }

          // Step 3: save images to ~/.openclaw/blockrun/images/ and replace with localhost URLs
          // Handles both base64 data URIs (Google) and HTTP URLs (DALL-E 3, gpt-image-2)
          if (result.data?.length) {
            await mkdir(IMAGE_DIR, { recursive: true });
            const port = (server.address() as AddressInfo | null)?.port ?? 8402;
            for (const img of result.data) {
              const dataUriMatch = img.url?.match(/^data:(image\/\w+);base64,(.+)$/);
              if (dataUriMatch) {
                const [, mimeType, b64] = dataUriMatch;
                const ext = mimeType === "image/jpeg" ? "jpg" : (mimeType!.split("/")[1] ?? "png");
                const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
                await writeFile(join(IMAGE_DIR, filename), Buffer.from(b64!, "base64"));
                img.url = `http://localhost:${port}/images/${filename}`;
                console.log(`[ClawRouter] Image saved → ${img.url}`);
              } else if (img.url?.startsWith("https://") || img.url?.startsWith("http://")) {
                try {
                  const imgResp = await fetch(img.url, { signal: clientAbort.signal });
                  if (imgResp.ok) {
                    const contentType = imgResp.headers.get("content-type") ?? "image/png";
                    const ext =
                      contentType.includes("jpeg") || contentType.includes("jpg")
                        ? "jpg"
                        : contentType.includes("webp")
                          ? "webp"
                          : "png";
                    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
                    const buf = Buffer.from(await imgResp.arrayBuffer());
                    await writeFile(join(IMAGE_DIR, filename), buf);
                    img.url = `http://localhost:${port}/images/${filename}`;
                    console.log(`[ClawRouter] Image downloaded & saved → ${img.url}`);
                  }
                } catch (downloadErr) {
                  console.warn(
                    `[ClawRouter] Failed to download image, using original URL: ${downloadErr instanceof Error ? downloadErr.message : String(downloadErr)}`,
                  );
                }
              }
            }
          }
          // Log image generation usage with actual x402 payment (previously missing entirely)
          const imgActualCost = settledMediaCostUsd(
            upstream,
            result,
            paymentStore.getStore()?.amountUsd,
            imgCost,
          );
          logUsage({
            timestamp: new Date().toISOString(),
            ...(blockrunRequestId(upstream) ? { requestId: blockrunRequestId(upstream) } : {}),
            model: imgModel,
            tier: "IMAGE",
            cost: imgActualCost,
            baselineCost: imgActualCost,
            savings: 0,
            latencyMs: Date.now() - imgStartTime,
          }).catch(() => {});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          if (clientAbort.signal.aborted) return; // client gone — nothing to report
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[ClawRouter] Image generation error: ${msg}`);
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Image generation failed", details: msg }));
          }
        }
        return;
      }

      // --- Handle /v1/images/image2image: proxy with x402 payment + save images locally ---
      // Accepts image as: data URI, local file path, ~/path, or HTTP(S) URL
      if (req.url === "/v1/images/image2image" && req.method === "POST") {
        const img2imgStartTime = Date.now();
        // #251: mirror /v1/images/generations — if the client goes away, abort
        // the upstream call so the x402 payment doesn't settle for a result
        // nobody will receive.
        const clientAbort = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) clientAbort.abort();
        });
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const rawBody = Buffer.concat(chunks);

        // Resolve image/mask fields: file paths and URLs → data URIs
        let reqBody: string;
        // eslint-disable-next-line no-useless-assignment -- reassigned in try, used after catch
        let img2imgModel = "openai/gpt-image-1";
        // eslint-disable-next-line no-useless-assignment -- reassigned in try, used after catch
        let img2imgCost = 0;
        try {
          const parsed = JSON.parse(rawBody.toString());
          for (const field of ["image", "mask"] as const) {
            const val = parsed[field];
            if (typeof val !== "string" || !val) continue;
            if (val.startsWith("data:")) {
              // Already a data URI — pass through
            } else if (val.startsWith("https://") || val.startsWith("http://")) {
              // Download URL → data URI
              const imgResp = await fetch(val, { signal: clientAbort.signal });
              if (!imgResp.ok)
                throw new Error(`Failed to download ${field} from ${val}: HTTP ${imgResp.status}`);
              const contentType = imgResp.headers.get("content-type") ?? "image/png";
              const buf = Buffer.from(await imgResp.arrayBuffer());
              parsed[field] = `data:${contentType};base64,${buf.toString("base64")}`;
              console.log(
                `[ClawRouter] img2img: downloaded ${field} URL → data URI (${buf.length} bytes)`,
              );
            } else {
              // Local file path → data URI
              parsed[field] = readImageFileAsDataUri(val);
              console.log(`[ClawRouter] img2img: read ${field} file → data URI`);
            }
          }
          // Default model if not specified
          if (!parsed.model) parsed.model = "openai/gpt-image-1";
          img2imgModel = parsed.model;
          img2imgCost = estimateImageCost(img2imgModel, parsed.size, parsed.n || 1);
          reqBody = JSON.stringify(parsed);
        } catch (parseErr) {
          // #277: an aborted source/mask download rejects here — the client is
          // gone, so don't misreport it as invalid input on a dead socket.
          if (clientAbort.signal.aborted) return;
          const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request", details: msg }));
          return;
        }

        try {
          publishDispatchCost(img2imgCost);
          let upstream = await payFetch(`${apiBase}/v1/images/image2image`, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": USER_AGENT },
            body: reqBody,
            signal: clientAbort.signal,
          });
          // 202 + poll_url on the account rail: complete it here. The wallet
          // path re-signs an x402 payment per poll; there is nothing to sign on a
          // bearer token, so without this the caller gets a raw 202 it cannot use.
          if (authMode === "api-key") {
            upstream = await pollApiKeyJob(upstream, payFetch, apiBase, clientAbort.signal);
          }
          const text = await upstream.text();
          if (!upstream.ok) {
            res.writeHead(upstream.status, { "Content-Type": "application/json" });
            res.end(text);
            return;
          }
          let result: { created?: number; data?: Array<{ url?: string; revised_prompt?: string }> };
          try {
            result = JSON.parse(text);
          } catch {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(text);
            return;
          }
          // Save images to ~/.openclaw/blockrun/images/ and replace with localhost URLs
          // Handles both base64 data URIs (Google) and HTTP URLs (DALL-E 3)
          if (result.data?.length) {
            await mkdir(IMAGE_DIR, { recursive: true });
            const port = (server.address() as AddressInfo | null)?.port ?? 8402;
            for (const img of result.data) {
              const dataUriMatch = img.url?.match(/^data:(image\/\w+);base64,(.+)$/);
              if (dataUriMatch) {
                const [, mimeType, b64] = dataUriMatch;
                const ext = mimeType === "image/jpeg" ? "jpg" : (mimeType!.split("/")[1] ?? "png");
                const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
                await writeFile(join(IMAGE_DIR, filename), Buffer.from(b64!, "base64"));
                img.url = `http://localhost:${port}/images/${filename}`;
                console.log(`[ClawRouter] Image saved → ${img.url}`);
              } else if (img.url?.startsWith("https://") || img.url?.startsWith("http://")) {
                try {
                  const imgResp = await fetch(img.url, { signal: clientAbort.signal });
                  if (imgResp.ok) {
                    const contentType = imgResp.headers.get("content-type") ?? "image/png";
                    const ext =
                      contentType.includes("jpeg") || contentType.includes("jpg")
                        ? "jpg"
                        : contentType.includes("webp")
                          ? "webp"
                          : "png";
                    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
                    const buf = Buffer.from(await imgResp.arrayBuffer());
                    await writeFile(join(IMAGE_DIR, filename), buf);
                    img.url = `http://localhost:${port}/images/${filename}`;
                    console.log(`[ClawRouter] Image downloaded & saved → ${img.url}`);
                  }
                } catch (downloadErr) {
                  console.warn(
                    `[ClawRouter] Failed to download image, using original URL: ${downloadErr instanceof Error ? downloadErr.message : String(downloadErr)}`,
                  );
                }
              }
            }
          }
          // Log image editing usage with actual x402 payment (previously missing entirely)
          const img2imgActualCost = settledMediaCostUsd(
            upstream,
            result,
            paymentStore.getStore()?.amountUsd,
            img2imgCost,
          );
          logUsage({
            timestamp: new Date().toISOString(),
            ...(blockrunRequestId(upstream) ? { requestId: blockrunRequestId(upstream) } : {}),
            model: img2imgModel,
            tier: "IMAGE",
            cost: img2imgActualCost,
            baselineCost: img2imgActualCost,
            savings: 0,
            latencyMs: Date.now() - img2imgStartTime,
          }).catch(() => {});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          if (clientAbort.signal.aborted) return; // client gone — nothing to report
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[ClawRouter] Image editing error: ${msg}`);
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Image editing failed", details: msg }));
          }
        }
        return;
      }

      // --- Handle /v1/audio/generations: proxy with x402 payment + save audio locally ---
      if (req.url === "/v1/audio/generations" && req.method === "POST") {
        const audioStartTime = Date.now();
        // Same class as #251: abort the paid upstream call if the client goes
        // away so the x402 payment doesn't settle for audio nobody receives.
        const clientAbort = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) clientAbort.abort();
        });
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const reqBody = Buffer.concat(chunks);
        let audioModel = "minimax/music-2.5+";
        try {
          const parsed = JSON.parse(reqBody.toString());
          audioModel = parsed.model || audioModel;
        } catch {
          /* use defaults */
        }
        try {
          publishDispatchCost(0.15);
          let upstream = await payFetch(`${apiBase}/v1/audio/generations`, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": USER_AGENT },
            body: reqBody,
            signal: clientAbort.signal,
          });
          // 202 + poll_url on the account rail: complete it here. The wallet
          // path re-signs an x402 payment per poll; there is nothing to sign on a
          // bearer token, so without this the caller gets a raw 202 it cannot use.
          if (authMode === "api-key") {
            upstream = await pollApiKeyJob(upstream, payFetch, apiBase, clientAbort.signal);
          }
          const text = await upstream.text();
          if (!upstream.ok) {
            res.writeHead(upstream.status, { "Content-Type": "application/json" });
            res.end(text);
            return;
          }
          let result: {
            created?: number;
            model?: string;
            data?: Array<{ url?: string; duration_seconds?: number; lyrics?: string }>;
          };
          try {
            result = JSON.parse(text);
          } catch {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(text);
            return;
          }
          // Download audio from remote URL and save locally
          if (result.data?.length) {
            await mkdir(AUDIO_DIR, { recursive: true });
            const port = (server.address() as AddressInfo | null)?.port ?? 8402;
            for (const track of result.data) {
              if (track.url?.startsWith("https://") || track.url?.startsWith("http://")) {
                try {
                  const audioResp = await fetch(track.url, { signal: clientAbort.signal });
                  if (audioResp.ok) {
                    const contentType = audioResp.headers.get("content-type") ?? "audio/mpeg";
                    const ext = contentType.includes("wav") ? "wav" : "mp3";
                    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
                    const buf = Buffer.from(await audioResp.arrayBuffer());
                    await writeFile(join(AUDIO_DIR, filename), buf);
                    track.url = `http://localhost:${port}/audio/${filename}`;
                    console.log(`[ClawRouter] Audio saved → ${track.url}`);
                  }
                } catch (downloadErr) {
                  console.warn(
                    `[ClawRouter] Failed to download audio, using original URL: ${downloadErr instanceof Error ? downloadErr.message : String(downloadErr)}`,
                  );
                }
              }
            }
          }
          const audioActualCost = settledMediaCostUsd(
            upstream,
            result,
            paymentStore.getStore()?.amountUsd,
            0.15,
          );
          logUsage({
            timestamp: new Date().toISOString(),
            ...(blockrunRequestId(upstream) ? { requestId: blockrunRequestId(upstream) } : {}),
            model: audioModel,
            tier: "AUDIO",
            cost: audioActualCost,
            baselineCost: audioActualCost,
            savings: 0,
            latencyMs: Date.now() - audioStartTime,
          }).catch(() => {});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          if (clientAbort.signal.aborted) return; // client gone — nothing to report
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[ClawRouter] Audio generation error: ${msg}`);
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Audio generation failed", details: msg }));
          }
        }
        return;
      }

      // --- Handle /v1/videos/generations: async submit + poll ---
      // Server protocol (BlockRun 2026-04-23+):
      //   POST /v1/videos/generations        → 202 { id, poll_url }  (payment verified, not settled)
      //   GET  /v1/videos/generations/{id}   → 202 while queued/in_progress, 200 on completed
      //                                        (settles on the first completed poll)
      // We collapse this back into a single blocking POST for the client — upstream
      // polling happens server-side and the client sees one HTTP round-trip.
      if (req.url === "/v1/videos/generations" && req.method === "POST") {
        const videoStartTime = Date.now();
        // Stop all upstream work if the client goes away — especially the poll
        // loop below, whose first `completed` poll settles the x402 payment.
        const clientAbort = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) clientAbort.abort();
        });
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const reqBody = Buffer.concat(chunks);
        let videoModel = "xai/grok-imagine-video";
        let videoDuration: number | undefined;
        let videoHasImageInput = false;
        try {
          const parsed = JSON.parse(reqBody.toString());
          videoModel = parsed.model || videoModel;
          videoDuration =
            typeof parsed.duration_seconds === "number" ? parsed.duration_seconds : undefined;
          videoHasImageInput = typeof parsed.image_url === "string" && parsed.image_url.length > 0;
        } catch {
          /* use defaults */
        }
        try {
          // Step 1: submit job. Server returns 202 with poll_url.
          publishDispatchCost(estimateVideoCost(videoModel, videoDuration, videoHasImageInput));
          const submitResp = await payFetch(`${apiBase}/v1/videos/generations`, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": USER_AGENT },
            body: reqBody,
            signal: clientAbort.signal,
          });
          const submitText = await submitResp.text();
          if (!submitResp.ok && submitResp.status !== 202) {
            res.writeHead(submitResp.status, { "Content-Type": "application/json" });
            res.end(submitText);
            return;
          }
          let submitResult: {
            id?: string;
            poll_url?: string;
            status?: string;
            // Legacy (pre-2026-04-23) servers still return the final result directly.
            created?: number;
            model?: string;
            data?: Array<{ url?: string; duration_seconds?: number; backed_up?: boolean }>;
          };
          try {
            submitResult = JSON.parse(submitText);
          } catch {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(submitText);
            return;
          }

          // Step 2: if no poll_url, upstream responded with the final result (legacy server) —
          // drop through to the same local-caching path as before.
          let finalResult: typeof submitResult = submitResult;
          if (submitResult.poll_url && submitResult.id) {
            const apiOrigin = new URL(apiBase).origin;
            const pollUrl = submitResult.poll_url.startsWith("http")
              ? submitResult.poll_url
              : `${apiOrigin}${submitResult.poll_url}`;
            console.log(
              `[ClawRouter] Video job submitted (id=${submitResult.id}), polling upstream — typical 60–180s...`,
            );

            // Upstream typically 60-180s. Poll every 5s, bail after ~5min total.
            // Auth is 10min per server config; we stop before that.
            const pollDeadline = Date.now() + 300_000;
            const pollInterval = 5_000;
            // Small initial delay so the upstream has a chance to start.
            await new Promise((r) => setTimeout(r, 3_000));
            let pollError: string | undefined;
            let videoCompleted = false;
            while (Date.now() < pollDeadline) {
              if (clientAbort.signal.aborted) {
                console.log(
                  `[ClawRouter] Client disconnected — abandoning video poll (id=${submitResult.id})`,
                );
                return;
              }
              const pollResp = await payFetch(pollUrl, {
                method: "GET",
                headers: { "user-agent": USER_AGENT },
                signal: clientAbort.signal,
              });
              const pollText = await pollResp.text();
              let pollBody: typeof submitResult & { error?: string } = {};
              try {
                pollBody = JSON.parse(pollText);
              } catch {
                pollError = `Non-JSON poll response (${pollResp.status}): ${pollText.slice(0, 200)}`;
                break;
              }
              if (
                pollResp.status === 202 ||
                pollBody.status === "queued" ||
                pollBody.status === "in_progress"
              ) {
                await new Promise((r) => setTimeout(r, pollInterval));
                continue;
              }
              if (pollBody.status === "failed") {
                pollError = pollBody.error ?? "Upstream video generation failed";
                break;
              }
              if (pollResp.ok && pollBody.status === "completed") {
                finalResult = pollBody;
                videoCompleted = true;
                break;
              }
              // Any other non-OK: surface it.
              if (!pollResp.ok) {
                res.writeHead(pollResp.status, { "Content-Type": "application/json" });
                res.end(pollText);
                return;
              }
              // OK but no known status — treat as final and hand through.
              finalResult = pollBody;
              videoCompleted = true;
              break;
            }
            if (pollError) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Video generation failed", details: pollError }));
              return;
            }
            // Explicit completed flag (not finalResult.data) — a job that
            // completes with an empty payload is "completed", not "timed out".
            if (!videoCompleted) {
              res.writeHead(504, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "Video generation timed out",
                  details: `Upstream did not complete within 5 minutes (job id=${submitResult.id}). No payment has been settled.`,
                }),
              );
              return;
            }
          }

          // Step 3: download any hosted URLs to local disk + rewrite to localhost.
          if (finalResult.data?.length) {
            await mkdir(VIDEO_DIR, { recursive: true });
            const port = (server.address() as AddressInfo | null)?.port ?? 8402;
            for (const clip of finalResult.data) {
              if (clip.url?.startsWith("https://") || clip.url?.startsWith("http://")) {
                try {
                  const videoResp = await fetch(clip.url, { signal: clientAbort.signal });
                  if (videoResp.ok) {
                    const contentType = videoResp.headers.get("content-type") ?? "video/mp4";
                    const ext = contentType.includes("webm")
                      ? "webm"
                      : contentType.includes("quicktime")
                        ? "mov"
                        : "mp4";
                    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
                    const buf = Buffer.from(await videoResp.arrayBuffer());
                    await writeFile(join(VIDEO_DIR, filename), buf);
                    clip.url = `http://localhost:${port}/videos/${filename}`;
                    console.log(`[ClawRouter] Video saved → ${clip.url}`);
                  }
                } catch (downloadErr) {
                  console.warn(
                    `[ClawRouter] Failed to download video, using original URL: ${downloadErr instanceof Error ? downloadErr.message : String(downloadErr)}`,
                  );
                }
              }
            }
          }
          const videoActualCost = settledMediaCostUsd(
            undefined,
            submitResult,
            paymentStore.getStore()?.amountUsd,
            estimateVideoCost(videoModel, videoDuration, videoHasImageInput),
          );
          logUsage({
            timestamp: new Date().toISOString(),
            model: videoModel,
            tier: "VIDEO",
            cost: videoActualCost,
            baselineCost: videoActualCost,
            savings: 0,
            latencyMs: Date.now() - videoStartTime,
          }).catch(() => {});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(finalResult));
        } catch (err) {
          if (clientAbort.signal.aborted) return; // client gone — nothing to report
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[ClawRouter] Video generation error: ${msg}`);
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Video generation failed", details: msg }));
          }
        }
        return;
      }

      // --- Handle paid API paths (/v1/partner/*, /v1/pm/*, /v1/exa/*, /v1/modal/*,
      // /v1/stocks/*, /v1/usstock/*, /v1/crypto/*, /v1/fx/*, /v1/commodity/*,
      // /v1/phone/* (Twilio number intelligence + provisioning),
      // /v1/voice/* (Bland.ai outbound AI voice calls),
      // /v1/surf/* (Surf unified crypto data API: 84 endpoints across CEX/DEX,
      //   on-chain SQL, wallet intelligence, prediction markets, social, news)) ---
      // Gateway endpoints that carry no `model` we route on, and so must be
      // forwarded verbatim rather than fed to the chat path:
      //   /v1/messages       — the Anthropic-shaped chat surface
      //   /v1/audio/speech   — ElevenLabs/Seed TTS (distinct from the
      //                        /v1/audio/generations music route handled above)
      // Without this they fall through to proxyRequest, where `modelsToTry` is
      // `modelId ? [modelId] : []` — empty, because neither body carries a model
      // this proxy routes on. The attempt loop then never issues an upstream
      // request at all and the caller gets a 502 "All models in fallback chain
      // failed" for an endpoint the gateway serves perfectly well. Both are
      // verified live against api.blockrun.ai and blockrun.ai/api.
      //
      // Note the passthrough buffers the response before writing it, so an SSE
      // stream arrives complete rather than incrementally. That is correct but
      // not incremental; smart routing, sessions and the response cache do not
      // apply on these paths either.
      const isVerbatimGatewayPath =
        req.url === "/v1/messages" ||
        (req.url?.startsWith("/v1/messages?") ?? false) ||
        req.url === "/v1/audio/speech" ||
        (req.url?.startsWith("/v1/audio/speech?") ?? false);

      if (
        isVerbatimGatewayPath ||
        req.url?.match(
          /^\/v1\/(?:partner|pm|exa|modal|stocks|usstock|crypto|fx|commodity|phone|voice|surf)\//,
        )
      ) {
        try {
          await proxyPaidApiRequest(
            req,
            res,
            apiBase,
            payFetch,
            () => paymentStore.getStore()?.amountUsd ?? 0,
            false,
            authMode,
          );
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          options.onError?.(error);
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: { message: `Partner proxy error: ${error.message}`, type: "partner_error" },
              }),
            );
          } else if (!res.writableEnded) {
            // Headers already sent (e.g. body-read timeout mid-stream) — end the
            // response instead of leaving the client hanging until socket timeout.
            res.end();
          }
        }
        return;
      }

      // Only proxy paths starting with /v1
      if (!req.url?.startsWith("/v1")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      // Account rail: forward everything that is not chat straight through.
      //
      // Placed AFTER the specialised routes above on purpose — images, videos,
      // audio/generations, /v1/models and the partner prefixes keep their own
      // polling, local-download and pricing behaviour. What reaches here is the
      // long tail of account services, which have no `model` to route on and
      // whose native payload, status and SSE contract should survive untouched.
      // Chat and /v1/messages are excluded so smart routing still applies to
      // them.
      if (
        authMode === "api-key" &&
        /^\/v1\//.test(req.url ?? "") &&
        !/^\/v1\/(?:chat\/completions|messages)(?:\?|$)/.test(req.url ?? "")
      ) {
        try {
          await proxyPaidApiRequest(
            req,
            res,
            apiBase,
            payFetch,
            () => paymentStore.getStore()?.amountUsd ?? 0,
            true,
            authMode,
          );
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          options.onError?.(error);
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: { message: `Account API error: ${error.message}`, type: "account_error" },
              }),
            );
          } else if (!res.writableEnded) {
            res.end();
          }
        }
        return;
      }

      // Everything still here is handed to proxyRequest, which is the chat
      // path: it routes on the body's `model`, and its attempt loop is keyed on
      // that model. A /v1 path with no model reaches the loop with nothing to
      // try, issues no upstream request, and returns 502 "All models in
      // fallback chain failed" — an answer that blames the model catalog for
      // what is really an unrouted URL, and sends people debugging the wrong
      // thing. Say what actually happened instead.
      if (!req.url.includes("/chat/completions")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message:
                `ClawRouter does not proxy ${req.url}. It serves /v1/chat/completions, /v1/messages, ` +
                `/v1/models, /v1/images/generations, /v1/images/image2image, /v1/videos/generations, ` +
                `/v1/audio/generations, /v1/audio/speech, and the partner prefixes /v1/{partner,pm,exa,` +
                `modal,stocks,usstock,crypto,fx,commodity,phone,voice,surf}/. ` +
                `If BlockRun serves this endpoint, call it directly against the gateway.`,
              type: "invalid_request_error",
              code: "unsupported_endpoint",
            },
          }),
        );
        return;
      }

      try {
        await proxyRequest(
          req,
          res,
          apiBase,
          payFetch,
          options,
          routerOpts,
          deduplicator,
          balanceMonitor,
          sessionStore,
          responseCache,
          sessionJournal,
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        options.onError?.(error);

        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: `Proxy error: ${error.message}`, type: "proxy_error" },
            }),
          );
        } else if (!res.writableEnded) {
          // Headers already sent (streaming) — send error as SSE event
          res.write(
            `data: ${JSON.stringify({ error: { message: error.message, type: "proxy_error" } })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        }
      }
    }); // end paymentStore.run()

    // Safety net: rejections that escape the handler (e.g. the request-body
    // async iterator rejecting when a client aborts mid-upload) must never
    // become unhandledRejections — that kills the whole proxy process.
    handled.catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[ClawRouter] Unhandled request error: ${error.message}`);
      options.onError?.(error);
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: `Proxy error: ${error.message}`, type: "proxy_error" },
            }),
          );
        } else if (!res.writableEnded) {
          res.end();
        }
      } catch {
        // Socket already gone — nothing left to clean up
      }
    });
  });

  // Listen on configured port with retry logic for TIME_WAIT handling
  // When gateway restarts quickly, the port may still be in TIME_WAIT state.
  // We retry with delay instead of incorrectly assuming a proxy is running.
  const tryListen = (attempt: number): Promise<void> => {
    return new Promise<void>((resolveAttempt, rejectAttempt) => {
      const onError = async (err: NodeJS.ErrnoException) => {
        server.removeListener("error", onError);

        if (err.code === "EADDRINUSE") {
          if (options.allowExistingProxy === false) {
            rejectAttempt(err);
            return;
          }
          // Port is in use - check if a proxy is actually running
          const existingProxy2 = await checkExistingProxy(listenPort);
          if (existingProxy2) {
            // Proxy is actually running - this is fine, reuse it
            console.log(`[ClawRouter] Existing proxy detected on port ${listenPort}, reusing`);
            // Carry the whole probe result, not just the wallet: the credential
            // check below needs authMode and the key label too, and an API-key
            // proxy publishes an EMPTY wallet — a truthiness test on that field
            // dropped straight through to the generic error path.
            rejectAttempt({ code: "REUSE_EXISTING", existing: existingProxy2 });
            return;
          }

          // Port is in TIME_WAIT (no proxy responding) - retry after delay
          if (attempt < PORT_RETRY_ATTEMPTS) {
            console.log(
              `[ClawRouter] Port ${listenPort} in TIME_WAIT, retrying in ${PORT_RETRY_DELAY_MS}ms (attempt ${attempt}/${PORT_RETRY_ATTEMPTS})`,
            );
            rejectAttempt({ code: "RETRY", attempt });
            return;
          }

          // Max retries exceeded
          console.error(
            `[ClawRouter] Port ${listenPort} still in use after ${PORT_RETRY_ATTEMPTS} attempts`,
          );
          rejectAttempt(err);
          return;
        }

        rejectAttempt(err);
      };

      server.once("error", onError);
      server.listen(listenPort, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolveAttempt();
      });
    });
  };

  // Retry loop for port binding
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= PORT_RETRY_ATTEMPTS; attempt++) {
    try {
      await tryListen(attempt);
      break; // Success
    } catch (err: unknown) {
      const error = err as {
        code?: string;
        existing?: {
          wallet: string;
          paymentChain?: string;
          authMode: AuthMode;
          apiKeyLabel?: string;
        };
        attempt?: number;
      };

      if (error.code === "REUSE_EXISTING" && error.existing) {
        // Same credential rule as the pre-listen reuse path — auth mode, API
        // key and chain must all match before this process attaches to someone
        // else's payer.
        assertExistingProxyBillsUs(error.existing, {
          listenPort,
          authMode,
          apiKeyLabel: ourApiKeyLabel,
          paymentChain,
        });

        // Proxy is running, reuse it
        const baseUrl = `http://127.0.0.1:${listenPort}`;
        options.onReady?.(listenPort);
        return {
          port: listenPort,
          baseUrl,
          walletAddress: error.existing.wallet,
          authMode,
          ...(ourApiKeyLabel ? { apiKeyLabel: ourApiKeyLabel } : {}),
          balanceMonitor,
          close: async () => {
            // No-op: we didn't start this proxy, so we shouldn't close it
          },
        };
      }

      if (error.code === "RETRY") {
        // Wait before retry
        await new Promise((r) => setTimeout(r, PORT_RETRY_DELAY_MS));
        continue;
      }

      // Other error - throw
      lastError = err as Error;
      break;
    }
  }

  if (lastError) {
    throw lastError;
  }

  // Server is now listening - set up remaining handlers
  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  options.onReady?.(port);

  // Check for updates (non-blocking)
  checkForUpdates();

  // Add runtime error handler AFTER successful listen
  // This handles errors that occur during server operation (not just startup)
  server.on("error", (err) => {
    console.error(`[ClawRouter] Server runtime error: ${err.message}`);
    options.onError?.(err);
    // Don't crash - log and continue
  });

  // Handle client connection errors (bad requests, socket errors)
  server.on("clientError", (err, socket) => {
    console.error(`[ClawRouter] Client error: ${err.message}`);
    // Send 400 Bad Request if socket is still writable
    if (socket.writable && !socket.destroyed) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
  });

  // Track connections for graceful cleanup
  server.on("connection", (socket) => {
    connections.add(socket);

    // Set 5-minute timeout for streaming requests
    socket.setTimeout(300_000);

    socket.on("timeout", () => {
      console.error(`[ClawRouter] Socket timeout, destroying connection`);
      socket.destroy();
    });

    socket.on("end", () => {
      // Half-closed by client (FIN received)
    });

    socket.on("error", (err) => {
      console.error(`[ClawRouter] Socket error: ${err.message}`);
    });

    socket.on("close", () => {
      connections.delete(socket);
    });
  });

  return {
    port,
    baseUrl,
    walletAddress: account?.address ?? "",
    solanaAddress,
    authMode,
    ...(apiKey ? { apiKeyLabel: maskApiKey(apiKey) } : {}),
    balanceMonitor,
    close: () =>
      new Promise<void>((res, rej) => {
        const timeout = setTimeout(() => {
          rej(new Error("[ClawRouter] Close timeout after 4s"));
        }, 4000);

        sessionStore.close();
        // Destroy all active connections before closing server
        for (const socket of connections) {
          socket.destroy();
        }
        connections.clear();
        server.close((err) => {
          clearTimeout(timeout);
          if (err) {
            rej(err);
          } else {
            res();
          }
        });
      }),
  };
}

/** Result of attempting a model request */
type ModelRequestResult = {
  success: boolean;
  response?: Response;
  errorBody?: string;
  errorStatus?: number;
  isProviderError?: boolean;
  errorCategory?: ErrorCategory; // Semantic error classification
  /**
   * The gateway's `x-blockrun-request-id` for the FAILED attempt.
   *
   * Without this a paid 5xx is undiagnosable from either side: the caller sees
   * only "fetch failed" or "All models failed", and nobody can point the
   * gateway at the request that broke (reported against the Solana rail,
   * ClawRouter-Hermes#38). The id is the only handle the two sides share.
   */
  upstreamRequestId?: string;
};

/**
 * Detect degenerate completions (repetition loops).
 *
 * Pattern observed in production (2026-04-16): `nvidia/kimi-k2.5` on long
 * Chinese agentic conversations returned e.g. ` 好的!!!!!!!!...` for 1024
 * tokens and hit `finish_reason: "length"`. Similar failures occur with
 * other models on certain inputs.
 *
 * Criteria (conservative to avoid false positives on markdown tables etc.):
 *   - `finish_reason` must be "length" (didn't self-terminate)
 *   - tail has ≥60 of the same punctuation char in the last 80 chars
 */
function isDegenerateCompletion(bodyBuf: Buffer): boolean {
  try {
    const parsed = JSON.parse(bodyBuf.toString()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const choice = parsed.choices?.[0];
    const finishReason = choice?.finish_reason;
    if (finishReason !== "length") return false;

    const content = choice?.message?.content ?? "";
    if (content.length < 80) return false;

    const tail = content.slice(-80);
    const tailChars = [...tail];
    const firstChar = tailChars[0];
    if (!/[^\p{L}\p{N}\s]/u.test(firstChar)) return false;

    const sameCount = tailChars.filter((c) => c === firstChar).length;
    return sameCount >= 60;
  } catch {
    return false;
  }
}

/**
 * Attempt a request with a specific model.
 * Returns the response or error details for fallback decision.
 */
async function tryModelRequest(
  upstreamUrl: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
  modelId: string,
  maxTokens: number,
  payFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  balanceMonitor: AnyBalanceMonitor,
  signal: AbortSignal,
): Promise<ModelRequestResult> {
  // Update model in body and normalize messages
  let requestBody = body;
  try {
    const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
    parsed.model = toUpstreamModelId(modelId);

    // Normalize message roles (e.g., "developer" -> "system")
    if (Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessageRoles(parsed.messages as ChatMessage[]);
    }

    // Remove "blockrun" branding from system messages so upstream LLMs don't
    // adopt "Blockrun" as their identity (overriding user's SOUL.md persona).
    if (Array.isArray(parsed.messages)) {
      parsed.messages = debrandSystemMessages(parsed.messages as ChatMessage[], modelId);
    }

    // Truncate messages to stay under BlockRun's limit (200 messages)
    if (Array.isArray(parsed.messages)) {
      const truncationResult = truncateMessages(parsed.messages as ChatMessage[]);
      parsed.messages = truncationResult.messages;
    }

    // Sanitize tool IDs to match Anthropic's pattern (alphanumeric, underscore, hyphen only)
    if (Array.isArray(parsed.messages)) {
      parsed.messages = sanitizeToolIds(parsed.messages as ChatMessage[]);
    }

    // Normalize messages for Google models (first non-system message must be "user")
    if (isGoogleModel(modelId) && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForGoogle(parsed.messages as ChatMessage[]);
    }

    // Normalize messages for thinking-enabled requests (add reasoning_content to all assistant messages)
    // Check request flags AND target model - reasoning models have thinking enabled server-side
    const hasThinkingEnabled = !!(
      parsed.thinking ||
      parsed.extended_thinking ||
      isReasoningModel(modelId)
    );
    if (hasThinkingEnabled && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForThinking(parsed.messages as ExtendedChatMessage[]);
    }

    requestBody = Buffer.from(JSON.stringify(parsed));
  } catch {
    // If body isn't valid JSON, use as-is
  }

  try {
    const response = await payFetch(upstreamUrl, {
      method,
      headers,
      body: requestBody.length > 0 ? new Uint8Array(requestBody) : undefined,
      signal,
    });

    // Check for provider errors
    if (response.status !== 200) {
      // Clone response to read body without consuming it
      const errorBodyChunks = await readBodyWithTimeout(response.body, ERROR_BODY_READ_TIMEOUT_MS);
      const errorBody = Buffer.concat(errorBodyChunks).toString();
      const category = categorizeError(response.status, errorBody);

      return {
        success: false,
        errorBody,
        errorStatus: response.status,
        isProviderError: category !== null,
        errorCategory: category ?? undefined,
        upstreamRequestId: blockrunRequestId(response),
      };
    }

    // Detect provider degradation hidden inside HTTP 200 responses.
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("json") || contentType.includes("text")) {
      try {
        const clonedChunks = await readBodyWithTimeout(
          response.clone().body,
          ERROR_BODY_READ_TIMEOUT_MS,
        );
        const responseBody = Buffer.concat(clonedChunks).toString();
        const degradedReason = detectDegradedSuccessResponse(responseBody);
        if (degradedReason) {
          return {
            success: false,
            errorBody: degradedReason,
            errorStatus: 503,
            isProviderError: true,
          };
        }
      } catch {
        // Ignore body inspection failures and pass through response.
      }
    }

    return { success: true, response };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (err instanceof SpendPolicyError) {
      // A local refusal, not an upstream fault. Retrying it walks every paid
      // model in the chain (a wasted 402 round trip each) and then lands on a
      // free model, returning HTTP 200 — so the caller never learns their
      // spend policy blocked the payment. Stop the chain here and say so.
      return {
        success: false,
        errorBody: JSON.stringify({
          error: { message: errorMsg, type: "spend_policy_denied", status: 403 },
        }),
        errorStatus: 403,
        isProviderError: false,
        errorCategory: "payment_error",
      };
    }
    // Name the connection that broke. undici collapses every network failure
    // into "fetch failed", and on the Solana rail two very different faults
    // wear that same string: the gateway being unreachable, and the Solana RPC
    // that signs the payment being unreachable. Callers see only the body, so
    // the distinction has to travel in it (ClawRouter-Hermes#38).
    const networkMsg = describeFetchError(err);
    const solanaSigningHint =
      upstreamUrl.startsWith(BLOCKRUN_SOLANA_API) && networkMsg.startsWith("fetch failed")
        ? " — on the Solana rail this may be the RPC that signs the payment rather than the gateway; if api.mainnet-beta.solana.com is unreachable from this host, set CLAWROUTER_SOLANA_RPC_URL to your own endpoint"
        : "";
    console.error(`[ClawRouter] ${modelId} network error: ${networkMsg}${solanaSigningHint}`);
    return {
      success: false,
      errorBody: `${networkMsg}${solanaSigningHint}`,
      errorStatus: 500,
      isProviderError: true, // Network errors are retryable
    };
  }
}

/**
 * Proxy a single request through x402 payment flow to BlockRun API.
 *
 * Optimizations applied in order:
 *   1. Dedup check — if same request body seen within 30s, replay cached response
 *   2. Streaming heartbeat — for stream:true, send 200 + heartbeats immediately
 *   3. Smart routing — when model is "blockrun/auto", pick cheapest capable model
 *   4. Fallback chain — on provider errors, try next model in tier's fallback list
 */
async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apiBase: string,
  payFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  options: ProxyOptions,
  routerOpts: RouterOptions,
  deduplicator: RequestDeduplicator,
  balanceMonitor: AnyBalanceMonitor,
  sessionStore: SessionStore,
  responseCache: ResponseCache,
  sessionJournal: SessionJournal,
): Promise<void> {
  const startTime = Date.now();

  // Build upstream URL: /v1/chat/completions → https://blockrun.ai/api/v1/chat/completions
  const upstreamUrl = `${apiBase}${req.url}`;

  // Collect request body
  const bodyChunks: Buffer[] = [];
  for await (const chunk of req) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let body = Buffer.concat(bodyChunks);

  // Track original context size for response headers
  const originalContextSizeKB = Math.ceil(body.length / 1024);

  // Routing debug info is on by default; disable per-request with
  // x-clawrouter-debug: false, or globally with CLAWROUTER_DEBUG_HEADERS=off
  const debugMode = debugHeadersEnabledFromEnv() && req.headers["x-clawrouter-debug"] !== "false";

  // --- Smart routing ---
  let routingDecision: RoutingDecision | undefined;
  let hasTools = false; // true when request includes a tools schema
  let requestTools: unknown; // the request's `tools` schema, for tool-aware textual recovery (#213)
  let hasVision = false; // true when request includes image_url content parts
  let isStreaming = false;
  let modelId = "";
  let maxTokens = DEFAULT_MAX_TOKENS;
  let routingProfile: "eco" | "auto" | "premium" | null = null;
  let stickyExplicitModel: string | undefined;
  let pendingShadowComparison:
    | {
        shadow: RoutingDecision;
        hasTools: boolean;
        hasVision: boolean;
        requiresStructuredOutput: boolean;
      }
    | undefined;
  let balanceFallbackNotice: string | undefined;
  let budgetDowngradeNotice: string | undefined;
  let budgetDowngradeHeaderMode: "downgraded" | undefined;
  let accumulatedContent = ""; // For session journal event extraction
  let responseInputTokens: number | undefined;
  let responseOutputTokens: number | undefined;
  /**
   * The gateway's `x-blockrun-request-id` for whichever attempt actually
   * answered. Captured here rather than read at logging time because `upstream`
   * is scoped to the fallback loop and is gone by then. See UsageEntry.requestId.
   */
  let upstreamRequestId: string | undefined;
  let requestHadError = false; // Set to true when all models fail → used in logUsage
  let requestSummaryForStore = ""; // Truncated user prompt — captured for response-store entry
  const isChatCompletion = req.url?.includes("/chat/completions");

  // Extract session ID early for journal operations (header-only at this point)
  const sessionId = getSessionId(req.headers as Record<string, string | string[] | undefined>);
  // Full session ID (header + content-derived) — populated once messages are parsed
  let effectiveSessionId: string | undefined = sessionId;

  if (isChatCompletion && body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
      isStreaming = parsed.stream === true;
      modelId = (parsed.model as string) || "";
      maxTokens = resolveMaxTokens(parsed);
      let bodyModified = false;

      // Extract last user message content (used by session journal + /debug command)
      const parsedMessages = Array.isArray(parsed.messages)
        ? (parsed.messages as Array<{ role: string; content: unknown }>)
        : [];
      const lastUserMsg = [...parsedMessages].reverse().find((m) => m.role === "user");

      // Capture a short prompt summary for the response-store entry (used by
      // `clawrouter share list` to identify which response is which).
      {
        const c = lastUserMsg?.content;
        let promptText = "";
        if (typeof c === "string") {
          promptText = c;
        } else if (Array.isArray(c)) {
          promptText = (c as Array<{ type?: string; text?: string }>)
            .filter((b) => typeof b === "object" && b !== null && b.type === "text")
            .map((b) => b.text ?? "")
            .join(" ")
            .trim();
        }
        requestSummaryForStore = summarizeRequest(promptText);
      }

      // Early tool detection for ALL request types (explicit model + routing profile).
      // The routing-profile branch may re-assign below (no-op since same value).
      hasTools = Array.isArray(parsed.tools) && (parsed.tools as unknown[]).length > 0;
      requestTools = parsed.tools;

      // Preserve OpenClaw tool schemas exactly as provided.
      // Stripping tools like web_search/web_fetch/browser/exec makes the upstream
      // model believe those capabilities do not exist, which breaks agentic runs.
      // Reliability is handled later via agentic routing and tool-support filters.

      const rawLastContent = lastUserMsg?.content;
      const lastContent =
        typeof rawLastContent === "string"
          ? rawLastContent
          : Array.isArray(rawLastContent)
            ? (rawLastContent as Array<{ type: string; text?: string }>)
                .filter((b) => b.type === "text")
                .map((b) => b.text ?? "")
                .join(" ")
            : "";

      // --- Session Journal: Inject context if needed ---
      // Check if the last user message asks about past work
      if (sessionId && parsedMessages.length > 0) {
        const messages = parsedMessages;

        if (sessionJournal.needsContext(lastContent)) {
          const journalText = sessionJournal.format(sessionId);
          if (journalText) {
            // Find system message and prepend journal, or add a new system message
            const sysIdx = messages.findIndex((m) => m.role === "system");
            if (sysIdx >= 0 && typeof messages[sysIdx].content === "string") {
              messages[sysIdx] = {
                ...messages[sysIdx],
                content: journalText + "\n\n" + messages[sysIdx].content,
              };
            } else {
              messages.unshift({ role: "system", content: journalText });
            }
            parsed.messages = messages;
            bodyModified = true;
            console.log(
              `[ClawRouter] Injected session journal (${journalText.length} chars) for session ${sessionId.slice(0, 8)}...`,
            );
          }
        }
      }

      // --- /debug command: return routing diagnostics without calling upstream ---
      if (lastContent.startsWith("/debug")) {
        const debugPrompt = lastContent.slice("/debug".length).trim() || "hello";
        const messages = parsed.messages as Array<{ role: string; content: unknown }>;
        const systemMsg = messages?.find((m) => m.role === "system");
        const systemPrompt = typeof systemMsg?.content === "string" ? systemMsg.content : undefined;
        const fullText = `${systemPrompt ?? ""} ${debugPrompt}`;
        const estimatedTokens = Math.ceil(fullText.length / 4);

        // Determine routing profile
        const normalizedModel =
          typeof parsed.model === "string" ? parsed.model.trim().toLowerCase() : "";
        const profileName = normalizedModel.replace("blockrun/", "");
        const debugProfile = (
          ["eco", "auto", "premium"].includes(profileName) ? profileName : "auto"
        ) as "eco" | "auto" | "premium";

        // Run scoring
        const scoring = classifyByRules(
          debugPrompt,
          systemPrompt,
          estimatedTokens,
          DEFAULT_ROUTING_CONFIG.scoring,
        );

        // Run full routing decision
        const debugRouting = route(debugPrompt, systemPrompt, maxTokens, {
          ...routerOpts,
          routingProfile: debugProfile,
        });

        // Format dimension scores
        const dimLines = (scoring.dimensions ?? [])
          .map((d) => {
            const nameStr = (d.name + ":").padEnd(24);
            const scoreStr = d.score.toFixed(2).padStart(6);
            const sigStr = d.signal ? `  [${d.signal}]` : "";
            return `  ${nameStr}${scoreStr}${sigStr}`;
          })
          .join("\n");

        // Session info
        const sess = sessionId ? sessionStore.getSession(sessionId) : undefined;
        const sessLine = sess
          ? `Session: ${sessionId!.slice(0, 8)}... → pinned: ${sess.model} (${sess.requestCount} requests)`
          : sessionId
            ? `Session: ${sessionId.slice(0, 8)}... → no pinned model`
            : "Session: none";

        const { simpleMedium, mediumComplex, complexReasoning } =
          DEFAULT_ROUTING_CONFIG.scoring.tierBoundaries;

        const debugText = [
          "ClawRouter Debug",
          "",
          `Profile: ${debugProfile} | Tier: ${debugRouting.tier} | Model: ${debugRouting.model}`,
          `Confidence: ${debugRouting.confidence.toFixed(2)} | Cost: $${debugRouting.costEstimate.toFixed(4)} | Savings: ${(debugRouting.savings * 100).toFixed(0)}%`,
          `Reasoning: ${debugRouting.reasoning}`,
          "",
          `Scoring (weighted: ${scoring.score.toFixed(3)})`,
          dimLines,
          "",
          `Tier Boundaries: SIMPLE <${simpleMedium.toFixed(2)} | MEDIUM <${mediumComplex.toFixed(2)} | COMPLEX <${complexReasoning.toFixed(2)} | REASONING >=${complexReasoning.toFixed(2)}`,
          "",
          sessLine,
        ].join("\n");

        // Build synthetic OpenAI chat completion response
        const completionId = `chatcmpl-debug-${Date.now()}`;
        const timestamp = Math.floor(Date.now() / 1000);
        const syntheticResponse = {
          id: completionId,
          object: "chat.completion",
          created: timestamp,
          model: "clawrouter/debug",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: debugText },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };

        if (isStreaming) {
          // SSE streaming response
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const sseChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created: timestamp,
            model: "clawrouter/debug",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: debugText },
                finish_reason: null,
              },
            ],
          };
          const sseDone = {
            id: completionId,
            object: "chat.completion.chunk",
            created: timestamp,
            model: "clawrouter/debug",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
          res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
          res.write(`data: ${JSON.stringify(sseDone)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(syntheticResponse));
        }
        console.log(`[ClawRouter] /debug command → ${debugRouting.tier} | ${debugRouting.model}`);
        return;
      }

      // --- /cr-imagegen (and legacy /imagegen) command: generate an image via BlockRun image API ---
      // The OpenClaw plugin command is registered as `/cr-imagegen` to avoid
      // colliding with Telegram channel commands. The legacy `/imagegen` prefix
      // is still accepted here for backward compatibility in chat input.
      const imagegenMatch = lastContent.startsWith("/cr-imagegen")
        ? "/cr-imagegen"
        : lastContent.startsWith("/imagegen")
          ? "/imagegen"
          : null;
      if (imagegenMatch) {
        const imageArgs = lastContent.slice(imagegenMatch.length).trim();

        // Parse optional flags: /cr-imagegen --model gpt-image-2 --size 1536x1024 a cute cat
        let imageModel = "google/nano-banana";
        let imageSize = "1024x1024";
        let imagePrompt = imageArgs;

        // Extract --model flag
        const modelMatch = imageArgs.match(/--model\s+(\S+)/);
        if (modelMatch) {
          const raw = modelMatch[1];
          // Resolve shorthand aliases (module-scope map, pinned by tests).
          // hasOwnProperty guard: a plain-object lookup would resolve prototype
          // keys ("constructor", "toString") to functions, which JSON.stringify
          // then drops — sending a model-less body upstream.
          imageModel = Object.prototype.hasOwnProperty.call(IMAGE_MODEL_ALIASES, raw)
            ? IMAGE_MODEL_ALIASES[raw]
            : raw;
          imagePrompt = imagePrompt.replace(/--model\s+\S+/, "").trim();
        }

        // Extract --size flag
        const sizeMatch = imageArgs.match(/--size\s+(\d+x\d+)/);
        if (sizeMatch) {
          imageSize = sizeMatch[1];
          imagePrompt = imagePrompt.replace(/--size\s+\d+x\d+/, "").trim();
        }

        if (!imagePrompt) {
          const errorText = [
            "Usage: /cr-imagegen <prompt>",
            "",
            "Options:",
            "  --model <model>  Model to use (default: nano-banana)",
            "  --size <WxH>     Image size (default: 1024x1024)",
            "",
            "Models:",
            "  nano-banana       Google Gemini Flash — $0.05/image",
            "  banana-2          Google Nano Banana 2 — $0.09/image",
            "  banana-pro        Google Gemini Pro — $0.10/image (up to 4K)",
            "  gpt-image         OpenAI GPT Image 1 — $0.02/image",
            "  gpt-image-2       OpenAI GPT Image 2 — $0.06/image",
            "  seedream          ByteDance Seedream 5 Pro — $0.045/image",
            "  grok-imagine      xAI Grok Imagine — $0.02/image",
            "  grok-imagine-pro  xAI Grok Imagine Pro — $0.07/image",
            "  cogview           Zhipu CogView-4 — $0.015/image",
            "",
            "Examples:",
            "  /cr-imagegen a cat wearing sunglasses",
            "  /cr-imagegen --model gpt-image-2 a futuristic city at sunset",
            "  /cr-imagegen --model banana-pro --size 2048x2048 mountain landscape",
            "",
            "Note: `/imagegen` is still accepted in chat for backward compatibility.",
          ].join("\n");

          const completionId = `chatcmpl-image-${Date.now()}`;
          const timestamp = Math.floor(Date.now() / 1000);
          if (isStreaming) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(
              `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "clawrouter/image", choices: [{ index: 0, delta: { role: "assistant", content: errorText }, finish_reason: null }] })}\n\n`,
            );
            res.write(
              `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "clawrouter/image", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                id: completionId,
                object: "chat.completion",
                created: timestamp,
                model: "clawrouter/image",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: errorText },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              }),
            );
          }
          console.log(`[ClawRouter] /imagegen command → showing usage help`);
          return;
        }

        // Call upstream image generation API
        console.log(
          `[ClawRouter] /imagegen command → ${imageModel} (${imageSize}): ${imagePrompt.slice(0, 80)}...`,
        );
        // Stop upstream work (especially the slow-model poll loop below,
        // whose first `completed` poll settles the x402 payment) if the
        // chat client goes away mid-generation. Declared outside the try so
        // the catch below can tell a client abort from a real failure.
        const imagegenAbort = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) imagegenAbort.abort();
        });
        try {
          const imageUpstreamUrl = `${apiBase}/v1/images/generations`;
          const imageBody = JSON.stringify({
            model: imageModel,
            prompt: imagePrompt,
            size: imageSize,
            n: 1,
          });
          publishDispatchCost(estimateImageCost(imageModel, imageSize, 1));
          const imageResponse = await payFetch(imageUpstreamUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": USER_AGENT },
            body: imageBody,
            signal: imagegenAbort.signal,
          });

          type ImagegenResult = {
            created?: number;
            data?: Array<{ url?: string; revised_prompt?: string }>;
            error?: string | { message?: string };
            id?: string;
            poll_url?: string;
            status?: string;
          };
          let imageResult = (await imageResponse.json()) as ImagegenResult;
          let imageFailure: string | undefined;

          // Slow path — BlockRun returned 202 + poll_url (model exceeded the
          // 30s inline window, e.g. openai/gpt-image-2). Response.ok is true
          // for 202 and data[] is absent, so without this branch the paid job
          // would surface as "returned no results". Mirrors the poll loop in
          // the /v1/images/generations handler above.
          if (
            imageResponse.ok &&
            imageResult.poll_url &&
            imageResult.id &&
            !imageResult.data?.length
          ) {
            const apiOrigin = new URL(apiBase).origin;
            const pollUrl = imageResult.poll_url.startsWith("http")
              ? imageResult.poll_url
              : `${apiOrigin}${imageResult.poll_url}`;
            console.log(
              `[ClawRouter] /imagegen job submitted (id=${imageResult.id}), polling upstream — typical 30–120s...`,
            );
            // Poll every 3s, bail after ~5min total. Server auth window is 10min.
            const pollDeadline = Date.now() + 300_000;
            await new Promise((r) => setTimeout(r, 2_000));
            let completed = false;
            while (Date.now() < pollDeadline) {
              if (imagegenAbort.signal.aborted) {
                console.log(
                  `[ClawRouter] Chat client disconnected — abandoning image poll (id=${imageResult.id})`,
                );
                return;
              }
              const pollResp = await payFetch(pollUrl, {
                method: "GET",
                headers: { "user-agent": USER_AGENT },
                signal: imagegenAbort.signal,
              });
              const pollText = await pollResp.text();
              let pollBody: ImagegenResult = {};
              try {
                pollBody = JSON.parse(pollText) as ImagegenResult;
              } catch {
                imageFailure = `Non-JSON poll response (${pollResp.status}): ${pollText.slice(0, 200)}`;
                break;
              }
              if (
                pollResp.status === 202 ||
                pollBody.status === "queued" ||
                pollBody.status === "in_progress"
              ) {
                await new Promise((r) => setTimeout(r, 3_000));
                continue;
              }
              if (pollBody.status === "failed" || !pollResp.ok) {
                imageFailure =
                  typeof pollBody.error === "string"
                    ? pollBody.error
                    : ((pollBody.error as { message?: string })?.message ??
                      `Upstream image generation failed (HTTP ${pollResp.status})`);
                break;
              }
              // completed, or OK with an unrecognized shape — hand through.
              imageResult = pollBody;
              completed = true;
              break;
            }
            if (!completed && !imageFailure) {
              imageFailure =
                "Image generation timed out after 5 minutes — the job may still complete upstream.";
            }
          }

          let responseText: string;
          if (imageFailure) {
            responseText = `Image generation failed: ${imageFailure}`;
            console.log(`[ClawRouter] /imagegen error: ${imageFailure}`);
          } else if (!imageResponse.ok || imageResult.error) {
            const errMsg =
              typeof imageResult.error === "string"
                ? imageResult.error
                : ((imageResult.error as { message?: string })?.message ??
                  `HTTP ${imageResponse.status}`);
            responseText = `Image generation failed: ${errMsg}`;
            console.log(`[ClawRouter] /imagegen error: ${errMsg}`);
          } else {
            const images = imageResult.data ?? [];
            if (images.length === 0) {
              responseText = "Image generation returned no results.";
            } else {
              const lines: string[] = [];
              for (const img of images) {
                if (img.url) {
                  if (img.url.startsWith("data:")) {
                    try {
                      const hostedUrl = await uploadDataUriToHost(img.url);
                      lines.push(hostedUrl);
                    } catch (uploadErr) {
                      console.error(
                        `[ClawRouter] /imagegen: failed to upload data URI: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`,
                      );
                      lines.push("Image generated but upload failed. Try again.");
                    }
                  } else {
                    lines.push(img.url);
                  }
                }
                if (img.revised_prompt) lines.push(`Revised prompt: ${img.revised_prompt}`);
              }
              lines.push("", `Model: ${imageModel} | Size: ${imageSize}`);
              responseText = lines.join("\n");
            }
            console.log(`[ClawRouter] /imagegen success: ${images.length} image(s) generated`);
            // Log /imagegen usage with actual x402 payment
            const imagegenActualCost = settledMediaCostUsd(
              imageResponse,
              imageResult,
              paymentStore.getStore()?.amountUsd,
              estimateImageCost(imageModel, imageSize, 1),
            );
            logUsage({
              timestamp: new Date().toISOString(),
              ...(blockrunRequestId(imageResponse)
                ? { requestId: blockrunRequestId(imageResponse) }
                : {}),
              model: imageModel,
              tier: "IMAGE",
              cost: imagegenActualCost,
              baselineCost: imagegenActualCost,
              savings: 0,
              latencyMs: 0,
            }).catch(() => {});
          }

          // Return as synthetic chat completion
          const completionId = `chatcmpl-image-${Date.now()}`;
          const timestamp = Math.floor(Date.now() / 1000);
          if (isStreaming) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(
              `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "clawrouter/image", choices: [{ index: 0, delta: { role: "assistant", content: responseText }, finish_reason: null }] })}\n\n`,
            );
            res.write(
              `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "clawrouter/image", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                id: completionId,
                object: "chat.completion",
                created: timestamp,
                model: "clawrouter/image",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: responseText },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              }),
            );
          }
        } catch (err) {
          if (imagegenAbort.signal.aborted) return; // client gone — nothing to report
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[ClawRouter] /imagegen error: ${errMsg}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: { message: `Image generation failed: ${errMsg}`, type: "image_error" },
              }),
            );
          }
        }
        return;
      }

      // --- /img2img command: edit an image via BlockRun image2image API ---
      if (lastContent.startsWith("/img2img")) {
        const imgArgs = lastContent.slice("/img2img".length).trim();

        let img2imgModel = "openai/gpt-image-1";
        let img2imgSize = "1024x1024";
        let imagePath: string | null = null;
        let maskPath: string | null = null;
        let img2imgPrompt = imgArgs;

        const imageMatch = imgArgs.match(/--image\s+(\S+)/);
        if (imageMatch) {
          imagePath = imageMatch[1];
          img2imgPrompt = img2imgPrompt.replace(/--image\s+\S+/, "").trim();
        }

        const maskMatch = imgArgs.match(/--mask\s+(\S+)/);
        if (maskMatch) {
          maskPath = maskMatch[1];
          img2imgPrompt = img2imgPrompt.replace(/--mask\s+\S+/, "").trim();
        }

        const img2imgSizeMatch = imgArgs.match(/--size\s+(\d+x\d+)/);
        if (img2imgSizeMatch) {
          img2imgSize = img2imgSizeMatch[1];
          img2imgPrompt = img2imgPrompt.replace(/--size\s+\d+x\d+/, "").trim();
        }

        const img2imgModelMatch = imgArgs.match(/--model\s+(\S+)/);
        if (img2imgModelMatch) {
          const raw = img2imgModelMatch[1];
          const IMG2IMG_ALIASES: Record<string, string> = {
            "gpt-image": "openai/gpt-image-1",
            "gpt-image-1": "openai/gpt-image-1",
          };
          img2imgModel = IMG2IMG_ALIASES[raw] ?? raw;
          img2imgPrompt = img2imgPrompt.replace(/--model\s+\S+/, "").trim();
        }

        const usageText = [
          "Usage: /img2img --image <path> <prompt>",
          "",
          "Options:",
          "  --image <path>   Source image path (required)",
          "  --mask <path>    Mask image path (optional, white = area to edit)",
          "  --model <model>  Model (default: gpt-image-1)",
          "  --size <WxH>     Output size (default: 1024x1024)",
          "",
          "Models:",
          "  gpt-image-1      OpenAI GPT Image 1 — $0.02/image",
          "",
          "Examples:",
          "  /img2img --image ~/photo.png change background to starry sky",
          "  /img2img --image ./cat.jpg --mask ./mask.png remove the background",
          "  /img2img --image /tmp/portrait.png --size 1536x1024 add a hat",
        ].join("\n");

        const sendImg2ImgText = (text: string) => {
          const completionId = `chatcmpl-img2img-${Date.now()}`;
          const timestamp = Math.floor(Date.now() / 1000);
          if (isStreaming) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(
              `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "clawrouter/img2img", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
            );
            res.write(
              `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "clawrouter/img2img", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                id: completionId,
                object: "chat.completion",
                created: timestamp,
                model: "clawrouter/img2img",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: text },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              }),
            );
          }
        };

        if (!imagePath || !img2imgPrompt) {
          sendImg2ImgText(usageText);
          return;
        }

        let imageDataUri: string;
        let maskDataUri: string | undefined;
        try {
          imageDataUri = readImageFileAsDataUri(imagePath);
          if (maskPath) maskDataUri = readImageFileAsDataUri(maskPath);
        } catch (fileErr) {
          const fileErrMsg = fileErr instanceof Error ? fileErr.message : String(fileErr);
          sendImg2ImgText(`Failed to read image file: ${fileErrMsg}`);
          return;
        }

        console.log(
          `[ClawRouter] /img2img → ${img2imgModel} (${img2imgSize}): ${img2imgPrompt.slice(0, 80)}`,
        );

        // Same class as #251: abort the paid upstream call if the chat
        // client goes away, mirroring the /imagegen handler above.
        const img2imgAbort = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) img2imgAbort.abort();
        });
        try {
          const img2imgBody = JSON.stringify({
            model: img2imgModel,
            prompt: img2imgPrompt,
            image: imageDataUri,
            ...(maskDataUri ? { mask: maskDataUri } : {}),
            size: img2imgSize,
            n: 1,
          });

          publishDispatchCost(estimateImageCost(img2imgModel, img2imgSize, 1));
          const img2imgResponse = await payFetch(`${apiBase}/v1/images/image2image`, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": USER_AGENT },
            body: img2imgBody,
            signal: img2imgAbort.signal,
          });

          const img2imgResult = (await img2imgResponse.json()) as {
            created?: number;
            data?: Array<{ url?: string; revised_prompt?: string }>;
            error?: string | { message?: string };
          };

          let responseText: string;
          if (!img2imgResponse.ok || img2imgResult.error) {
            const errMsg =
              typeof img2imgResult.error === "string"
                ? img2imgResult.error
                : ((img2imgResult.error as { message?: string })?.message ??
                  `HTTP ${img2imgResponse.status}`);
            responseText = `Image editing failed: ${errMsg}`;
            console.log(`[ClawRouter] /img2img error: ${errMsg}`);
          } else {
            const images = img2imgResult.data ?? [];
            if (images.length === 0) {
              responseText = "Image editing returned no results.";
            } else {
              const lines: string[] = [];
              for (const img of images) {
                if (img.url) {
                  if (img.url.startsWith("data:")) {
                    try {
                      const hostedUrl = await uploadDataUriToHost(img.url);
                      lines.push(hostedUrl);
                    } catch (uploadErr) {
                      console.error(
                        `[ClawRouter] /img2img: failed to upload data URI: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`,
                      );
                      lines.push("Image edited but upload failed. Try again.");
                    }
                  } else {
                    lines.push(img.url);
                  }
                }
                if (img.revised_prompt) lines.push(`Revised prompt: ${img.revised_prompt}`);
              }
              lines.push("", `Model: ${img2imgModel} | Size: ${img2imgSize}`);
              responseText = lines.join("\n");
            }
            console.log(`[ClawRouter] /img2img success: ${images.length} image(s)`);
            // Log /img2img usage with actual x402 payment
            const img2imgActualCost2 = settledMediaCostUsd(
              img2imgResponse,
              img2imgResult,
              paymentStore.getStore()?.amountUsd,
              estimateImageCost(img2imgModel, img2imgSize, 1),
            );
            logUsage({
              timestamp: new Date().toISOString(),
              ...(blockrunRequestId(img2imgResponse)
                ? { requestId: blockrunRequestId(img2imgResponse) }
                : {}),
              model: img2imgModel,
              tier: "IMAGE",
              cost: img2imgActualCost2,
              baselineCost: img2imgActualCost2,
              savings: 0,
              latencyMs: 0,
            }).catch(() => {});
          }

          sendImg2ImgText(responseText);
        } catch (err) {
          if (img2imgAbort.signal.aborted) return; // client gone — nothing to report
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[ClawRouter] /img2img error: ${errMsg}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: { message: `Image editing failed: ${errMsg}`, type: "img2img_error" },
              }),
            );
          }
        }
        return;
      }

      // Force stream: false — BlockRun API doesn't support streaming yet
      // ClawRouter handles SSE heartbeat simulation for upstream compatibility
      if (parsed.stream === true) {
        parsed.stream = false;
        bodyModified = true;
      }

      // Normalize model name for comparison (trim whitespace, lowercase)
      const normalizedModel =
        typeof parsed.model === "string" ? parsed.model.trim().toLowerCase() : "";

      // Resolve model aliases (e.g., "claude" -> "anthropic/claude-sonnet-4-6")
      const resolvedModel = resolveModelAlias(normalizedModel);
      const wasAlias = resolvedModel !== normalizedModel;

      // Check both normalizedModel and resolvedModel — OpenClaw may send "openai/eco"
      // which resolveModelAlias strips to "eco" (a valid routing profile)
      const isRoutingProfile =
        ROUTING_PROFILES.has(normalizedModel) || ROUTING_PROFILES.has(resolvedModel);

      // Extract routing profile type (free/eco/auto/premium)
      if (isRoutingProfile) {
        const profileName = resolvedModel.replace("blockrun/", "");
        routingProfile = profileName as "eco" | "auto" | "premium";
      }

      // Debug: log received model name
      console.log(
        `[ClawRouter] Received model: "${parsed.model}" -> normalized: "${normalizedModel}"${wasAlias ? ` -> alias: "${resolvedModel}"` : ""}${routingProfile ? `, profile: ${routingProfile}` : ""}`,
      );

      // For explicit model requests, always canonicalize the model ID before upstream calls.
      // This ensures case/whitespace variants (e.g. "DEEPSEEK/..." or "  model  ") route correctly.
      if (!isRoutingProfile) {
        if (parsed.model !== resolvedModel) {
          parsed.model = resolvedModel;
          bodyModified = true;
        }
        modelId = resolvedModel;

        // User explicitly chose this model — pin it to the session as a sticky
        // user-explicit pin. Future requests in the same session that come in
        // as routing profiles (e.g. blockrun/auto from OpenClaw's default
        // chat path) will respect this choice instead of re-routing.
        // This fixes the bug where /model in OpenClaw appeared to switch the
        // model (UI confirmed) but subsequent messages still used the
        // previously pinned auto-routed model.
        const explicitPinSessionId =
          getSessionId(req.headers as Record<string, string | string[] | undefined>) ??
          deriveSessionId(parsedMessages);
        if (explicitPinSessionId) {
          // Use a generic tier — the explicit pin bypasses tier comparison anyway.
          sessionStore.setSession(explicitPinSessionId, resolvedModel, "MEDIUM", true);
          console.log(
            `[ClawRouter] Session ${explicitPinSessionId.slice(0, 8)}... user-explicit pin set: ${resolvedModel}`,
          );
        }
      }

      // Handle routing profiles (free/eco/auto/premium)
      if (isRoutingProfile) {
        {
          // eco/auto/premium - use tier routing
          // Check for session persistence - use pinned model if available
          // Fall back to deriving a session ID from message content when OpenClaw
          // doesn't send an explicit x-session-id header (the default behaviour).
          effectiveSessionId =
            getSessionId(req.headers as Record<string, string | string[] | undefined>) ??
            deriveSessionId(parsedMessages);
          const existingSession = effectiveSessionId
            ? sessionStore.getSession(effectiveSessionId)
            : undefined;

          // Extract prompt from last user message (handles both string and Anthropic array content)
          const rawPrompt = lastUserMsg?.content;
          const prompt =
            typeof rawPrompt === "string"
              ? rawPrompt
              : Array.isArray(rawPrompt)
                ? (rawPrompt as Array<{ type: string; text?: string }>)
                    .filter((b) => b.type === "text")
                    .map((b) => b.text ?? "")
                    .join(" ")
                : "";
          const systemMsg = parsedMessages.find((m) => m.role === "system");
          const systemPrompt =
            typeof systemMsg?.content === "string" ? systemMsg.content : undefined;

          // Tool detection — when tools are present, force agentic tiers for reliable tool use
          const tools = parsed.tools as unknown[] | undefined;
          hasTools = Array.isArray(tools) && tools.length > 0;
          const requiresTools =
            hasTools && inferToolRequirement(prompt, systemPrompt, parsed.tool_choice);
          const toolNames = (tools ?? [])
            .map((tool) => {
              if (typeof tool !== "object" || tool === null) return undefined;
              const fn = (tool as { function?: unknown }).function;
              if (typeof fn !== "object" || fn === null) return undefined;
              const name = (fn as { name?: unknown }).name;
              return typeof name === "string" ? name : undefined;
            })
            .filter((name): name is string => name !== undefined);

          if (hasTools && tools) {
            console.log(`[ClawRouter] Tools detected (${tools.length}), required=${requiresTools}`);
          }

          // Vision detection: scan messages for image_url content parts
          hasVision = parsedMessages.some((m) => {
            if (Array.isArray(m.content)) {
              return (m.content as Array<{ type: string }>).some((p) => p.type === "image_url");
            }
            return false;
          });
          if (hasVision) {
            console.log(`[ClawRouter] Vision content detected, filtering to vision-capable models`);
          }

          // Always route based on current request content
          routingDecision = route(prompt, systemPrompt, maxTokens, {
            ...routerOpts,
            routingProfile: routingProfile ?? undefined,
            hasTools,
            toolCount: tools?.length ?? 0,
            toolNames,
            requiresTools,
            hasVision,
            requiresStructuredOutput:
              typeof parsed.response_format === "object" && parsed.response_format !== null,
          });

          // Shadow routing is deliberately local-only: compare metadata for a
          // sampled request without changing the serving model or making a
          // second paid upstream call.
          const shadow = routerOpts.config.shadow;
          const activeStrategy = routerOpts.config.strategy ?? "portfolio";
          const shadowRate = Math.max(0, Math.min(1, shadow?.sampleRate ?? 1));
          if (shadow && shadow.strategy !== activeStrategy && Math.random() < shadowRate) {
            const requiresStructuredOutput =
              typeof parsed.response_format === "object" && parsed.response_format !== null;
            const shadowDecision = route(prompt, systemPrompt, maxTokens, {
              ...routerOpts,
              config: { ...routerOpts.config, strategy: shadow.strategy },
              routingProfile: routingProfile ?? undefined,
              hasTools,
              toolCount: tools?.length ?? 0,
              toolNames,
              requiresTools,
              hasVision,
              requiresStructuredOutput,
            });
            pendingShadowComparison = {
              shadow: shadowDecision,
              hasTools,
              hasVision,
              requiresStructuredOutput,
            };
          }

          // Keep agentic routing when tools are present, even for SIMPLE queries.
          // Tool-using requests need models with reliable function-call support;
          // demoting to non-agentic tiers causes fallback to models that refuse
          // tool schemas (gemini-flash-lite, deepseek) or lack tool support entirely.
          if (hasTools && routingDecision.tier === "SIMPLE") {
            console.log(
              `[ClawRouter] SIMPLE+tools: keeping agentic model ${routingDecision.model} (tools need reliable function-call support)`,
            );
          }

          if (existingSession) {
            // If the session was pinned by an explicit user choice (e.g. via
            // /model command), respect it unconditionally. The user's intent
            // wins over auto-routing tier escalation. This fixes the bug where
            // running /model blockrun/free/glm-4.7 didn't actually switch the
            // model, because the next request (which OpenClaw still sends as
            // a routing profile) would re-route through tier comparison.
            //
            // We override the routing decision and let execution fall through
            // to the upstream call below — without this short-circuit, the
            // tier-rank logic could downgrade or escalate away from the
            // user's choice.
            if (existingSession.userExplicit) {
              stickyExplicitModel = existingSession.model;
              console.log(
                `[ClawRouter] Session ${effectiveSessionId?.slice(0, 8)}... user-explicit pin: ${existingSession.model} (overriding auto-routed ${routingDecision.tier} → ${routingDecision.model})`,
              );
              parsed.model = existingSession.model;
              modelId = existingSession.model;
              bodyModified = true;
              sessionStore.touchSession(effectiveSessionId!);
              routingDecision = {
                ...routingDecision,
                model: existingSession.model,
                tier: existingSession.tier as Tier,
              };
              // Skip the rest of the existingSession branches; explicit pin wins.
            } else {
              // Never downgrade: only upgrade the session when the current request needs a higher
              // tier. This fixes the OpenClaw startup-message bias (the startup message always
              // scores low-complexity, which previously pinned all subsequent real queries to a
              // cheap model) while still preventing mid-task model switching on simple follow-ups.
              const tierRank: Record<string, number> = {
                SIMPLE: 0,
                MEDIUM: 1,
                COMPLEX: 2,
                REASONING: 3,
              };
              const existingRank = tierRank[existingSession.tier] ?? 0;
              const newRank = tierRank[routingDecision.tier] ?? 0;

              if (newRank > existingRank) {
                // Current request needs higher capability — upgrade the session
                console.log(
                  `[ClawRouter] Session ${effectiveSessionId?.slice(0, 8)}... upgrading: ${existingSession.tier} → ${routingDecision.tier} (${routingDecision.model})`,
                );
                parsed.model = routingDecision.model;
                modelId = routingDecision.model;
                bodyModified = true;
                if (effectiveSessionId) {
                  sessionStore.setSession(
                    effectiveSessionId,
                    routingDecision.model,
                    routingDecision.tier,
                  );
                }
              } else if (routingDecision.tier === "SIMPLE") {
                // SIMPLE follow-up in an active session: let it use cheap routing.
                // e.g. "你好" or "thanks" after a complex task should not inherit the
                // expensive session model or recount all context tokens on a paid model.
                console.log(
                  `[ClawRouter] Session ${effectiveSessionId?.slice(0, 8)}... SIMPLE follow-up, using cheap model: ${routingDecision.model} (bypassing pinned ${existingSession.tier})`,
                );
                parsed.model = routingDecision.model;
                modelId = routingDecision.model;
                bodyModified = true;
                sessionStore.touchSession(effectiveSessionId!);
                // routingDecision already reflects cheap model — no override needed
              } else {
                // Keep existing higher-tier model (prevent downgrade mid-task)
                console.log(
                  `[ClawRouter] Session ${effectiveSessionId?.slice(0, 8)}... keeping pinned model: ${existingSession.model} (${existingSession.tier} >= ${routingDecision.tier})`,
                );
                parsed.model = existingSession.model;
                modelId = existingSession.model;
                bodyModified = true;
                sessionStore.touchSession(effectiveSessionId!);
                // Reflect the actual model used in the routing decision for logging/fallback
                routingDecision = {
                  ...routingDecision,
                  model: existingSession.model,
                  tier: existingSession.tier as Tier,
                };
              }

              // --- Three-strike escalation: detect repetitive request patterns ---
              const lastAssistantMsg = [...parsedMessages]
                .reverse()
                .find((m) => m.role === "assistant");
              const assistantToolCalls = (
                lastAssistantMsg as { tool_calls?: Array<{ function?: { name?: string } }> }
              )?.tool_calls;
              const toolCallNames = Array.isArray(assistantToolCalls)
                ? assistantToolCalls
                    .map((tc) => tc.function?.name)
                    .filter((n): n is string => Boolean(n))
                : undefined;
              const contentHash = hashRequestContent(prompt, toolCallNames);
              const shouldEscalate = sessionStore.recordRequestHash(
                effectiveSessionId!,
                contentHash,
              );

              if (shouldEscalate) {
                const activeTierConfigs = routingDecision.tierConfigs ?? routerOpts.config.tiers;

                const escalation = sessionStore.escalateSession(
                  effectiveSessionId!,
                  activeTierConfigs,
                );
                if (escalation) {
                  console.log(
                    `[ClawRouter] ⚡ 3-strike escalation: ${existingSession.model} → ${escalation.model} (${existingSession.tier} → ${escalation.tier})`,
                  );
                  parsed.model = escalation.model;
                  modelId = escalation.model;
                  routingDecision = {
                    ...routingDecision,
                    model: escalation.model,
                    tier: escalation.tier as Tier,
                  };
                }
              }
            } // close `else` (auto-routed branch)
          } else {
            // No session — pin this routing decision for future requests
            parsed.model = routingDecision.model;
            modelId = routingDecision.model;
            bodyModified = true;
            if (effectiveSessionId) {
              sessionStore.setSession(
                effectiveSessionId,
                routingDecision.model,
                routingDecision.tier,
              );
              console.log(
                `[ClawRouter] Session ${effectiveSessionId.slice(0, 8)}... pinned to model: ${routingDecision.model}`,
              );
            }
          }

          if (pendingShadowComparison) {
            try {
              options.onShadowRouted?.({
                executed: routingDecision,
                shadow: pendingShadowComparison.shadow,
                sameModel: routingDecision.model === pendingShadowComparison.shadow.model,
                hasTools: pendingShadowComparison.hasTools,
                hasVision: pendingShadowComparison.hasVision,
                requiresStructuredOutput: pendingShadowComparison.requiresStructuredOutput,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.warn(`[ClawRouter] Shadow routing callback failed: ${message}`);
            }
          }
          options.onRouted?.(routingDecision);
        }
      }

      // Ensure effectiveSessionId is set for explicit model requests via content hash fallback.
      // Routing profile requests already derive session ID from message content (see line above).
      // Explicit model requests (openai/gpt-4o, anthropic/claude-*, etc.) without an
      // x-session-id header would otherwise have no session ID → maxCostPerRun not tracked.
      if (!effectiveSessionId && parsedMessages.length > 0) {
        effectiveSessionId = deriveSessionId(parsedMessages);
      }

      // Rebuild body if modified — map free/xxx → nvidia/xxx for upstream
      if (bodyModified) {
        if (parsed.model && typeof parsed.model === "string") {
          parsed.model = toUpstreamModelId(parsed.model);
        }
        body = Buffer.from(JSON.stringify(parsed));
      }
    } catch (err) {
      // Log routing errors so they're not silently swallowed
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[ClawRouter] Routing error: ${errorMsg}`);
      console.error(`[ClawRouter] Need help? Run: npx @blockrun/clawrouter doctor`);
      options.onError?.(new Error(`Routing failed: ${errorMsg}`));
    }
  }

  // --- Auto-compression ---
  // Compress large requests to reduce network usage and improve performance
  const autoCompress = options.autoCompressRequests ?? true;
  const compressionThreshold = options.compressionThresholdKB ?? 180;
  const requestSizeKB = Math.ceil(body.length / 1024);

  if (autoCompress && requestSizeKB > compressionThreshold) {
    try {
      console.log(
        `[ClawRouter] Request size ${requestSizeKB}KB exceeds threshold ${compressionThreshold}KB, applying compression...`,
      );

      // Parse messages for compression
      const parsed = JSON.parse(body.toString()) as {
        messages?: NormalizedMessage[];
        [key: string]: unknown;
      };

      if (parsed.messages && parsed.messages.length > 0 && shouldCompress(parsed.messages)) {
        // Apply compression with conservative settings
        const compressionResult = await compressContext(parsed.messages, {
          enabled: true,
          preserveRaw: false, // Don't need originals in proxy
          layers: {
            deduplication: true, // Safe: removes duplicate messages
            whitespace: true, // Safe: normalizes whitespace
            dictionary: false, // Disabled: requires model to understand codebook
            paths: false, // Disabled: requires model to understand path codes
            jsonCompact: true, // Safe: just removes JSON whitespace
            observation: false, // Disabled: may lose important context
            dynamicCodebook: false, // Disabled: requires model to understand codes
          },
          dictionary: {
            maxEntries: 50,
            minPhraseLength: 15,
            includeCodebookHeader: false,
          },
        });

        const compressedSizeKB = Math.ceil(compressionResult.compressedChars / 1024);
        const savings = (((requestSizeKB - compressedSizeKB) / requestSizeKB) * 100).toFixed(1);

        console.log(
          `[ClawRouter] Compressed ${requestSizeKB}KB → ${compressedSizeKB}KB (${savings}% reduction)`,
        );

        // Update request body with compressed messages
        parsed.messages = compressionResult.messages;
        body = Buffer.from(JSON.stringify(parsed));
      }
    } catch (err) {
      // Compression failed - continue with original request
      console.warn(
        `[ClawRouter] Compression failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // --- Response cache check (long-term, 10min TTL) ---
  // Prefix with the client's original stream intent. The body was already
  // rewritten to stream:false for the upstream call (same reason as dedupKey
  // below), so SSE and JSON responses would otherwise share a cache slot and
  // the first caller's response shape would be served to the second.
  const cacheKey = `${isStreaming ? "sse" : "json"}:${ResponseCache.generateKey(body)}`;
  const reqHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") reqHeaders[key] = value;
  }
  if (responseCache.shouldCache(body, reqHeaders)) {
    const cachedResponse = responseCache.get(cacheKey);
    if (cachedResponse) {
      console.log(`[ClawRouter] Cache HIT for ${cachedResponse.model} (saved API call)`);
      res.writeHead(cachedResponse.status, cachedResponse.headers);
      res.end(cachedResponse.body);
      return;
    }
  }

  // --- Dedup check (short-term, 30s TTL for retries) ---
  // Prefix with the client's original stream intent. The upstream `stream` flag
  // is rewritten to false before this point (BlockRun API is non-streaming), so
  // a streaming and non-streaming request with otherwise-identical bodies would
  // otherwise collide and serve each other's responses (JSON body to an SSE
  // caller, or vice versa).
  const dedupKey = `${isStreaming ? "sse" : "json"}:${RequestDeduplicator.hash(body)}`;

  // Check dedup cache (catches retries within 30s)
  const cached = deduplicator.getCached(dedupKey);
  if (cached) {
    res.writeHead(cached.status, cached.headers);
    res.end(cached.body);
    return;
  }

  // Check in-flight — wait for the original request to complete
  const inflight = deduplicator.getInflight(dedupKey);
  if (inflight) {
    if (isStreaming) {
      // The original may take minutes (reasoning models get 180s/attempt).
      // Waiting silently recreates the client-timeout/retry storm the
      // heartbeat mechanism exists to prevent — send SSE headers and
      // heartbeats while we wait, then replay the finished transcript.
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      safeWrite(res, ": heartbeat\n\n");
      const waiterHeartbeat = setInterval(() => {
        if (canWrite(res)) {
          safeWrite(res, ": heartbeat\n\n");
        } else {
          clearInterval(waiterHeartbeat);
        }
      }, HEARTBEAT_INTERVAL_MS);
      try {
        const result = await inflight;
        if (canWrite(res)) {
          if (result.status === 200) {
            // SSE-keyed entries store the original's full SSE transcript
            safeWrite(res, result.body);
          } else {
            // Sentinel/error result (JSON body) — wrap as an SSE error event
            safeWrite(res, `data: ${result.body.toString()}\n\n`);
            safeWrite(res, "data: [DONE]\n\n");
          }
        }
        res.end();
      } finally {
        clearInterval(waiterHeartbeat);
      }
      return;
    }
    const result = await inflight;
    res.writeHead(result.status, result.headers);
    res.end(result.body);
    return;
  }

  // Register this request as in-flight
  deduplicator.markInflight(dedupKey);

  // --- Pre-request balance check ---
  // Estimate cost and check if wallet has sufficient balance
  // Skip if skipBalanceCheck is set (for testing) or if using free model
  let estimatedCostMicros: bigint | undefined;
  // Use `let` so the balance-fallback path can update this when modelId is switched to a free model.
  let isFreeModel = FREE_MODELS.has(modelId ?? "");

  if (modelId && !options.skipBalanceCheck && !isFreeModel) {
    const estimated = estimateAmount(modelId, body.length, maxTokens);
    const preflightEstimated = estimateBalancePreflightAmount(modelId, body.length, maxTokens);
    if (estimated) {
      estimatedCostMicros = BigInt(estimated);
    }
    if (preflightEstimated) {
      const preflightEstimatedCostMicros = BigInt(preflightEstimated);

      // Apply extra buffer for balance check to prevent x402 failures after streaming starts.
      // This is aggressive to avoid triggering OpenClaw's 5-24 hour billing cooldown.
      const bufferedCostMicros =
        (preflightEstimatedCostMicros * BigInt(Math.ceil(BALANCE_CHECK_BUFFER * 100))) / 100n;

      // Check balance before proceeding (using buffered amount)
      // Wrap in try/catch: Solana RPC failures (timeouts, rate limits) should
      // not silently downgrade the request — pass through optimistically instead.
      // Time-bound the check: it runs before SSE headers are flushed, and a slow
      // RPC (Solana retries can stack to ~34s) would starve streaming clients of
      // their first byte until past OpenClaw's ~10-15s silence timeout. On
      // timeout we proceed optimistically; the in-flight RPC still resolves in
      // the background and warms the monitor's cache for the next request.
      let sufficiency: Awaited<ReturnType<typeof balanceMonitor.checkSufficient>> | null = null;
      let balanceCheckTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        sufficiency = await Promise.race([
          balanceMonitor.checkSufficient(bufferedCostMicros),
          new Promise<null>((resolve) => {
            balanceCheckTimer = setTimeout(() => {
              console.warn(
                `[ClawRouter] Balance check exceeded ${BALANCE_CHECK_TIMEOUT_MS}ms — proceeding optimistically`,
              );
              resolve(null);
            }, BALANCE_CHECK_TIMEOUT_MS);
          }),
        ]);
      } catch (balanceErr) {
        console.warn(
          `[ClawRouter] Balance check failed (${balanceErr instanceof Error ? balanceErr.message : String(balanceErr)}) — proceeding optimistically`,
        );
      } finally {
        clearTimeout(balanceCheckTimer);
      }

      if (sufficiency && (sufficiency.info.isEmpty || !sufficiency.sufficient)) {
        // Wallet is empty or insufficient — fallback to best available free model
        const freeFallback = pickFreeModel(loadExcludeList()) ?? FREE_MODEL;
        const originalModel = modelId;
        console.log(
          `[ClawRouter] Wallet ${sufficiency.info.isEmpty ? "empty" : "insufficient"} (${sufficiency.info.balanceUSD}), falling back to free model: ${freeFallback} (requested: ${originalModel})`,
        );
        modelId = freeFallback;
        isFreeModel = true; // keep in sync — budget logic gates on !isFreeModel
        estimatedCostMicros = undefined;
        // Update the body with new model (map free/ → nvidia/ for upstream)
        const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
        parsed.model = toUpstreamModelId(freeFallback);
        body = Buffer.from(JSON.stringify(parsed));

        // Build fund instruction — include wallet address so user knows where to send
        const walletAddr = sufficiency.info.walletAddress;
        const fundHint = walletAddr
          ? ` Send USDC to \`${walletAddr}\`.`
          : " Run `/wallet` to see your address.";

        // Set notice to prepend to response so user knows about the fallback
        balanceFallbackNotice = sufficiency.info.isEmpty
          ? `> **⚠️ Wallet empty** — using free model.${fundHint}\n\n`
          : `> **⚠️ Insufficient balance** (${sufficiency.info.balanceUSD}) — using free model instead of ${originalModel}.${fundHint}\n\n`;

        // Notify about the fallback
        options.onLowBalance?.({
          balanceUSD: sufficiency.info.balanceUSD,
          walletAddress: sufficiency.info.walletAddress,
        });
      } else if (sufficiency?.info.isLow) {
        // Balance is low but sufficient — warn and proceed
        options.onLowBalance?.({
          balanceUSD: sufficiency.info.balanceUSD,
          walletAddress: sufficiency.info.walletAddress,
        });
      }
    }
  }

  // --- Cost cap check: strict mode hard-stop ---
  // In 'strict' mode, reject if the projected session spend (accumulated + this request's
  // estimate) would exceed the cap. Checking projected cost (not just historical) prevents
  // a single large request from overshooting the cap before it's recorded.
  // In 'graceful' mode (default), the cap is enforced via model downgrade below.
  // Must happen before streaming headers are sent.
  if (
    options.maxCostPerRunUsd &&
    effectiveSessionId &&
    !isFreeModel &&
    (options.maxCostPerRunMode ?? "graceful") === "strict"
  ) {
    const runCostUsd = sessionStore.getSessionCostUsd(effectiveSessionId);
    // Include this request's estimated cost so even the first request is blocked
    // if it would push the session over the cap.
    const thisReqEstStr =
      estimatedCostMicros !== undefined
        ? estimatedCostMicros.toString()
        : modelId
          ? estimateAmount(modelId, body.length, maxTokens)
          : undefined;
    const thisReqEstUsd = thisReqEstStr ? Number(thisReqEstStr) / 1_000_000 : 0;
    const projectedCostUsd = runCostUsd + thisReqEstUsd;
    if (projectedCostUsd > options.maxCostPerRunUsd) {
      console.log(
        `[ClawRouter] Cost cap exceeded for session ${effectiveSessionId.slice(0, 8)}...: projected $${projectedCostUsd.toFixed(4)} (spent $${runCostUsd.toFixed(4)} + est $${thisReqEstUsd.toFixed(4)}) > $${options.maxCostPerRunUsd} limit`,
      );
      res.writeHead(429, {
        "Content-Type": "application/json",
        "X-ClawRouter-Cost-Cap-Exceeded": "1",
      });
      res.end(
        JSON.stringify({
          error: {
            message: `ClawRouter cost cap exceeded: projected spend $${projectedCostUsd.toFixed(4)} (spent $${runCostUsd.toFixed(4)} + est $${thisReqEstUsd.toFixed(4)}) would exceed limit $${options.maxCostPerRunUsd}`,
            type: "cost_cap_exceeded",
            code: "cost_cap_exceeded",
          },
        }),
      );
      deduplicator.removeInflight(dedupKey);
      return;
    }
  }

  // --- Budget pre-check: block when remaining budget can't cover the request ---
  // Must happen BEFORE streaming headers (429 can't be sent after SSE headers are flushed).
  // Three cases that require a hard block rather than graceful downgrade:
  //   (A) tool/COMPLEX/REASONING routing profile — free model can't substitute
  //   (B) explicit model request (no routing profile) — user chose a specific model,
  //       silently substituting with free model would be deceptive regardless of task type
  // Simple routing profile requests are handled later via graceful downgrade.
  if (
    options.maxCostPerRunUsd &&
    effectiveSessionId &&
    !isFreeModel &&
    (options.maxCostPerRunMode ?? "graceful") === "graceful"
  ) {
    const runCostUsd = sessionStore.getSessionCostUsd(effectiveSessionId);
    const remainingUsd = options.maxCostPerRunUsd - runCostUsd;

    const isComplexOrAgentic =
      hasTools || routingDecision?.tier === "COMPLEX" || routingDecision?.tier === "REASONING";

    if (isComplexOrAgentic) {
      // Case A: tool/complex/agentic routing profile — check global model table
      // Intentionally exclude free models: they cannot handle complex/agentic tasks.
      const canAffordAnyNonFreeModel = BLOCKRUN_MODELS.some((m) => {
        if (FREE_MODELS.has(m.id)) return false;
        const est = estimateAmount(m.id, body.length, maxTokens);
        return est !== undefined && Number(est) / 1_000_000 <= remainingUsd;
      });
      if (!canAffordAnyNonFreeModel) {
        console.log(
          `[ClawRouter] Budget insufficient for agentic/complex session ${effectiveSessionId.slice(0, 8)}...: $${Math.max(0, remainingUsd).toFixed(4)} remaining — blocking (silent downgrade would corrupt tool/complex responses)`,
        );
        res.writeHead(429, {
          "Content-Type": "application/json",
          "X-ClawRouter-Cost-Cap-Exceeded": "1",
          "X-ClawRouter-Budget-Mode": "blocked",
        });
        res.end(
          JSON.stringify({
            error: {
              message: `ClawRouter budget exhausted: $${Math.max(0, remainingUsd).toFixed(4)} remaining (limit: $${options.maxCostPerRunUsd}). Increase maxCostPerRun to continue.`,
              type: "cost_cap_exceeded",
              code: "budget_exhausted",
            },
          }),
        );
        deduplicator.removeInflight(dedupKey);
        return;
      }
    } else if (!routingDecision && modelId && !FREE_MODELS.has(modelId)) {
      // Case B: explicit model request (user chose a specific model, not a routing profile).
      // Silently substituting their choice with free model is deceptive — block instead.
      const est = estimateAmount(modelId, body.length, maxTokens);
      const canAfford = !est || Number(est) / 1_000_000 <= remainingUsd;
      if (!canAfford) {
        console.log(
          `[ClawRouter] Budget insufficient for explicit model ${modelId} in session ${effectiveSessionId.slice(0, 8)}...: $${Math.max(0, remainingUsd).toFixed(4)} remaining — blocking (user explicitly chose ${modelId})`,
        );
        res.writeHead(429, {
          "Content-Type": "application/json",
          "X-ClawRouter-Cost-Cap-Exceeded": "1",
          "X-ClawRouter-Budget-Mode": "blocked",
        });
        res.end(
          JSON.stringify({
            error: {
              message: `ClawRouter budget exhausted: $${Math.max(0, remainingUsd).toFixed(4)} remaining (limit: $${options.maxCostPerRunUsd}). Increase maxCostPerRun to continue using ${modelId}.`,
              type: "cost_cap_exceeded",
              code: "budget_exhausted",
            },
          }),
        );
        deduplicator.removeInflight(dedupKey);
        return;
      }
    }
  }

  // --- Streaming: early header flush + heartbeat ---
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  let headersSentEarly = false;

  if (isStreaming) {
    // Send 200 + SSE headers immediately, before x402 flow
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-context-used-kb": String(originalContextSizeKB),
      "x-context-limit-kb": String(CONTEXT_LIMIT_KB),
    });
    headersSentEarly = true;

    // First heartbeat immediately
    safeWrite(res, ": heartbeat\n\n");

    // Continue heartbeats every 2s while waiting for upstream
    heartbeatInterval = setInterval(() => {
      if (canWrite(res)) {
        safeWrite(res, ": heartbeat\n\n");
      } else {
        // Socket closed, stop heartbeat
        clearInterval(heartbeatInterval);
        heartbeatInterval = undefined;
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // Forward headers, stripping hop-by-hop and provider-specific headers.
  // OpenClaw v2026.4.2 centralizes provider header handling (native vs proxy),
  // but we strip SDK/provider headers defensively for older clients too.
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      key === "host" ||
      key === "connection" ||
      key === "transfer-encoding" ||
      key === "content-length"
    )
      continue;
    // SDK attribution headers (OpenAI x-stainless-*, Anthropic anthropic-*)
    // These are client-side telemetry/protocol headers — not meaningful to BlockRun.
    if (key.startsWith("x-stainless-") || key.startsWith("anthropic-")) continue;
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  headers["user-agent"] = USER_AGENT;

  // --- Client disconnect cleanup ---
  let completed = false;
  res.on("close", () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
    }
    // Remove from in-flight if client disconnected before completion
    if (!completed) {
      deduplicator.removeInflight(dedupKey);
    }
  });

  // --- Request timeout ---
  // Global controller: hard deadline for the entire request (all model attempts combined).
  // Each model attempt gets its own per-model controller (PER_MODEL_TIMEOUT_MS).
  // If a model times out individually, we fall back to the next model instead of failing.
  // Only the global timeout causes an immediate error.
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const globalController = new AbortController();
  const timeoutId = setTimeout(() => globalController.abort(), timeoutMs);

  // Abort in-flight upstream requests when the client disconnects.
  // OpenClaw 2026.4.7+ aborts gateway requests on client disconnect;
  // without this, ClawRouter would leave orphan upstream fetches running.
  // Must hang off `res` "close", not `req`: on Node (verified on v24.15.0) an
  // IncomingMessage emits "close" when the request-body readable finishes, not
  // when the client hangs up. The body is fully drained above, so a `req`
  // listener would fire at body-end (or never, having missed the event) rather
  // than on disconnect. The media handlers all use `res.on("close")` for this.
  // True once the client is gone: the response socket is destroyed without us
  // having finished it. Used to tell a client disconnect apart from the global
  // timeout — both surface as `globalController.signal.aborted`.
  const clientDisconnected = () => res.destroyed && !res.writableEnded;
  const abortError = () =>
    clientDisconnected()
      ? new ClientDisconnectedError()
      : new Error(`Request timed out after ${timeoutMs}ms`);
  const onClientClose = () => {
    if (!res.writableEnded && !globalController.signal.aborted) {
      console.log(`[ClawRouter] Client disconnected — aborting upstream request`);
      globalController.abort();
    }
  };
  res.on("close", onClientClose);
  // The body was drained ~1,500 lines above and several awaits ran since
  // (context compression, the balance check). If the client hung up in that
  // window, `res` "close" has already fired and the listener above will never
  // run — check the socket state now so that disconnect still aborts.
  if (res.destroyed) onClientClose();

  try {
    // --- Build fallback chain ---
    // If we have a routing decision, get the full fallback chain for the tier
    // Otherwise, just use the current model (no fallback for explicit model requests)
    let modelsToTry: string[];
    const excludeList = options.excludeModels ?? loadExcludeList();

    // Short-circuit: if balance check already determined wallet is empty/insufficient,
    // skip the entire routing chain (all paid models would 429 anyway) and go straight
    // to the free model. This avoids 4-5 wasted x402 payment signature attempts.
    // Only applies when balance check actually ran (not when skipBalanceCheck is set).
    if (isFreeModel && routingDecision && !options.skipBalanceCheck) {
      const freeFallback = pickFreeModel(excludeList) ?? FREE_MODEL;
      modelsToTry = [freeFallback];
      console.log(
        `[ClawRouter] Wallet empty — skipping routing chain, using free model: ${freeFallback}`,
      );
    } else if (routingDecision) {
      const prependStickyExplicitModel = (chain: string[]): string[] => {
        if (!stickyExplicitModel) return chain;
        return [stickyExplicitModel, ...chain.filter((model) => model !== stickyExplicitModel)];
      };
      // Estimate total context: input tokens (~4 chars per token) + max output tokens
      const estimatedInputTokens = Math.ceil(body.length / 4);
      const estimatedTotalTokens = estimatedInputTokens + maxTokens;

      // Use tier configs from the routing decision (set by RouterStrategy)
      const tierConfigs = routingDecision.tierConfigs ?? routerOpts.config.tiers;

      // Portfolio decisions carry a capability-ranked candidate order. Legacy
      // rules decisions retain the established tier chain. Always put the
      // actual serving decision first so a session pin remains sticky.
      const rankedCandidates =
        routingDecision.candidates ?? getFallbackChain(routingDecision.tier, tierConfigs);
      const selectedModel = routingDecision.model;
      const fullChain = prependStickyExplicitModel([
        selectedModel,
        ...rankedCandidates.filter((model) => model !== selectedModel),
      ]);
      const contextFiltered = filterCandidatesByCapacity(
        fullChain,
        estimatedInputTokens,
        maxTokens,
        (modelId) => {
          const model = BLOCKRUN_MODEL_BY_ID.get(modelId);
          return model
            ? { contextWindow: model.contextWindow, maxOutput: model.maxOutput }
            : undefined;
        },
      );

      if (contextFiltered.length === 0) {
        const errPayload = JSON.stringify({
          error: {
            message: `No routed model can satisfy the requested context and output capacity (~${estimatedTotalTokens} tokens). Reduce the input or max_tokens and retry.`,
            type: "invalid_request_error",
            code: "context_capacity_exceeded",
          },
        });
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = undefined;
        }
        if (headersSentEarly) {
          safeWrite(res, `data: ${errPayload}\n\ndata: [DONE]\n\n`);
          res.end();
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(errPayload);
        }
        completed = true;
        deduplicator.removeInflight(dedupKey);
        clearTimeout(timeoutId);
        res.removeListener("close", onClientClose);
        return;
      }

      // Log if models were filtered out due to context limits
      const contextExcluded = fullChain.filter((m) => !contextFiltered.includes(m));
      if (contextExcluded.length > 0) {
        console.log(
          `[ClawRouter] Context filter (~${estimatedTotalTokens} tokens): excluded ${contextExcluded.join(", ")}`,
        );
      }

      // Filter out user-excluded models
      const excludeFiltered = filterByExcludeList(contextFiltered, excludeList);
      const excludeExcluded = contextFiltered.filter((m) => !excludeFiltered.includes(m));
      if (excludeExcluded.length > 0) {
        console.log(
          `[ClawRouter] Exclude filter: excluded ${excludeExcluded.join(", ")} (user preference)`,
        );
      }

      // Filter to models that support tool calling when request has tools.
      // Prevents models like grok-code-fast-1 from outputting tool invocations
      // as plain text JSON (the "talking to itself" bug).
      let toolFiltered = filterByToolCalling(excludeFiltered, hasTools, supportsToolCalling);
      const toolExcluded = excludeFiltered.filter((m) => !toolFiltered.includes(m));
      if (toolExcluded.length > 0) {
        console.log(
          `[ClawRouter] Tool-calling filter: excluded ${toolExcluded.join(", ")} (no structured function call support)`,
        );
      }

      // Filter out models that declare toolCalling but fail tool compliance in practice.
      // gemini-2.5-flash-lite refuses certain tool schemas (e.g. brave search) while
      // cheaper models like nvidia/gpt-oss-120b handle them fine.
      const TOOL_NONCOMPLIANT_MODELS = [
        "google/gemini-2.5-flash-lite",
        "google/gemini-3-pro-preview",
        "google/gemini-3.1-pro",
      ];
      if (hasTools && toolFiltered.length > 1) {
        const compliant = toolFiltered.filter((m) => !TOOL_NONCOMPLIANT_MODELS.includes(m));
        if (compliant.length > 0 && compliant.length < toolFiltered.length) {
          const dropped = toolFiltered.filter((m) => TOOL_NONCOMPLIANT_MODELS.includes(m));
          console.log(
            `[ClawRouter] Tool-compliance filter: excluded ${dropped.join(", ")} (unreliable tool schema handling)`,
          );
          toolFiltered = compliant;
        }
      }

      // Filter to models that support vision when request has image_url content
      const visionFiltered = filterByVision(toolFiltered, hasVision, supportsVision);
      const visionExcluded = toolFiltered.filter((m) => !visionFiltered.includes(m));
      if (visionExcluded.length > 0) {
        console.log(
          `[ClawRouter] Vision filter: excluded ${visionExcluded.join(", ")} (no vision support)`,
        );
      }

      // Limit to MAX_FALLBACK_ATTEMPTS to prevent infinite loops
      modelsToTry = visionFiltered.slice(0, MAX_FALLBACK_ATTEMPTS);

      // Deprioritize rate-limited models (put them at the end)
      modelsToTry = prioritizeNonRateLimited(modelsToTry);
    } else {
      // For explicit model requests, use the requested model
      modelsToTry = modelId ? [modelId] : [];
    }

    // A free model this chain's gateway does not carry is a hard 400, not a
    // fallback: the never-retire redirect rule only covers ids a gateway once
    // shipped, and the free tiers diverged on 2026-08-30. `/model free` resolves
    // through the alias map to a concrete id, so it lands in the explicit branch
    // above and never touches pickFreeModel's filter — substitute here instead,
    // where every path has converged on a chain.
    //
    // Only ever swaps one free model for another free model, so nothing becomes
    // payable that was not, and a user who pinned a PAID model is untouched.
    if (modelsToTry.length > 0) {
      const unservedFree = modelsToTry.filter((m) => FREE_MODELS.has(m) && !isServedByGateway(m));
      if (unservedFree.length > 0) {
        const servedFree = [...FREE_MODELS].filter(
          (m) => isServedByGateway(m) && !excludeList?.has(m),
        );
        const replacement = servedFree[0];
        if (replacement) {
          modelsToTry = modelsToTry.map((m) => (unservedFree.includes(m) ? replacement : m));
          modelsToTry = modelsToTry.filter((m, i) => modelsToTry.indexOf(m) === i);
          console.log(
            `[ClawRouter] ${unservedFree.join(", ")} not served on this chain — using ${replacement}`,
          );
        }
      }
    }

    // Ensure routed requests have a free-model last resort for non-tool chats.
    // Explicit model requests intentionally skip this: silently substituting a
    // user-chosen model with `free/*` is deceptive.
    if (!hasTools && routingDecision) {
      const freeFallback = pickFreeModel(excludeList);
      if (freeFallback && !modelsToTry.includes(freeFallback)) {
        modelsToTry.push(freeFallback);
      }
    }

    // --- Budget-aware routing (graceful mode) ---
    // Filter modelsToTry to only models that fit within the remaining session budget.
    // Simple tasks (no tools, non-complex tier): downgrade with visible warning.
    // Complex/agentic tasks with no affordable model: already blocked above (before streaming headers).
    if (
      options.maxCostPerRunUsd &&
      effectiveSessionId &&
      !isFreeModel &&
      (options.maxCostPerRunMode ?? "graceful") === "graceful"
    ) {
      const runCostUsd = sessionStore.getSessionCostUsd(effectiveSessionId);
      const remainingUsd = options.maxCostPerRunUsd - runCostUsd;

      const beforeFilter = [...modelsToTry];
      modelsToTry = modelsToTry.filter((m) => {
        if (FREE_MODELS.has(m)) return true; // free models always fit (no cost)
        const est = estimateAmount(m, body.length, maxTokens);
        if (!est) return true; // no pricing data → keep (permissive)
        return Number(est) / 1_000_000 <= remainingUsd;
      });

      const excluded = beforeFilter.filter((m) => !modelsToTry.includes(m));

      // Second-pass block: the pre-check caught obvious cases early (before streaming headers).
      // Here we recheck against the actual filtered modelsToTry chain. If the ONLY remaining
      // models are free, we must block rather than silently degrade for:
      //   (A) complex/agentic routing profile tasks (tools / COMPLEX / REASONING tier)
      //   (B) explicit model requests (user chose a specific model; free substitution is deceptive)
      // The pre-check already handles case (B) for non-streaming; this is a safety net for
      // streaming requests where SSE headers may have already been sent.
      const isComplexOrAgenticFilter =
        hasTools ||
        routingDecision?.tier === "COMPLEX" ||
        routingDecision?.tier === "REASONING" ||
        routingDecision === undefined; // explicit model: no routing profile → user chose the model
      const filteredToFreeOnly =
        modelsToTry.length > 0 && modelsToTry.every((m) => FREE_MODELS.has(m));

      if (isComplexOrAgenticFilter && filteredToFreeOnly) {
        const budgetSummary = `$${Math.max(0, remainingUsd).toFixed(4)} remaining (limit: $${options.maxCostPerRunUsd})`;
        console.log(
          `[ClawRouter] Budget filter left only free model for complex/agentic session — blocking (${budgetSummary})`,
        );
        const errPayload = JSON.stringify({
          error: {
            message: `ClawRouter budget exhausted: remaining budget (${budgetSummary}) cannot support a complex/tool request. Increase maxCostPerRun to continue.`,
            type: "cost_cap_exceeded",
            code: "budget_exhausted",
          },
        });
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (headersSentEarly) {
          // Streaming: inject error SSE event + [DONE] and close
          safeWrite(res, `data: ${errPayload}\n\ndata: [DONE]\n\n`);
          res.end();
        } else {
          res.writeHead(429, {
            "Content-Type": "application/json",
            "X-ClawRouter-Cost-Cap-Exceeded": "1",
            "X-ClawRouter-Budget-Mode": "blocked",
          });
          res.end(errPayload);
        }
        deduplicator.removeInflight(dedupKey);
        // This return exits before the shared cleanup below — release the
        // global timeout + close listener so they don't outlive the request.
        clearTimeout(timeoutId);
        res.removeListener("close", onClientClose);
        return;
      }

      if (excluded.length > 0) {
        const budgetSummary =
          remainingUsd > 0
            ? `$${remainingUsd.toFixed(4)} remaining`
            : `budget exhausted ($${runCostUsd.toFixed(4)}/$${options.maxCostPerRunUsd})`;
        console.log(
          `[ClawRouter] Budget downgrade (${budgetSummary}): excluded ${excluded.join(", ")}`,
        );

        // A: Set visible warning notice — prepended to response so user sees the downgrade
        const fromModel = excluded[0];
        const usingFree = modelsToTry.length === 1 && FREE_MODELS.has(modelsToTry[0]);
        if (usingFree) {
          budgetDowngradeNotice = `> **⚠️ Budget cap reached** ($${runCostUsd.toFixed(4)}/$${options.maxCostPerRunUsd}) — downgraded to free model. Quality may be reduced. Increase \`maxCostPerRun\` to continue with ${fromModel}.\n\n`;
        } else {
          const toModel = modelsToTry[0] ?? FREE_MODEL; // last resort
          budgetDowngradeNotice = `> **⚠️ Budget low** ($${remainingUsd > 0 ? remainingUsd.toFixed(4) : "0.0000"} remaining) — using ${toModel} instead of ${fromModel}.\n\n`;
        }
        // B: Header flag for orchestration layers (e.g. OpenClaw can pause/warn the user)
        budgetDowngradeHeaderMode = "downgraded";
      }
    }

    // --- Fallback loop: try each model until success ---
    let upstream: Response | undefined;
    let lastError: { body: string; status: number; requestId?: string } | undefined;
    let actualModelUsed = modelId;
    const failedAttempts: Array<{ model: string; reason: string; status: number }> = [];

    for (let i = 0; i < modelsToTry.length; i++) {
      const tryModel = modelsToTry[i];
      const isLastAttempt = i === modelsToTry.length - 1;

      // Abort immediately if global deadline has already fired (or the client left)
      if (globalController.signal.aborted) {
        throw abortError();
      }

      console.log(`[ClawRouter] Trying model ${i + 1}/${modelsToTry.length}: ${tryModel}`);

      // Publish what THIS attempt should cost, for the API-key rail's spend
      // windows (#329). Per attempt, not per request: a fallback chain can end
      // on a different model at a different price, and the wallet rail likewise
      // re-checks policy against each attempt's own 402 quote. Free models
      // publish 0 rather than being skipped, so a previous attempt's estimate
      // cannot leak into a call that costs nothing.
      const attemptEst = FREE_MODELS.has(tryModel)
        ? undefined
        : estimateAmount(tryModel, body.length, maxTokens);
      publishDispatchCost(attemptEst ? Number(attemptEst) / 1_000_000 : 0);

      // Per-model abort controller — each attempt gets its own window.
      // Reasoning models (o-series, GPT-5 reasoning, Claude opus, V4 Pro, etc.)
      // get 3min for cold-start first-token; everything else 60s. When it fires,
      // the fallback loop moves to the next model rather than failing.
      const perAttemptTimeoutMs = timeoutForModel(tryModel);
      const modelController = new AbortController();
      const modelTimeoutId = setTimeout(() => modelController.abort(), perAttemptTimeoutMs);
      const combinedSignal = AbortSignal.any([globalController.signal, modelController.signal]);

      const result = await tryModelRequest(
        upstreamUrl,
        req.method ?? "POST",
        headers,
        body,
        tryModel,
        maxTokens,
        payFetch,
        balanceMonitor,
        combinedSignal,
      );
      clearTimeout(modelTimeoutId);

      // If the global deadline fired during this attempt (or the client left), bail out entirely
      if (globalController.signal.aborted) {
        throw abortError();
      }

      // If the per-model timeout fired (but not global), treat as fallback-worthy error
      if (!result.success && modelController.signal.aborted && !isLastAttempt) {
        console.log(
          `[ClawRouter] Model ${tryModel} timed out after ${perAttemptTimeoutMs}ms, trying fallback`,
        );
        recordProviderError(tryModel, "server_error");
        continue;
      }

      if (result.success && result.response) {
        // Buffer the body so we can peek for degenerate output before committing
        // to this model. Non-streaming JSON responses are small; this is cheap.
        const bodyChunks = await readBodyWithTimeout(result.response.body);
        const bodyBuf = Buffer.concat(bodyChunks);

        if (isDegenerateCompletion(bodyBuf) && !isLastAttempt) {
          console.warn(
            `[ClawRouter] ⚠️  Degenerate output from ${tryModel} (finish_reason=length + repetition loop) — retrying with next fallback`,
          );
          recordProviderError(tryModel, "server_error");
          failedAttempts.push({
            model: tryModel,
            reason: "degenerate_output",
            status: 200,
          });
          continue;
        }

        // Re-wrap the buffered body so downstream code can read upstream.body normally
        upstream = new Response(new Uint8Array(bodyBuf), {
          status: result.response.status,
          statusText: result.response.statusText,
          headers: result.response.headers,
        });
        actualModelUsed = tryModel;
        console.log(`[ClawRouter] Success with model: ${tryModel}`);
        // Accumulate estimated cost to session for maxCostPerRun tracking
        if (options.maxCostPerRunUsd && effectiveSessionId && !FREE_MODELS.has(tryModel)) {
          const costEst = estimateAmount(tryModel, body.length, maxTokens);
          if (costEst) {
            sessionStore.addSessionCost(effectiveSessionId, BigInt(costEst));
          }
        }
        break;
      }

      // Request failed
      lastError = {
        body: result.errorBody || "Unknown error",
        status: result.errorStatus || 500,
        requestId: result.upstreamRequestId,
      };
      failedAttempts.push({
        model: tryModel,
        reason: result.errorCategory || `HTTP ${result.errorStatus || 500}`,
        status: result.errorStatus || 500,
      });

      // Payment error (insufficient funds, simulation failure) — skip remaining
      // paid models, jump straight to free model. No point trying other paid
      // models with the same wallet state.
      // Must be checked BEFORE isProviderError gate: payment settlement failures
      // may return non-standard HTTP codes that categorizeError doesn't recognize,
      // causing isProviderError=false and breaking out of the fallback loop.
      const isPaymentErr =
        /payment.*verification.*failed|payment.*settlement.*failed|insufficient.*funds|transaction_simulation_failed/i.test(
          result.errorBody || "",
        );
      if (isPaymentErr && !FREE_MODELS.has(tryModel) && !isLastAttempt) {
        failedAttempts.push({
          ...failedAttempts[failedAttempts.length - 1],
          reason: "payment_error",
        });
        // Find a free model already in the chain
        const freeInChain = modelsToTry.findIndex((m, idx) => idx > i && FREE_MODELS.has(m));
        if (freeInChain > i + 1) {
          console.log(
            `[ClawRouter] Payment error — skipping to free model: ${modelsToTry[freeInChain]}`,
          );
          i = freeInChain - 1; // loop will increment to freeInChain
          continue;
        }
        // No free model in chain — pick best available and append
        if (freeInChain === -1) {
          const freeFallback = pickFreeModel(excludeList);
          if (freeFallback) {
            modelsToTry.push(freeFallback);
            console.log(`[ClawRouter] Payment error — appending free model: ${freeFallback}`);
            continue;
          }
        }
      }

      // Explicit pins intentionally avoid automatic free-model fallback, so a
      // single transient upstream 5xx (NVIDIA worker flake, blockrun 500)
      // would otherwise fail the whole request. Retry once with a short
      // backoff. Non-retryable errors (auth/payment/config) fall through.
      const isExplicitPin = !routingDecision;
      const isRetryableServerError =
        result.errorCategory === "server_error" || result.errorCategory === "overloaded";
      if (
        isExplicitPin &&
        isLastAttempt &&
        isRetryableServerError &&
        !globalController.signal.aborted
      ) {
        console.log(
          `[ClawRouter] Explicit pin ${tryModel} got ${result.errorCategory} (HTTP ${result.errorStatus ?? "?"}), retrying once in 500ms`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        if (!globalController.signal.aborted) {
          // The first attempt consumed the published estimate; this retry is a
          // second billable dispatch and needs its own.
          publishDispatchCost(attemptEst ? Number(attemptEst) / 1_000_000 : 0);
          const retryController = new AbortController();
          const retryTimeoutId = setTimeout(
            () => retryController.abort(),
            timeoutForModel(tryModel),
          );
          const retrySignal = AbortSignal.any([globalController.signal, retryController.signal]);
          const retryResult = await tryModelRequest(
            upstreamUrl,
            req.method ?? "POST",
            headers,
            body,
            tryModel,
            maxTokens,
            payFetch,
            balanceMonitor,
            retrySignal,
          );
          clearTimeout(retryTimeoutId);
          if (retryResult.success && retryResult.response) {
            upstream = retryResult.response;
            actualModelUsed = tryModel;
            console.log(`[ClawRouter] Explicit-pin retry succeeded for: ${tryModel}`);
            if (options.maxCostPerRunUsd && effectiveSessionId && !FREE_MODELS.has(tryModel)) {
              const costEst = estimateAmount(tryModel, body.length, maxTokens);
              if (costEst) {
                sessionStore.addSessionCost(effectiveSessionId, BigInt(costEst));
              }
            }
            break;
          }
          // Retry also failed — update lastError with the latest failure and
          // fall through to the standard break path.
          lastError = {
            body: retryResult.errorBody || lastError?.body || "Unknown error",
            status: retryResult.errorStatus || lastError?.status || 500,
            requestId: retryResult.upstreamRequestId ?? lastError?.requestId,
          };
          failedAttempts.push({
            model: tryModel,
            reason: `${retryResult.errorCategory || `HTTP ${retryResult.errorStatus || 500}`} (retry)`,
            status: retryResult.errorStatus || 500,
          });
        }
      }

      // If it's a provider error and not the last attempt, try next model
      if (result.isProviderError && !isLastAttempt) {
        const isExplicitModelError = !routingDecision;
        const isUnknownExplicitModel =
          isExplicitModelError && /unknown.*model|invalid.*model/i.test(result.errorBody || "");
        if (isUnknownExplicitModel) {
          console.log(
            `[ClawRouter] Explicit model error from ${tryModel}, not falling back: ${result.errorBody?.slice(0, 100)}`,
          );
          break;
        }

        // Record error and apply category-specific handling
        const errorCat = result.errorCategory;
        if (errorCat) {
          recordProviderError(tryModel, errorCat);
        }

        if (errorCat === "rate_limited") {
          // --- Stepped backoff retry (429) ---
          // Token-bucket rate limits often recover within milliseconds.
          // Retry once after 200ms before treating this as a model-level failure.
          if (!isLastAttempt && !globalController.signal.aborted) {
            console.log(
              `[ClawRouter] Rate-limited on ${tryModel}, retrying in 200ms before failover`,
            );
            await new Promise<void>((resolve) => setTimeout(resolve, 200));
            if (!globalController.signal.aborted) {
              // Second billable dispatch — republish, the first one consumed it.
              publishDispatchCost(attemptEst ? Number(attemptEst) / 1_000_000 : 0);
              const retryController = new AbortController();
              const retryTimeoutId = setTimeout(
                () => retryController.abort(),
                timeoutForModel(tryModel),
              );
              const retrySignal = AbortSignal.any([
                globalController.signal,
                retryController.signal,
              ]);
              const retryResult = await tryModelRequest(
                upstreamUrl,
                req.method ?? "POST",
                headers,
                body,
                tryModel,
                maxTokens,
                payFetch,
                balanceMonitor,
                retrySignal,
              );
              clearTimeout(retryTimeoutId);
              if (retryResult.success && retryResult.response) {
                upstream = retryResult.response;
                actualModelUsed = tryModel;
                console.log(`[ClawRouter] Rate-limit retry succeeded for: ${tryModel}`);
                if (options.maxCostPerRunUsd && effectiveSessionId && !FREE_MODELS.has(tryModel)) {
                  const costEst = estimateAmount(tryModel, body.length, maxTokens);
                  if (costEst) {
                    sessionStore.addSessionCost(effectiveSessionId, BigInt(costEst));
                  }
                }
                break;
              }
              // Retry also failed — fall through to markRateLimited
            }
          }
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

        console.log(
          `[ClawRouter] Provider error from ${tryModel}, trying fallback: ${result.errorBody?.slice(0, 100)}`,
        );
        continue;
      }

      // Not a provider error or last attempt — stop trying
      if (!result.isProviderError) {
        console.log(
          `[ClawRouter] Non-provider error from ${tryModel}, not retrying: ${result.errorBody?.slice(0, 100)}`,
        );
      }
      break;
    }

    // Clear timeout and client-close listener — request attempts completed
    clearTimeout(timeoutId);
    res.removeListener("close", onClientClose);

    // Clear heartbeat — real data is about to flow
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
    }

    // --- Emit routing debug info (opt-in via x-clawrouter-debug: true header) ---
    // For streaming: SSE comment (invisible to most clients, visible in raw stream)
    // For non-streaming: response headers added later
    if (debugMode && headersSentEarly && routingDecision) {
      const debugComment = `: x-clawrouter-debug profile=${routingProfile ?? "auto"} tier=${routingDecision.tier} model=${actualModelUsed} agentic=${routingDecision.agenticScore?.toFixed(2) ?? "n/a"} confidence=${routingDecision.confidence.toFixed(2)} reasoning=${routingDecision.reasoning}\n\n`;
      safeWrite(res, debugComment);
    }

    // Update routing decision with actual model used (for logging)
    // IMPORTANT: Recalculate cost for the actual model, not the original primary
    if (routingDecision && actualModelUsed !== routingDecision.model) {
      const estimatedInputTokens = Math.ceil(body.length / 4);
      const newCosts = calculateModelCost(
        actualModelUsed,
        routerOpts.modelPricing,
        estimatedInputTokens,
        maxTokens,
        routingProfile ?? undefined,
      );
      routingDecision = {
        ...routingDecision,
        model: actualModelUsed,
        reasoning: `${routingDecision.reasoning} | fallback to ${actualModelUsed}`,
        costEstimate: newCosts.costEstimate,
        baselineCost: newCosts.baselineCost,
        savings: newCosts.savings,
      };
      options.onRouted?.(routingDecision);

      // Update session pin to the actual model used — ensures the next request in
      // this conversation starts from the fallback model rather than retrying the
      // primary and falling back again (prevents the "model keeps jumping" issue).
      if (effectiveSessionId) {
        const pinnedSession = sessionStore.getSession(effectiveSessionId);
        if (pinnedSession?.userExplicit) {
          console.log(
            `[ClawRouter] Session ${effectiveSessionId.slice(0, 8)}... fallback used ${actualModelUsed}, preserving user-explicit pin: ${pinnedSession.model}`,
          );
        } else {
          sessionStore.setSession(effectiveSessionId, actualModelUsed, routingDecision.tier);
          console.log(
            `[ClawRouter] Session ${effectiveSessionId.slice(0, 8)}... updated pin to fallback: ${actualModelUsed}`,
          );
        }
      }
    }

    // Record the answering attempt's gateway id before `upstream` goes out of
    // scope — this is the join key the usage journal needs.
    upstreamRequestId = blockrunRequestId(upstream);
    noteRemainingCredit(upstream);

    // --- Handle case where all models failed ---
    if (!upstream) {
      // Build structured error summary listing all attempted models
      const attemptSummary =
        failedAttempts.length > 0
          ? failedAttempts.map((a) => `${a.model} (${a.reason})`).join(", ")
          : "unknown";
      const structuredMessage =
        failedAttempts.length > 0
          ? `All ${failedAttempts.length} models failed. Tried: ${attemptSummary}`
          : "All models in fallback chain failed";
      // Name the gateway's own id for the failed attempt. A paid 5xx is
      // otherwise undiagnosable from both ends at once: the caller sees only
      // "All models failed" and has nothing to give support, and the gateway
      // cannot find the request without an id. Logged AND returned, because the
      // person who hits this is usually reading an agent transcript, not our
      // logs (ClawRouter-Hermes#38).
      console.log(
        `[ClawRouter] ${structuredMessage}${lastError?.requestId ? ` | gateway request id: ${lastError.requestId}` : ""}`,
      );
      const rawErrBody = lastError?.body || structuredMessage;
      const errStatus = lastError?.status || 502;

      // Transform payment errors into user-friendly messages
      const transformedErr = transformPaymentError(rawErrBody);

      // Mark as error for usage logging (logs this failed attempt with cost)
      requestHadError = true;

      if (headersSentEarly) {
        // Streaming: send error as SSE event in OpenAI error format.
        // The OpenAI SDK (used by continue.dev and others) expects {"error": {...}}.
        // If the upstream error is already in that shape, use it; otherwise wrap it.
        // Sending raw upstream JSON (e.g. {"code":400,"message":"..."}) causes the SDK
        // to throw a generic "Unexpected error" instead of a meaningful message.
        let errPayload: string;
        try {
          const parsed = JSON.parse(transformedErr);
          if (parsed && typeof parsed === "object" && "error" in parsed) {
            // Already has the correct {"error": {...}} wrapper — use as-is
            errPayload = JSON.stringify(parsed);
          } else {
            // Raw upstream JSON without error wrapper — wrap it
            errPayload = JSON.stringify({
              error: { message: rawErrBody, type: "provider_error", status: errStatus },
            });
          }
        } catch {
          errPayload = JSON.stringify({
            error: { message: rawErrBody, type: "provider_error", status: errStatus },
          });
        }
        const errEvent = `data: ${errPayload}\n\n`;
        safeWrite(res, errEvent);
        safeWrite(res, "data: [DONE]\n\n");
        res.end();

        const errBuf = Buffer.from(errEvent + "data: [DONE]\n\n");
        deduplicator.complete(dedupKey, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: errBuf,
          completedAt: Date.now(),
        });
      } else {
        // Non-streaming: send transformed error response with context headers.
        // The gateway's request id rides along so a failing paid call can be
        // traced upstream — the reporter of ClawRouter-Hermes#38 had a paid 500
        // on Solana and no id to hand anyone, on either side.
        res.writeHead(errStatus, {
          "Content-Type": "application/json",
          "x-context-used-kb": String(originalContextSizeKB),
          "x-context-limit-kb": String(CONTEXT_LIMIT_KB),
          ...(lastError?.requestId ? { "x-blockrun-request-id": lastError.requestId } : {}),
        });
        res.end(transformedErr);

        deduplicator.complete(dedupKey, {
          status: errStatus,
          headers: { "content-type": "application/json" },
          body: Buffer.from(transformedErr),
          completedAt: Date.now(),
        });
      }

      // Log failed request so users can see it in `clawrouter logs`
      // cost = actual x402 payment if any was made, otherwise 0
      const errModel = routingDecision?.model ?? modelId;
      if (errModel) {
        const errPayment = paymentStore.getStore()?.amountUsd ?? 0;
        logUsage({
          timestamp: new Date().toISOString(),
          model: errModel,
          tier: routingDecision?.tier ?? "DIRECT",
          cost: errPayment,
          baselineCost: errPayment,
          savings: 0,
          latencyMs: Date.now() - startTime,
          status: "error",
        }).catch(() => {});
      }
      return;
    }

    // --- Stream response and collect for dedup cache ---
    const responseChunks: Buffer[] = [];

    if (headersSentEarly) {
      // Streaming: headers already sent. Response should be 200 at this point
      // (non-200 responses are handled in the fallback loop above)

      // Convert non-streaming JSON response to SSE streaming format for client
      // (BlockRun API returns JSON since we forced stream:false)
      // OpenClaw expects: object="chat.completion.chunk" with choices[].delta (not message)
      // We emit proper incremental deltas to match OpenAI's streaming format exactly
      if (upstream.body) {
        const chunks = await readBodyWithTimeout(upstream.body);

        // Combine chunks and transform to streaming format
        const jsonBody = Buffer.concat(chunks);
        const jsonStr = jsonBody.toString();
        try {
          const rsp = JSON.parse(jsonStr) as {
            id?: string;
            object?: string;
            created?: number;
            model?: string;
            choices?: Array<{
              index?: number;
              message?: {
                role?: string;
                content?: string;
                tool_calls?: Array<{
                  id: string;
                  type: string;
                  function: { name: string; arguments: string };
                }>;
              };
              delta?: {
                role?: string;
                content?: string;
                tool_calls?: Array<{
                  id: string;
                  type: string;
                  function: { name: string; arguments: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
            usage?: unknown;
          };

          // Extract input token count from upstream response
          if (rsp.usage && typeof rsp.usage === "object") {
            const u = rsp.usage as Record<string, unknown>;
            if (typeof u.prompt_tokens === "number") responseInputTokens = u.prompt_tokens;
            if (typeof u.completion_tokens === "number") responseOutputTokens = u.completion_tokens;
          }

          // Build base chunk structure (reused for all chunks)
          // Match OpenAI's exact format including system_fingerprint
          const baseChunk = {
            id: rsp.id ?? `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: rsp.created ?? Math.floor(Date.now() / 1000),
            model: actualModelUsed || rsp.model || "unknown",
            system_fingerprint: null,
          };

          // Process each choice (usually just one)
          if (rsp.choices && Array.isArray(rsp.choices)) {
            for (const choice of rsp.choices) {
              const endsWithToolCalls = choice.finish_reason === "tool_calls";
              // A tool-calling turn can still be talking to the user, so the
              // prose in `content` is forwarded alongside `tool_calls` rather
              // than dropped. Thinking blocks are still stripped below, and
              // CLAWROUTER_TOOL_CALL_PROSE=off restores full suppression for
              // models that leak untagged chain-of-thought here.
              let toolCalls = choice.message?.tool_calls ?? choice.delta?.tool_calls;
              const rawContent = choice.message?.content ?? choice.delta?.content ?? "";
              let proseContent = rawContent;

              // When upstream returns no structured tool_calls but the model emitted
              // tool calls as XML/text in `content` (e.g. OpenClaw-instructed
              // `<tool_call><arg_key>...` or Anthropic-style `<function_calls>
              // <invoke>...`), synthesize the structured form so downstream tool
              // executors can dispatch them. The agent loops we saw in the wild
              // (six retries then a hallucinated "API key missing") came from
              // this gap.
              if (!endsWithToolCalls && (!toolCalls || toolCalls.length === 0) && rawContent) {
                const extracted = extractTextualToolCalls(rawContent, { tools: requestTools });
                if (extracted.toolCalls.length > 0) {
                  toolCalls = extracted.toolCalls;
                  // Keep the prose the model wrapped around the call syntax;
                  // the raw `<tool_call>` markup itself is already stripped out.
                  proseContent = extracted.cleanedContent;
                }
              }

              // Strip thinking tokens (Kimi <｜...｜> and standard <think> tags)
              const suppressProse =
                (endsWithToolCalls || (toolCalls && toolCalls.length > 0)) &&
                !forwardToolCallProse();
              const content = suppressProse ? "" : stripThinkingTokens(proseContent);
              const role = choice.message?.role ?? choice.delta?.role ?? "assistant";
              const index = choice.index ?? 0;

              // Accumulate content for session journal
              if (content) {
                accumulatedContent += content;
              }

              // Chunk 1: role only (mimics OpenAI's first chunk)
              const roleChunk = {
                ...baseChunk,
                choices: [{ index, delta: { role }, logprobs: null, finish_reason: null }],
              };
              const roleData = `data: ${JSON.stringify(roleChunk)}\n\n`;
              safeWrite(res, roleData);
              responseChunks.push(Buffer.from(roleData));

              // Chunk 1.5: balance fallback notice (tells user they got free model)
              if (balanceFallbackNotice) {
                const noticeChunk = {
                  ...baseChunk,
                  choices: [
                    {
                      index,
                      delta: { content: balanceFallbackNotice },
                      logprobs: null,
                      finish_reason: null,
                    },
                  ],
                };
                const noticeData = `data: ${JSON.stringify(noticeChunk)}\n\n`;
                safeWrite(res, noticeData);
                responseChunks.push(Buffer.from(noticeData));
                balanceFallbackNotice = undefined; // Only inject once
              }

              // Chunk 1.6: budget downgrade notice (A: visible warning when model downgraded)
              if (budgetDowngradeNotice) {
                const noticeChunk = {
                  ...baseChunk,
                  choices: [
                    {
                      index,
                      delta: { content: budgetDowngradeNotice },
                      logprobs: null,
                      finish_reason: null,
                    },
                  ],
                };
                const noticeData = `data: ${JSON.stringify(noticeChunk)}\n\n`;
                safeWrite(res, noticeData);
                responseChunks.push(Buffer.from(noticeData));
                budgetDowngradeNotice = undefined; // Only inject once
              }

              // Chunk 2: content (single chunk with full content)
              if (content) {
                const contentChunk = {
                  ...baseChunk,
                  choices: [{ index, delta: { content }, logprobs: null, finish_reason: null }],
                };
                const contentData = `data: ${JSON.stringify(contentChunk)}\n\n`;
                safeWrite(res, contentData);
                responseChunks.push(Buffer.from(contentData));
              }

              // Chunk 2b: tool_calls (forward tool calls from upstream)
              if (toolCalls && toolCalls.length > 0) {
                const toolCallChunk = {
                  ...baseChunk,
                  choices: [
                    {
                      index,
                      delta: { tool_calls: toolCalls },
                      logprobs: null,
                      finish_reason: null,
                    },
                  ],
                };
                const toolCallData = `data: ${JSON.stringify(toolCallChunk)}\n\n`;
                safeWrite(res, toolCallData);
                responseChunks.push(Buffer.from(toolCallData));
              }

              // Chunk 3: finish_reason (signals completion)
              const finishChunk = {
                ...baseChunk,
                choices: [
                  {
                    index,
                    delta: {},
                    logprobs: null,
                    finish_reason:
                      endsWithToolCalls || (toolCalls && toolCalls.length > 0)
                        ? "tool_calls"
                        : (choice.finish_reason ?? "stop"),
                  },
                ],
              };
              const finishData = `data: ${JSON.stringify(finishChunk)}\n\n`;
              safeWrite(res, finishData);
              responseChunks.push(Buffer.from(finishData));
            }
          }
        } catch {
          // If parsing fails, wrap in OpenAI error format so SDKs surface a
          // meaningful message instead of throwing a generic "Unexpected error".
          const errPayload = JSON.stringify({
            error: {
              message: `Upstream response could not be parsed: ${jsonStr.slice(0, 200)}`,
              type: "proxy_error",
            },
          });
          const sseData = `data: ${errPayload}\n\n`;
          safeWrite(res, sseData);
          responseChunks.push(Buffer.from(sseData));
        }
      }

      // Send a final usage chunk (OpenAI `stream_options.include_usage` format)
      // carrying both the standard token counts AND the ClawRouter cost breakdown.
      // OpenClaw's session-cost-usage module reads `usage.cost.{total,input,output}`
      // from every assistant message, so emitting the cost here feeds both the
      // per-session footer (/usage full) and the /stats-style reports.
      if (typeof responseInputTokens === "number" && typeof responseOutputTokens === "number") {
        const usagePayload: Record<string, unknown> = {
          prompt_tokens: responseInputTokens,
          completion_tokens: responseOutputTokens,
          total_tokens: responseInputTokens + responseOutputTokens,
        };
        const costBreakdown = buildCostBreakdown({
          actualModelUsed,
          routingProfile: routingProfile ?? undefined,
          routingDecision,
          modelPricing: routerOpts.modelPricing,
          inputTokens: responseInputTokens,
          outputTokens: responseOutputTokens,
          tier: routingDecision?.tier,
        });
        if (costBreakdown) {
          usagePayload.cost = costBreakdown;
        }
        const usageChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: actualModelUsed || "unknown",
          system_fingerprint: null,
          choices: [],
          usage: usagePayload,
        };
        const usageData = `data: ${JSON.stringify(usageChunk)}\n\n`;
        safeWrite(res, usageData);
        responseChunks.push(Buffer.from(usageData));
      }

      // Send cost summary as SSE comment before terminator (human-readable log)
      if (routingDecision) {
        const costComment = `: cost=$${routingDecision.costEstimate.toFixed(4)} savings=${(routingDecision.savings * 100).toFixed(0)}% model=${actualModelUsed} tier=${routingDecision.tier}\n\n`;
        safeWrite(res, costComment);
        responseChunks.push(Buffer.from(costComment));
      }

      // Send SSE terminator
      safeWrite(res, "data: [DONE]\n\n");
      responseChunks.push(Buffer.from("data: [DONE]\n\n"));
      res.end();

      // Cache for dedup
      deduplicator.complete(dedupKey, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: Buffer.concat(responseChunks),
        completedAt: Date.now(),
      });
    } else {
      // Non-streaming: forward status and headers from upstream
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        // Skip hop-by-hop headers and content-encoding (fetch already decompresses)
        if (key === "transfer-encoding" || key === "connection" || key === "content-encoding")
          return;
        responseHeaders[key] = value;
      });

      // Add context usage headers
      responseHeaders["x-context-used-kb"] = String(originalContextSizeKB);
      responseHeaders["x-context-limit-kb"] = String(CONTEXT_LIMIT_KB);

      // Add routing debug headers (on by default; see debugMode above).
      // Reasoning can contain matched multilingual keywords (Cyrillic/CJK) —
      // must be sanitized or res.writeHead throws ERR_INVALID_CHAR after the
      // upstream call has already been paid for.
      if (debugMode && routingDecision) {
        responseHeaders["x-clawrouter-profile"] = routingProfile ?? "auto";
        responseHeaders["x-clawrouter-tier"] = routingDecision.tier;
        responseHeaders["x-clawrouter-model"] = actualModelUsed;
        responseHeaders["x-clawrouter-confidence"] = routingDecision.confidence.toFixed(2);
        responseHeaders["x-clawrouter-reasoning"] = sanitizeHeaderValue(routingDecision.reasoning);
        if (routingDecision.agenticScore !== undefined) {
          responseHeaders["x-clawrouter-agentic-score"] = routingDecision.agenticScore.toFixed(2);
        }
      }

      // Always include cost visibility headers when routing is active
      if (routingDecision) {
        responseHeaders["x-clawrouter-cost"] = routingDecision.costEstimate.toFixed(6);
        responseHeaders["x-clawrouter-savings"] = `${(routingDecision.savings * 100).toFixed(0)}%`;
      }

      // Collect full body for possible notice injection
      const bodyParts: Buffer[] = [];
      if (upstream.body) {
        const chunks = await readBodyWithTimeout(upstream.body);
        for (const chunk of chunks) {
          bodyParts.push(Buffer.from(chunk));
        }
      }

      let responseBody = Buffer.concat(bodyParts);

      // Strip thinking tokens from non-streaming responses (same as streaming path)
      if (responseBody.length > 0) {
        try {
          const parsed = JSON.parse(responseBody.toString()) as {
            choices?: Array<{
              finish_reason?: string | null;
              message?: {
                content?: string;
                tool_calls?: unknown[];
              };
            }>;
          };
          let changed = false;
          for (const choice of parsed.choices ?? []) {
            const message = choice.message;
            if (!message || typeof message.content !== "string") continue;

            if (
              choice.finish_reason === "tool_calls" ||
              (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
            ) {
              const next = forwardToolCallProse() ? stripThinkingTokens(message.content) : "";
              if (message.content !== next) {
                message.content = next;
                changed = true;
              }
              continue;
            }

            // Synthesize tool_calls from XML/text formats some models emit in
            // `content` (OpenClaw `<tool_call><arg_key>...`, Anthropic-style
            // `<function_calls><invoke>...`). Without this, tool calls land as
            // plain text and downstream executors can't dispatch them.
            const extracted = extractTextualToolCalls(message.content, { tools: requestTools });
            if (extracted.toolCalls.length > 0) {
              message.tool_calls = extracted.toolCalls;
              message.content = forwardToolCallProse()
                ? stripThinkingTokens(extracted.cleanedContent)
                : "";
              choice.finish_reason = "tool_calls";
              changed = true;
              continue;
            }

            const stripped = stripThinkingTokens(message.content);
            if (stripped !== message.content) {
              message.content = stripped;
              changed = true;
            }
          }
          if (changed) responseBody = Buffer.from(JSON.stringify(parsed));
        } catch {
          /* not JSON, skip */
        }
      }

      // Prepend balance fallback notice to response content
      if (balanceFallbackNotice && responseBody.length > 0) {
        try {
          const parsed = JSON.parse(responseBody.toString()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          if (parsed.choices?.[0]?.message?.content !== undefined) {
            parsed.choices[0].message.content =
              balanceFallbackNotice + parsed.choices[0].message.content;
            responseBody = Buffer.from(JSON.stringify(parsed));
          }
        } catch {
          /* not JSON, skip notice */
        }
        balanceFallbackNotice = undefined;
      }

      // A: Prepend budget downgrade notice to response content
      if (budgetDowngradeNotice && responseBody.length > 0) {
        try {
          const parsed = JSON.parse(responseBody.toString()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          if (parsed.choices?.[0]?.message?.content !== undefined) {
            parsed.choices[0].message.content =
              budgetDowngradeNotice + parsed.choices[0].message.content;
            responseBody = Buffer.from(JSON.stringify(parsed));
          }
        } catch {
          /* not JSON, skip notice */
        }
        budgetDowngradeNotice = undefined;
      }

      // Inject actualModelUsed + per-call cost breakdown into non-streaming response.
      // - `model` is overwritten unconditionally (some upstreams omit it) so OpenAI
      //   clients see the resolved model, not the routing profile.
      // - `usage.cost` follows OpenClaw's convention (session-cost-usage module reads
      //   `usage.cost.{total,input,output}`). Extra fields (baseline, savings_pct,
      //   model, tier) are forward-compat metadata ignored by current OpenClaw.
      if (actualModelUsed && responseBody.length > 0) {
        try {
          const parsed = JSON.parse(responseBody.toString()) as {
            model?: string;
            usage?: Record<string, unknown>;
          };
          parsed.model = actualModelUsed;

          const costBreakdown = buildCostBreakdown({
            actualModelUsed,
            routingProfile: routingProfile ?? undefined,
            routingDecision,
            modelPricing: routerOpts.modelPricing,
            inputTokens: responseInputTokens,
            outputTokens: responseOutputTokens,
            tier: routingDecision?.tier,
          });
          if (costBreakdown) {
            if (!parsed.usage || typeof parsed.usage !== "object") {
              parsed.usage = {};
            }
            (parsed.usage as Record<string, unknown>).cost = costBreakdown;
          }

          responseBody = Buffer.from(JSON.stringify(parsed));
        } catch {
          /* not JSON, skip model/cost injection */
        }
      }

      // B: Add budget downgrade headers for orchestration layers
      if (budgetDowngradeHeaderMode) {
        responseHeaders["x-clawrouter-budget-downgrade"] = "1";
        responseHeaders["x-clawrouter-budget-mode"] = budgetDowngradeHeaderMode;
        budgetDowngradeHeaderMode = undefined;
      }

      // Update content-length header since body may have changed
      responseHeaders["content-length"] = String(responseBody.length);
      try {
        res.writeHead(upstream.status, responseHeaders);
      } catch (headerError) {
        // Defense in depth: a single invalid header value must never destroy a
        // response the user has already paid for (the failed delivery makes
        // clients retry — and re-pay — in a loop). Sanitize every value and
        // deliver the body; the debug headers are best-effort metadata.
        console.error(
          `[ClawRouter] Invalid response header, sanitizing all values: ${String(headerError)}`,
        );
        for (const [key, value] of Object.entries(responseHeaders)) {
          responseHeaders[key] = sanitizeHeaderValue(value);
        }
        res.writeHead(upstream.status, responseHeaders);
      }
      safeWrite(res, responseBody);
      responseChunks.push(responseBody);
      res.end();

      // Cache for dedup (short-term, 30s)
      deduplicator.complete(dedupKey, {
        status: upstream.status,
        headers: responseHeaders,
        body: responseBody,
        completedAt: Date.now(),
      });

      // Cache for response cache (long-term, 10min) - only successful non-streaming
      if (upstream.status === 200 && responseCache.shouldCache(body)) {
        responseCache.set(cacheKey, {
          body: responseBody,
          status: upstream.status,
          headers: responseHeaders,
          model: actualModelUsed,
        });
        console.log(
          `[ClawRouter] Cached response for ${actualModelUsed} (${responseBody.length} bytes)`,
        );
      }

      // Extract content and token usage from non-streaming response
      try {
        const rspJson = JSON.parse(responseBody.toString()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: Record<string, unknown>;
        };
        if (rspJson.choices?.[0]?.message?.content) {
          accumulatedContent = rspJson.choices[0].message.content;
        }
        if (rspJson.usage && typeof rspJson.usage === "object") {
          if (typeof rspJson.usage.prompt_tokens === "number")
            responseInputTokens = rspJson.usage.prompt_tokens;
          if (typeof rspJson.usage.completion_tokens === "number")
            responseOutputTokens = rspJson.usage.completion_tokens;
        }
      } catch {
        // Ignore parse errors - journal just won't have content for this response
      }
    }

    // --- Degenerate-output diagnostic (fires only on repetition loops) ---
    if (accumulatedContent.length >= 80) {
      const tail = accumulatedContent.slice(-80);
      const tailChars = [...tail];
      const firstChar = tailChars[0];
      const isPunct = /[^\p{L}\p{N}\s]/u.test(firstChar);
      const sameCount = tailChars.filter((c) => c === firstChar).length;
      if (isPunct && sameCount >= 60) {
        console.warn(
          `[ClawRouter] ⚠️  Degenerate output detected — model=${actualModelUsed || "unknown"} len=${accumulatedContent.length} head=${JSON.stringify(accumulatedContent.slice(0, 40))} tail_repeats_${JSON.stringify(firstChar)}=${sameCount}/80`,
        );
      }
    }

    // --- Session Journal: Extract and record events from response ---
    if (sessionId && accumulatedContent) {
      const events = sessionJournal.extractEvents(accumulatedContent);
      if (events.length > 0) {
        sessionJournal.record(sessionId, events, actualModelUsed);
        console.log(
          `[ClawRouter] Recorded ${events.length} events to session journal for session ${sessionId.slice(0, 8)}...`,
        );
      }
    }

    // --- Response Store: persist full response for `clawrouter share` ---
    // Fire-and-forget; errors are swallowed inside appendResponse so they never
    // affect the request flow. Skips silently if BLOCKRUN_RESPONSE_STORE=off.
    if (accumulatedContent && isChatCompletion) {
      void appendResponse({
        sessionId,
        model: actualModelUsed || undefined,
        requestSummary: requestSummaryForStore,
        responseText: accumulatedContent,
      });
    }

    // --- Optimistic balance deduction after successful response ---
    if (estimatedCostMicros !== undefined) {
      balanceMonitor.deductEstimated(estimatedCostMicros);
    }

    // Mark request as completed (for client disconnect cleanup)
    completed = true;
  } catch (err) {
    // Clear timeout and client-close listener on error
    clearTimeout(timeoutId);
    res.removeListener("close", onClientClose);

    // Clear heartbeat on error
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
    }

    // Remove in-flight entry so retries aren't blocked
    deduplicator.removeInflight(dedupKey);

    // Client hung up and we aborted the upstream on purpose: nobody is
    // listening for a response, the balance cache is not suspect, and
    // reporting this as a 300s timeout to onError would be a lie.
    if (
      err instanceof ClientDisconnectedError ||
      (err instanceof Error && err.name === "AbortError" && clientDisconnected())
    ) {
      console.log(`[ClawRouter] Request cancelled — client disconnected`);
      return;
    }

    // Invalidate balance cache on payment failure (might be out of date)
    balanceMonitor.invalidate();

    // Convert abort error to more descriptive timeout error
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`, { cause: err });
    }

    throw err;
  }

  // --- Usage logging (fire-and-forget) ---
  // Use actual x402 payment amount from the per-request AsyncLocalStorage store.
  // This is the real amount the user paid — no estimation needed.
  // Falls back to local estimate only for free models (no x402 payment).
  const logModel = routingDecision?.model ?? modelId;
  if (logModel) {
    const actualPayment = paymentStore.getStore()?.amountUsd ?? 0;

    // For free models (no x402 payment), use local cost calculation as fallback
    let logCost: number;
    let logBaseline: number;
    let logSavings: number;
    if (actualPayment > 0) {
      logCost = actualPayment;
      // Calculate baseline for savings comparison
      const chargedInputTokens = Math.ceil(body.length / 4);
      const modelDef = BLOCKRUN_MODEL_BY_ID.get(logModel);
      const chargedOutputTokens = modelDef ? Math.min(maxTokens, modelDef.maxOutput) : maxTokens;
      const baseline = calculateModelCost(
        logModel,
        routerOpts.modelPricing,
        chargedInputTokens,
        chargedOutputTokens,
        routingProfile ?? undefined,
      );
      logBaseline = baseline.baselineCost;
      logSavings = logBaseline > 0 ? Math.max(0, (logBaseline - logCost) / logBaseline) : 0;
    } else {
      const chargedInputTokens = Math.ceil(body.length / 4);
      const costs = calculateModelCost(
        logModel,
        routerOpts.modelPricing,
        chargedInputTokens,
        maxTokens,
        routingProfile ?? undefined,
      );
      const apiKeyPricing = options.apiKey ? routerOpts.modelPricing.get(logModel) : undefined;
      if (FREE_MODELS.has(logModel)) {
        // Free models: actual cost is $0 (no x402 payment ever made).
        // MIN_PAYMENT_USD floor in calculateModelCost would falsely inflate stats.
        logCost = 0;
        logSavings = 1;
      } else if (apiKeyPricing) {
        // API-key rail: no x402 payment happens, so `actualPayment` is always 0
        // and every call used to land on the estimate below — which adds a 5%
        // server margin, a $0.001 per-transaction settlement fee and a
        // MIN_PAYMENT_USD floor. All three are x402 concepts: the fee covers
        // on-chain gas and the floor is the CDP facilitator's minimum. Account
        // credit settles none of that, and BlockRun confirms this rail charges
        // provider list price with no markup, no per-call fee and no minimum.
        //
        // Measured 2026-09-05: a 12-in/8-out gpt-4o-mini call was billed
        // $0.0000066 while this branch logged $0.001 — a 152x overstatement on
        // small calls, in the number `/stats` reports as money spent.
        //
        // So price it the way the gateway does, and prefer the token counts the
        // response actually reported over an estimate from body length:
        //   (12 * 0.15 + 8 * 0.60) / 1e6 = $0.0000066, matching to the cent.
        const inTokens = responseInputTokens ?? chargedInputTokens;
        const outTokens = responseOutputTokens ?? 0;
        logCost =
          (inTokens * (apiKeyPricing.inputPrice ?? 0) +
            outTokens * (apiKeyPricing.outputPrice ?? 0)) /
          1_000_000;
        logSavings =
          costs.baselineCost > 0
            ? Math.max(0, (costs.baselineCost - logCost) / costs.baselineCost)
            : 0;
      } else {
        // Wallet rail with no payment recorded, or a model we have no price for.
        logCost = costs.costEstimate;
        logSavings = costs.savings;
      }
      logBaseline = costs.baselineCost;
    }

    const entry: UsageEntry = {
      timestamp: new Date().toISOString(),
      ...(upstreamRequestId ? { requestId: upstreamRequestId } : {}),
      model: logModel,
      tier: routingDecision?.tier ?? "DIRECT",
      cost: logCost,
      baselineCost: logBaseline,
      savings: logSavings,
      latencyMs: Date.now() - startTime,
      status: requestHadError ? "error" : "success",
      ...(responseInputTokens !== undefined && { inputTokens: responseInputTokens }),
      ...(responseOutputTokens !== undefined && { outputTokens: responseOutputTokens }),
    };
    logUsage(entry).catch(() => {});
  }
}
