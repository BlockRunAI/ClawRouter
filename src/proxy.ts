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
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// Per-request payment tracking via AsyncLocalStorage (safe for concurrent requests).
// The x402 onAfterPaymentCreation hook writes the actual payment amount into the
// request-scoped store, and the logging code reads it after payFetch completes.
const paymentStore = new AsyncLocalStorage<{ amountUsd: number }>();
import { finished } from "node:stream";
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
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import {
  route,
  getFallbackChain,
  getFallbackChainFiltered,
  filterByToolCalling,
  filterByVision,
  filterByExcludeList,
  calculateModelCost,
  DEFAULT_ROUTING_CONFIG,
  type RouterOptions,
  type RoutingDecision,
  type RoutingConfig,
  type ModelPricing,
  type Tier,
} from "./router/index.js";
import { classifyByRules } from "./router/rules.js";
import {
  BLOCKRUN_MODELS,
  OPENCLAW_MODELS,
  resolveModelAlias,
  getModelContextWindow,
  isReasoningModel,
  supportsToolCalling,
  supportsVision,
  getActivePromoPrice,
} from "./models.js";
import { logUsage, type UsageEntry } from "./logger.js";
import { getStats, clearStats } from "./stats.js";
import { RequestDeduplicator } from "./dedup.js";
import { ResponseCache, type ResponseCacheConfig } from "./response-cache.js";
import { BalanceMonitor } from "./balance.js";
import type { SolanaBalanceMonitor } from "./solana-balance.js";

/** Union type for chain-agnostic balance monitoring */
type AnyBalanceMonitor = BalanceMonitor | SolanaBalanceMonitor;
import { resolvePaymentChain } from "./auth.js";
import { compressContext, shouldCompress, type NormalizedMessage } from "./compression/index.js";
// Error classes available for programmatic use but not used in proxy
// (universal free fallback means we don't throw balance errors anymore)
// import { InsufficientFundsError, EmptyWalletError } from "./errors.js";
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

const BLOCKRUN_API = "https://blockrun.ai/api";
const BLOCKRUN_SOLANA_API = "https://sol.blockrun.ai/api";
const IMAGE_DIR = join(homedir(), ".openclaw", "blockrun", "images");
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
const FREE_MODEL = "free/gpt-oss-120b"; // Last-resort single free model fallback
const FREE_MODELS = new Set([
  "free/gpt-oss-120b",
  "free/gpt-oss-20b",
  "free/nemotron-ultra-253b",
  "free/nemotron-3-super-120b",
  "free/nemotron-super-49b",
  "free/deepseek-v3.2",
  "free/mistral-large-3-675b",
  "free/qwen3-coder-480b",
  "free/devstral-2-123b",
  "free/glm-4.7",
  "free/llama-4-maverick",
]);
/**
 * Map free/xxx model IDs to nvidia/xxx for upstream BlockRun API.
 * The "free/" prefix is a ClawRouter convention for the /model picker;
 * BlockRun server expects "nvidia/" prefix.
 */
function toUpstreamModelId(modelId: string): string {
  if (modelId.startsWith("free/")) {
    return "nvidia/" + modelId.slice("free/".length);
  }
  return modelId;
}
const MAX_MESSAGES = 200; // BlockRun API limit - truncate older messages if exceeded
const CONTEXT_LIMIT_KB = 5120; // Server-side limit: 5MB in KB
const HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000; // 3 minutes (allows for on-chain tx + LLM response)
const PER_MODEL_TIMEOUT_MS = 60_000; // 60s per individual model attempt (fallback to next on exceed)
const MAX_FALLBACK_ATTEMPTS = 5; // Maximum models to try in fallback chain (increased from 3 to ensure cheap models are tried)
const HEALTH_CHECK_TIMEOUT_MS = 2_000; // Timeout for checking existing proxy
const RATE_LIMIT_COOLDOWN_MS = 60_000; // 60 seconds cooldown for rate-limited models
const OVERLOAD_COOLDOWN_MS = 15_000; // 15 seconds cooldown for overloaded providers
const PORT_RETRY_ATTEMPTS = 5; // Max attempts to bind port (handles TIME_WAIT)
const PORT_RETRY_DELAY_MS = 1_000; // Delay between retry attempts
const MODEL_BODY_READ_TIMEOUT_MS = 300_000; // 5 minutes for model responses (reasoning models are slow)
const ERROR_BODY_READ_TIMEOUT_MS = 30_000; // 30 seconds for error/partner body reads

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
function transformPaymentError(errorBody: string): string {
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

    // Handle blockrun-sol (Solana) format: code=PAYMENT_INVALID + debug=invalidReason string
    if (
      parsed.error === "Payment verification failed" &&
      parsed.code === "PAYMENT_INVALID" &&
      parsed.debug
    ) {
      const debugLower = parsed.debug.toLowerCase();
      const wallet = parsed.payer || "unknown";
      const shortWallet =
        wallet.length > 12 ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : wallet;

      if (debugLower.includes("insufficient")) {
        return JSON.stringify({
          error: {
            message: "Insufficient Solana USDC balance.",
            type: "insufficient_funds",
            wallet,
            help: `Fund wallet ${shortWallet} with USDC on Solana, or switch to Base: /wallet base`,
          },
        });
      }

      if (
        debugLower.includes("transaction_simulation_failed") ||
        debugLower.includes("simulation")
      ) {
        console.error(`[ClawRouter] Solana transaction simulation failed: ${parsed.debug}`);
        return JSON.stringify({
          error: {
            message: "Solana payment simulation failed. Retrying with a different model.",
            type: "transaction_simulation_failed",
            help: "This is usually temporary. If it persists, try: /model free",
          },
        });
      }

      if (debugLower.includes("invalid signature") || debugLower.includes("invalid_signature")) {
        return JSON.stringify({
          error: {
            message: "Solana payment signature invalid.",
            type: "invalid_payload",
            help: "Try again. If this persists, reinstall ClawRouter: curl -fsSL https://blockrun.ai/ClawRouter-update | bash",
          },
        });
      }

      if (debugLower.includes("expired")) {
        return JSON.stringify({
          error: {
            message: "Solana payment expired. Retrying.",
            type: "expired",
            help: "This is usually temporary.",
          },
        });
      }

      // Unknown Solana verification error — surface the debug reason
      console.error(
        `[ClawRouter] Solana payment verification failed: ${parsed.debug} payer=${wallet}`,
      );
      return JSON.stringify({
        error: {
          message: `Solana payment verification failed: ${parsed.debug}`,
          type: "payment_invalid",
          wallet,
          help: "Try again or switch to Base: /wallet base",
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
): Promise<{ wallet: string; paymentChain?: string } | undefined> {
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
      };
      if (data.status === "ok" && data.wallet) {
        return { wallet: data.wallet, paymentChain: data.paymentChain };
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
 * Truncate messages to stay under BlockRun's MAX_MESSAGES limit.
 * Keeps all system messages and the most recent conversation history.
 * Returns the messages and whether truncation occurred.
 */
function truncateMessages<T extends { role: string }>(messages: T[]): TruncationResult<T> {
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
  const truncatedConversation = conversationMsgs.slice(-maxConversation);

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
const THINKING_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>/gi;

// Full thinking blocks: <think>content</think>
const THINKING_BLOCK_RE =
  /<\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;

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

export type ProxyOptions = {
  wallet: WalletConfig;
  apiBase?: string;
  /** Payment chain: "base" (default) or "solana". Can also be set via CLAWROUTER_PAYMENT_CHAIN env var. */
  paymentChain?: PaymentChain;
  /** Port to listen on (default: 8402) */
  port?: number;
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
  /** Called when balance drops below $1.00 (warning, request still proceeds) */
  onLowBalance?: (info: LowBalanceInfo) => void;
  /** Called when balance is insufficient for a request (request fails) */
  onInsufficientFunds?: (info: InsufficientFundsInfo) => void;
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
  walletAddress: string;
  solanaAddress?: string;
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

type ModelListEntry = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
};

/**
 * Build `/v1/models` response entries from the full OpenClaw model registry.
 * This includes alias IDs (e.g., `flash`, `kimi`) so `/model <alias>` works reliably.
 */
export function buildProxyModelList(
  createdAt: number = Math.floor(Date.now() / 1000),
): ModelListEntry[] {
  const seen = new Set<string>();
  return OPENCLAW_MODELS.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  }).map((model) => ({
    id: model.id,
    object: "model",
    created: createdAt,
    owned_by: model.id.includes("/") ? (model.id.split("/")[0] ?? "blockrun") : "blockrun",
  }));
}

/**
 * Merge partial routing config overrides with defaults.
 */
function mergeRoutingConfig(overrides?: Partial<RoutingConfig>): RoutingConfig {
  if (!overrides) return DEFAULT_ROUTING_CONFIG;
  return {
    ...DEFAULT_ROUTING_CONFIG,
    ...overrides,
    classifier: { ...DEFAULT_ROUTING_CONFIG.classifier, ...overrides.classifier },
    scoring: { ...DEFAULT_ROUTING_CONFIG.scoring, ...overrides.scoring },
    tiers: { ...DEFAULT_ROUTING_CONFIG.tiers, ...overrides.tiers },
    overrides: { ...DEFAULT_ROUTING_CONFIG.overrides, ...overrides.overrides },
  };
}

/**
 * Estimate USDC cost for a request based on model pricing.
 * Returns amount string in USDC smallest unit (6 decimals) or undefined if unknown.
 */
function estimateAmount(
  modelId: string,
  bodyLength: number,
  maxTokens: number,
): string | undefined {
  const model = BLOCKRUN_MODELS.find((m) => m.id === modelId);
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

  // Convert to USDC 6-decimal integer, add 20% buffer for estimation error
  // Minimum 1000 ($0.001) to match CDP Facilitator's enforced minimum payment
  const amountMicros = Math.max(1000, Math.ceil(costUsd * 1.2 * 1_000_000));
  return amountMicros.toString();
}

// Image pricing table (must match server's IMAGE_MODELS in blockrun/src/lib/models.ts)
// Server applies 5% margin on top of these prices.
const IMAGE_PRICING: Record<string, { default: number; sizes?: Record<string, number> }> = {
  "openai/dall-e-3": {
    default: 0.04,
    sizes: { "1024x1024": 0.04, "1792x1024": 0.08, "1024x1792": 0.08 },
  },
  "openai/gpt-image-1": {
    default: 0.02,
    sizes: { "1024x1024": 0.02, "1536x1024": 0.04, "1024x1536": 0.04 },
  },
  "black-forest/flux-1.1-pro": { default: 0.04 },
  "google/nano-banana": { default: 0.05 },
  "google/nano-banana-pro": {
    default: 0.1,
    sizes: { "1024x1024": 0.1, "2048x2048": 0.1, "4096x4096": 0.15 },
  },
};

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
 * Proxy a partner API request through x402 payment flow.
 *
 * Simplified proxy for partner endpoints (/v1/x/*, /v1/partner/*).
 * No smart routing, SSE, compression, or sessions — just collect body,
 * forward via payFetch (which handles 402 automatically), and stream back.
 */
async function proxyPartnerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apiBase: string,
  payFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  getActualPaymentUsd: () => number,
): Promise<void> {
  const startTime = Date.now();
  const upstreamUrl = `${apiBase}${req.url}`;

  // Collect request body
  const bodyChunks: Buffer[] = [];
  for await (const chunk of req) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(bodyChunks);

  // Forward headers (strip hop-by-hop)
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      key === "host" ||
      key === "connection" ||
      key === "transfer-encoding" ||
      key === "content-length"
    )
      continue;
    if (typeof value === "string") headers[key] = value;
  }
  if (!headers["content-type"]) headers["content-type"] = "application/json";
  headers["user-agent"] = USER_AGENT;

  console.log(`[ClawRouter] Partner request: ${req.method} ${req.url}`);

  const upstream = await payFetch(upstreamUrl, {
    method: req.method ?? "POST",
    headers,
    body: body.length > 0 ? new Uint8Array(body) : undefined,
  });

  // Forward response headers
  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (key === "transfer-encoding" || key === "connection" || key === "content-encoding") return;
    responseHeaders[key] = value;
  });

  res.writeHead(upstream.status, responseHeaders);

  // Stream response body
  if (upstream.body) {
    const chunks = await readBodyWithTimeout(upstream.body, ERROR_BODY_READ_TIMEOUT_MS);
    for (const chunk of chunks) {
      safeWrite(res, Buffer.from(chunk));
    }
  }

  res.end();

  const latencyMs = Date.now() - startTime;
  console.log(`[ClawRouter] Partner response: ${upstream.status} (${latencyMs}ms)`);

  // Log partner usage with actual x402 payment amount (previously logged cost: 0)
  const partnerCost = getActualPaymentUsd();
  logUsage({
    timestamp: new Date().toISOString(),
    model: "partner",
    tier: "PARTNER",
    cost: partnerCost,
    baselineCost: partnerCost,
    savings: 0,
    latencyMs,
    partnerId:
      (req.url?.split("?")[0] ?? "").replace(/^\/v1\//, "").replace(/\//g, "_") || "unknown",
    service: "partner",
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

  // Normalize wallet config: string = EVM-only, object = full resolution
  const walletKey = typeof options.wallet === "string" ? options.wallet : options.wallet.key;
  const solanaPrivateKeyBytes =
    typeof options.wallet === "string" ? undefined : options.wallet.solanaPrivateKeyBytes;

  // Payment chain: options > env var > persisted file > default "base".
  // No dynamic switching — user selects chain via /wallet solana or /wallet base.
  const paymentChain = options.paymentChain ?? (await resolvePaymentChain());
  const apiBase =
    options.apiBase ??
    (paymentChain === "solana" && solanaPrivateKeyBytes ? BLOCKRUN_SOLANA_API : BLOCKRUN_API);
  if (paymentChain === "solana" && !solanaPrivateKeyBytes) {
    console.warn(
      `[ClawRouter] ⚠ Payment chain is Solana but no mnemonic found — falling back to Base (EVM).`,
    );
    console.warn(
      `[ClawRouter]   To fix: run "npx @blockrun/clawrouter wallet recover" if your mnemonic exists,`,
    );
    console.warn(`[ClawRouter]   or run "npx @blockrun/clawrouter chain base" to switch to EVM.`);
  } else if (paymentChain === "solana") {
    console.log(`[ClawRouter] Payment chain: Solana (${BLOCKRUN_SOLANA_API})`);
  }

  // Determine port: options.port > env var > default
  const listenPort = options.port ?? getProxyPort();

  // Check if a proxy is already running on this port
  const existingProxy = await checkExistingProxy(listenPort);
  if (existingProxy) {
    // Proxy already running — reuse it instead of failing with EADDRINUSE
    const account = privateKeyToAccount(walletKey as `0x${string}`);
    const baseUrl = `http://127.0.0.1:${listenPort}`;

    // Verify the existing proxy is using the same wallet (or warn if different)
    if (existingProxy.wallet !== account.address) {
      console.warn(
        `[ClawRouter] Existing proxy on port ${listenPort} uses wallet ${existingProxy.wallet}, but current config uses ${account.address}. Reusing existing proxy.`,
      );
    }

    // Verify the existing proxy is using the same payment chain
    if (existingProxy.paymentChain) {
      if (existingProxy.paymentChain !== paymentChain) {
        throw new Error(
          `Existing proxy on port ${listenPort} is using ${existingProxy.paymentChain} but ${paymentChain} was requested. ` +
            `Stop the existing proxy first or use a different port.`,
        );
      }
    } else if (paymentChain !== "base") {
      // Old proxy doesn't report chain — assume Base. Reject if Solana was requested.
      console.warn(
        `[ClawRouter] Existing proxy on port ${listenPort} does not report paymentChain (pre-v0.11 instance). Assuming Base.`,
      );
      throw new Error(
        `Existing proxy on port ${listenPort} is a pre-v0.11 instance (assumed Base) but ${paymentChain} was requested. ` +
          `Stop the existing proxy first or use a different port.`,
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
      balanceMonitor,
      close: async () => {
        // No-op: we didn't start this proxy, so we shouldn't close it
      },
    };
  }

  // Create x402 payment client with EVM scheme (always available)
  const account = privateKeyToAccount(walletKey as `0x${string}`);
  const evmPublicClient = createPublicClient({ chain: base, transport: http() });
  const evmSigner = toClientEvmSigner(account, evmPublicClient);
  const x402 = new x402Client();
  registerExactEvmScheme(x402, { signer: evmSigner });

  // Register Solana scheme if key is available
  // Uses registerExactSvmScheme helper which registers:
  //   - solana:* wildcard (catches any CAIP-2 Solana network)
  //   - V1 compat names: "solana", "solana-devnet", "solana-testnet"
  let solanaAddress: string | undefined;
  if (solanaPrivateKeyBytes) {
    const { registerExactSvmScheme } = await import("@x402/svm/exact/client");
    const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
    const solanaSigner = await createKeyPairSignerFromPrivateKeyBytes(solanaPrivateKeyBytes);
    solanaAddress = solanaSigner.address;
    registerExactSvmScheme(x402, { signer: solanaSigner });
    console.log(`[ClawRouter] Solana wallet: ${solanaAddress}`);
  }

  // Log which chain is used for each payment and capture actual payment amount
  x402.onAfterPaymentCreation(async (context) => {
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

  const payFetch = createPayFetchWithPreAuth(fetch, x402, undefined, {
    skipPreAuth: paymentChain === "solana",
  });

  // Create balance monitor for pre-request checks (lazy import to avoid loading @solana/kit on Base chain)
  let balanceMonitor: AnyBalanceMonitor;
  if (options._balanceMonitorOverride) {
    balanceMonitor = options._balanceMonitorOverride;
  } else if (paymentChain === "solana" && solanaAddress) {
    const { SolanaBalanceMonitor } = await import("./solana-balance.js");
    balanceMonitor = new SolanaBalanceMonitor(solanaAddress);
  } else {
    balanceMonitor = new BalanceMonitor(account.address);
  }

  // Build router options (100% local — no external API calls for routing)
  const routingConfig = mergeRoutingConfig(options.routingConfig);
  const modelPricing = buildModelPricing();
  const routerOpts: RouterOptions = {
    config: routingConfig,
    modelPricing,
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
    paymentStore.run({ amountUsd: 0 }, async () => {
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
          wallet: account.address,
          paymentChain,
        };
        if (solanaAddress) {
          response.solana = solanaAddress;
        }
        if (upstreamProxy) {
          response.upstreamProxy = upstreamProxy;
        }

        if (full) {
          try {
            const balanceInfo = await balanceMonitor.checkBalance();
            response.balance = balanceInfo.balanceUSD;
            response.isLow = balanceInfo.isLow;
            response.isEmpty = balanceInfo.isEmpty;
          } catch {
            response.balanceError = "Could not fetch balance";
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
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
          const days = parseInt(url.searchParams.get("days") || "7", 10);
          const stats = await getStats(Math.min(days, 30));

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

      // --- Handle /v1/images/generations: proxy with x402 payment + save data URIs locally ---
      // NOTE: image generation endpoints bypass maxCostPerRun budget tracking entirely.
      // Cost is charged via x402 micropayment directly — no session accumulation or cap enforcement.
      if (req.url === "/v1/images/generations" && req.method === "POST") {
        const imgStartTime = Date.now();
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
          imgModel = parsed.model || "openai/dall-e-3";
          const n = parsed.n || 1;
          imgCost = estimateImageCost(imgModel, parsed.size, n);
        } catch {
          /* use defaults */
        }
        try {
          const upstream = await payFetch(`${apiBase}/v1/images/generations`, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": USER_AGENT },
            body: reqBody,
          });
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
                  const imgResp = await fetch(img.url);
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
          const imgActualCost = paymentStore.getStore()?.amountUsd ?? imgCost;
          logUsage({
            timestamp: new Date().toISOString(),
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
              const imgResp = await fetch(val);
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
          const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request", details: msg }));
          return;
        }

        try {
          const upstream = await payFetch(`${apiBase}/v1/images/image2image`, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": USER_AGENT },
            body: reqBody,
          });
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
                  const imgResp = await fetch(img.url);
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
          const img2imgActualCost = paymentStore.getStore()?.amountUsd ?? img2imgCost;
          logUsage({
            timestamp: new Date().toISOString(),
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
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[ClawRouter] Image editing error: ${msg}`);
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Image editing failed", details: msg }));
          }
        }
        return;
      }

      // --- Handle partner API paths (/v1/x/*, /v1/partner/*, /v1/pm/*) ---
      if (req.url?.match(/^\/v1\/(?:x|partner|pm)\//)) {
        try {
          await proxyPartnerRequest(
            req,
            res,
            apiBase,
            payFetch,
            () => paymentStore.getStore()?.amountUsd ?? 0,
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
  });

  // Listen on configured port with retry logic for TIME_WAIT handling
  // When gateway restarts quickly, the port may still be in TIME_WAIT state.
  // We retry with delay instead of incorrectly assuming a proxy is running.
  const tryListen = (attempt: number): Promise<void> => {
    return new Promise<void>((resolveAttempt, rejectAttempt) => {
      const onError = async (err: NodeJS.ErrnoException) => {
        server.removeListener("error", onError);

        if (err.code === "EADDRINUSE") {
          // Port is in use - check if a proxy is actually running
          const existingProxy2 = await checkExistingProxy(listenPort);
          if (existingProxy2) {
            // Proxy is actually running - this is fine, reuse it
            console.log(`[ClawRouter] Existing proxy detected on port ${listenPort}, reusing`);
            rejectAttempt({
              code: "REUSE_EXISTING",
              wallet: existingProxy2.wallet,
              existingChain: existingProxy2.paymentChain,
            });
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
        wallet?: string;
        existingChain?: string;
        attempt?: number;
      };

      if (error.code === "REUSE_EXISTING" && error.wallet) {
        // Validate payment chain matches (same check as pre-listen reuse path)
        if (error.existingChain && error.existingChain !== paymentChain) {
          throw new Error(
            `Existing proxy on port ${listenPort} is using ${error.existingChain} but ${paymentChain} was requested. ` +
              `Stop the existing proxy first or use a different port.`,
            { cause: err },
          );
        }

        // Proxy is running, reuse it
        const baseUrl = `http://127.0.0.1:${listenPort}`;
        options.onReady?.(listenPort);
        return {
          port: listenPort,
          baseUrl,
          walletAddress: error.wallet,
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
    walletAddress: account.address,
    solanaAddress,
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
};

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
    return {
      success: false,
      errorBody: errorMsg,
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

  // Routing debug info is on by default; disable with x-clawrouter-debug: false
  const debugMode = req.headers["x-clawrouter-debug"] !== "false";

  // --- Smart routing ---
  let routingDecision: RoutingDecision | undefined;
  let hasTools = false; // true when request includes a tools schema
  let hasVision = false; // true when request includes image_url content parts
  let isStreaming = false;
  let modelId = "";
  let maxTokens = 4096;
  let routingProfile: "eco" | "auto" | "premium" | null = null;
  let balanceFallbackNotice: string | undefined;
  let budgetDowngradeNotice: string | undefined;
  let budgetDowngradeHeaderMode: "downgraded" | undefined;
  let accumulatedContent = ""; // For session journal event extraction
  let responseInputTokens: number | undefined;
  let responseOutputTokens: number | undefined;
  let requestHadError = false; // Set to true when all models fail → used in logUsage
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
      maxTokens = (parsed.max_tokens as number) || 4096;
      let bodyModified = false;

      // Extract last user message content (used by session journal + /debug command)
      const parsedMessages = Array.isArray(parsed.messages)
        ? (parsed.messages as Array<{ role: string; content: unknown }>)
        : [];
      const lastUserMsg = [...parsedMessages].reverse().find((m) => m.role === "user");

      // Early tool detection for ALL request types (explicit model + routing profile).
      // The routing-profile branch may re-assign below (no-op since same value).
      hasTools = Array.isArray(parsed.tools) && (parsed.tools as unknown[]).length > 0;
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

      // --- /imagegen command: generate an image via BlockRun image API ---
      if (lastContent.startsWith("/imagegen")) {
        const imageArgs = lastContent.slice("/imagegen".length).trim();

        // Parse optional flags: /imagegen --model dall-e-3 --size 1792x1024 a cute cat
        let imageModel = "google/nano-banana";
        let imageSize = "1024x1024";
        let imagePrompt = imageArgs;

        // Extract --model flag
        const modelMatch = imageArgs.match(/--model\s+(\S+)/);
        if (modelMatch) {
          const raw = modelMatch[1];
          // Resolve shorthand aliases
          const IMAGE_MODEL_ALIASES: Record<string, string> = {
            "dall-e-3": "openai/dall-e-3",
            dalle3: "openai/dall-e-3",
            dalle: "openai/dall-e-3",
            "gpt-image": "openai/gpt-image-1",
            "gpt-image-1": "openai/gpt-image-1",
            flux: "black-forest/flux-1.1-pro",
            "flux-pro": "black-forest/flux-1.1-pro",
            banana: "google/nano-banana",
            "nano-banana": "google/nano-banana",
            "banana-pro": "google/nano-banana-pro",
            "nano-banana-pro": "google/nano-banana-pro",
          };
          imageModel = IMAGE_MODEL_ALIASES[raw] ?? raw;
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
            "Usage: /imagegen <prompt>",
            "",
            "Options:",
            "  --model <model>  Model to use (default: nano-banana)",
            "  --size <WxH>     Image size (default: 1024x1024)",
            "",
            "Models:",
            "  nano-banana       Google Gemini Flash — $0.05/image",
            "  banana-pro        Google Gemini Pro — $0.10/image (up to 4K)",
            "  dall-e-3          OpenAI DALL-E 3 — $0.04/image",
            "  gpt-image         OpenAI GPT Image 1 — $0.02/image",
            "  flux              Black Forest Flux 1.1 Pro — $0.04/image",
            "",
            "Examples:",
            "  /imagegen a cat wearing sunglasses",
            "  /imagegen --model dall-e-3 a futuristic city at sunset",
            "  /imagegen --model banana-pro --size 2048x2048 mountain landscape",
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
        try {
          const imageUpstreamUrl = `${apiBase}/v1/images/generations`;
          const imageBody = JSON.stringify({
            model: imageModel,
            prompt: imagePrompt,
            size: imageSize,
            n: 1,
          });
          const imageResponse = await payFetch(imageUpstreamUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": USER_AGENT },
            body: imageBody,
          });

          const imageResult = (await imageResponse.json()) as {
            created?: number;
            data?: Array<{ url?: string; revised_prompt?: string }>;
            error?: string | { message?: string };
          };

          let responseText: string;
          if (!imageResponse.ok || imageResult.error) {
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
                      lines.push(
                        "Image generated but upload failed. Try again or use --model dall-e-3.",
                      );
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
            const imagegenActualCost =
              paymentStore.getStore()?.amountUsd ?? estimateImageCost(imageModel, imageSize, 1);
            logUsage({
              timestamp: new Date().toISOString(),
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

        try {
          const img2imgBody = JSON.stringify({
            model: img2imgModel,
            prompt: img2imgPrompt,
            image: imageDataUri,
            ...(maskDataUri ? { mask: maskDataUri } : {}),
            size: img2imgSize,
            n: 1,
          });

          const img2imgResponse = await payFetch(`${apiBase}/v1/images/image2image`, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": USER_AGENT },
            body: img2imgBody,
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
            const img2imgActualCost2 =
              paymentStore.getStore()?.amountUsd ?? estimateImageCost(img2imgModel, img2imgSize, 1);
            logUsage({
              timestamp: new Date().toISOString(),
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

          if (hasTools && tools) {
            console.log(`[ClawRouter] Tools detected (${tools.length}), forcing agentic tiers`);
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
          });

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
            const shouldEscalate = sessionStore.recordRequestHash(effectiveSessionId!, contentHash);

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
  const cacheKey = ResponseCache.generateKey(body);
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
  const dedupKey = RequestDeduplicator.hash(body);

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
    if (estimated) {
      estimatedCostMicros = BigInt(estimated);

      // Apply extra buffer for balance check to prevent x402 failures after streaming starts.
      // This is aggressive to avoid triggering OpenClaw's 5-24 hour billing cooldown.
      const bufferedCostMicros =
        (estimatedCostMicros * BigInt(Math.ceil(BALANCE_CHECK_BUFFER * 100))) / 100n;

      // Check balance before proceeding (using buffered amount)
      const sufficiency = await balanceMonitor.checkSufficient(bufferedCostMicros);

      if (sufficiency.info.isEmpty || !sufficiency.sufficient) {
        // Wallet is empty or insufficient — fallback to free model
        const originalModel = modelId;
        console.log(
          `[ClawRouter] Wallet ${sufficiency.info.isEmpty ? "empty" : "insufficient"} (${sufficiency.info.balanceUSD}), falling back to free model: ${FREE_MODEL} (requested: ${originalModel})`,
        );
        modelId = FREE_MODEL;
        isFreeModel = true; // keep in sync — budget logic gates on !isFreeModel
        // Update the body with new model (map free/ → nvidia/ for upstream)
        const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
        parsed.model = toUpstreamModelId(FREE_MODEL);
        body = Buffer.from(JSON.stringify(parsed));

        // Set notice to prepend to response so user knows about the fallback
        balanceFallbackNotice = sufficiency.info.isEmpty
          ? `> **⚠️ Wallet empty** — using free model. Fund your wallet to use ${originalModel}.\n\n`
          : `> **⚠️ Insufficient balance** (${sufficiency.info.balanceUSD}) — using free model instead of ${originalModel}.\n\n`;

        // Notify about the fallback
        options.onLowBalance?.({
          balanceUSD: sufficiency.info.balanceUSD,
          walletAddress: sufficiency.info.walletAddress,
        });
      } else if (sufficiency.info.isLow) {
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

  // Forward headers, stripping host, connection, and content-length
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      key === "host" ||
      key === "connection" ||
      key === "transfer-encoding" ||
      key === "content-length"
    )
      continue;
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

  try {
    // --- Build fallback chain ---
    // If we have a routing decision, get the full fallback chain for the tier
    // Otherwise, just use the current model (no fallback for explicit model requests)
    let modelsToTry: string[];
    const excludeList = options.excludeModels ?? loadExcludeList();
    if (routingDecision) {
      // Estimate total context: input tokens (~4 chars per token) + max output tokens
      const estimatedInputTokens = Math.ceil(body.length / 4);
      const estimatedTotalTokens = estimatedInputTokens + maxTokens;

      // Use tier configs from the routing decision (set by RouterStrategy)
      const tierConfigs = routingDecision.tierConfigs ?? routerOpts.config.tiers;

      // Get full chain first, then filter by context
      const fullChain = getFallbackChain(routingDecision.tier, tierConfigs);
      const contextFiltered = getFallbackChainFiltered(
        routingDecision.tier,
        tierConfigs,
        estimatedTotalTokens,
        getModelContextWindow,
      );

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

    // Ensure free model is the last-resort fallback for non-tool requests.
    // Skip free fallback when tools are present — nvidia/gpt-oss-120b lacks
    // tool calling support and would produce broken responses for agentic tasks.
    if (!hasTools && !modelsToTry.includes(FREE_MODEL) && !excludeList.has(FREE_MODEL)) {
      modelsToTry.push(FREE_MODEL); // last-resort free fallback
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
    let lastError: { body: string; status: number } | undefined;
    let actualModelUsed = modelId;
    const failedAttempts: Array<{ model: string; reason: string; status: number }> = [];

    for (let i = 0; i < modelsToTry.length; i++) {
      const tryModel = modelsToTry[i];
      const isLastAttempt = i === modelsToTry.length - 1;

      // Abort immediately if global deadline has already fired
      if (globalController.signal.aborted) {
        throw new Error(`Request timed out after ${timeoutMs}ms`);
      }

      console.log(`[ClawRouter] Trying model ${i + 1}/${modelsToTry.length}: ${tryModel}`);

      // Per-model abort controller — each model attempt gets its own 60s window.
      // When it fires, the fallback loop moves to the next model rather than failing.
      const modelController = new AbortController();
      const modelTimeoutId = setTimeout(() => modelController.abort(), PER_MODEL_TIMEOUT_MS);
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

      // If the global deadline fired during this attempt, bail out entirely
      if (globalController.signal.aborted) {
        throw new Error(`Request timed out after ${timeoutMs}ms`);
      }

      // If the per-model timeout fired (but not global), treat as fallback-worthy error
      if (!result.success && modelController.signal.aborted && !isLastAttempt) {
        console.log(
          `[ClawRouter] Model ${tryModel} timed out after ${PER_MODEL_TIMEOUT_MS}ms, trying fallback`,
        );
        recordProviderError(tryModel, "server_error");
        continue;
      }

      if (result.success && result.response) {
        upstream = result.response;
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
        const freeIdx = modelsToTry.indexOf(FREE_MODEL);
        if (freeIdx > i + 1) {
          console.log(`[ClawRouter] Payment error — skipping to free model: ${FREE_MODEL}`);
          i = freeIdx - 1; // loop will increment to freeIdx
          continue;
        }
        // Free model not in chain — add it and try
        if (freeIdx === -1) {
          modelsToTry.push(FREE_MODEL);
          console.log(`[ClawRouter] Payment error — appending free model: ${FREE_MODEL}`);
          continue;
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
              const retryController = new AbortController();
              const retryTimeoutId = setTimeout(
                () => retryController.abort(),
                PER_MODEL_TIMEOUT_MS,
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
                if (options.maxCostPerRunUsd && effectiveSessionId && tryModel !== FREE_MODEL) {
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

    // Clear timeout — request attempts completed
    clearTimeout(timeoutId);

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
        sessionStore.setSession(effectiveSessionId, actualModelUsed, routingDecision.tier);
        console.log(
          `[ClawRouter] Session ${effectiveSessionId.slice(0, 8)}... updated pin to fallback: ${actualModelUsed}`,
        );
      }
    }

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
      console.log(`[ClawRouter] ${structuredMessage}`);
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
        // Non-streaming: send transformed error response with context headers
        res.writeHead(errStatus, {
          "Content-Type": "application/json",
          "x-context-used-kb": String(originalContextSizeKB),
          "x-context-limit-kb": String(CONTEXT_LIMIT_KB),
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
              // Strip thinking tokens (Kimi <｜...｜> and standard <think> tags)
              const rawContent = choice.message?.content ?? choice.delta?.content ?? "";
              const content = stripThinkingTokens(rawContent);
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
              const toolCalls = choice.message?.tool_calls ?? choice.delta?.tool_calls;
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
                      toolCalls && toolCalls.length > 0
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

      // Send cost summary as SSE comment before terminator
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

      // Add routing debug headers (opt-in via x-clawrouter-debug: true header)
      if (debugMode && routingDecision) {
        responseHeaders["x-clawrouter-profile"] = routingProfile ?? "auto";
        responseHeaders["x-clawrouter-tier"] = routingDecision.tier;
        responseHeaders["x-clawrouter-model"] = actualModelUsed;
        responseHeaders["x-clawrouter-confidence"] = routingDecision.confidence.toFixed(2);
        responseHeaders["x-clawrouter-reasoning"] = routingDecision.reasoning;
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
            choices?: Array<{ message?: { content?: string } }>;
          };
          if (parsed.choices?.[0]?.message?.content) {
            const stripped = stripThinkingTokens(parsed.choices[0].message.content);
            if (stripped !== parsed.choices[0].message.content) {
              parsed.choices[0].message.content = stripped;
              responseBody = Buffer.from(JSON.stringify(parsed));
            }
          }
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

      // Inject actualModelUsed into non-streaming response model field
      if (actualModelUsed && responseBody.length > 0) {
        try {
          const parsed = JSON.parse(responseBody.toString()) as { model?: string };
          if (parsed.model !== undefined) {
            parsed.model = actualModelUsed;
            responseBody = Buffer.from(JSON.stringify(parsed));
          }
        } catch {
          /* not JSON, skip model injection */
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
      res.writeHead(upstream.status, responseHeaders);
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

    // --- Optimistic balance deduction after successful response ---
    if (estimatedCostMicros !== undefined) {
      balanceMonitor.deductEstimated(estimatedCostMicros);
    }

    // Mark request as completed (for client disconnect cleanup)
    completed = true;
  } catch (err) {
    // Clear timeout on error
    clearTimeout(timeoutId);

    // Clear heartbeat on error
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
    }

    // Remove in-flight entry so retries aren't blocked
    deduplicator.removeInflight(dedupKey);

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
      const modelDef = BLOCKRUN_MODELS.find((m) => m.id === logModel);
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
      // Free models: actual cost is $0 (no x402 payment ever made).
      // MIN_PAYMENT_USD floor in calculateModelCost would falsely inflate stats.
      logCost = FREE_MODELS.has(logModel) ? 0 : costs.costEstimate;
      logBaseline = costs.baselineCost;
      logSavings = FREE_MODELS.has(logModel) ? 1 : costs.savings;
    }

    const entry: UsageEntry = {
      timestamp: new Date().toISOString(),
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
