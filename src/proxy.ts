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
 *   - Payment cache: after first 402, pre-signs subsequent requests to skip
 *     the 402 round trip (~200ms savings per request).
 *   - Smart routing: when model is "blockrun/auto", classify query and pick cheapest model.
 *   - Usage logging: log every request as JSON line to ~/.openclaw/blockrun/logs/
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { finished } from "node:stream";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { createPaymentFetch, type PreAuthParams } from "./x402.js";
import {
  route,
  getFallbackChain,
  getFallbackChainFiltered,
  calculateModelCost,
  DEFAULT_ROUTING_CONFIG,
  type RouterOptions,
  type RoutingDecision,
  type RoutingConfig,
  type ModelPricing,
} from "./router/index.js";
import {
  BLOCKRUN_MODELS,
  resolveModelAlias,
  getModelContextWindow,
  isReasoningModel,
} from "./models.js";
import { logUsage, type UsageEntry } from "./logger.js";
import { getStats } from "./stats.js";
import { RequestDeduplicator } from "./dedup.js";
import { BalanceMonitor } from "./balance.js";
// Error classes available for programmatic use but not used in proxy
// (universal free fallback means we don't throw balance errors anymore)
// import { InsufficientFundsError, EmptyWalletError } from "./errors.js";
import { USER_AGENT } from "./version.js";
import { SessionStore, getSessionId, type SessionConfig } from "./session.js";
import { checkForUpdates } from "./updater.js";
import { PROXY_PORT } from "./config.js";

const BLOCKRUN_API = "https://blockrun.ai/api";
// Routing profile models - virtual models that trigger intelligent routing
const AUTO_MODEL = "blockrun/auto";

const ROUTING_PROFILES = new Set([
  "blockrun/free",
  "free",
  "blockrun/eco",
  "eco",
  "blockrun/auto",
  "auto",
  "blockrun/premium",
  "premium",
]);
const FREE_MODEL = "nvidia/gpt-oss-120b"; // Free model for empty wallet fallback
const HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000; // 3 minutes (allows for on-chain tx + LLM response)
const MAX_FALLBACK_ATTEMPTS = 3; // Maximum models to try in fallback chain
const HEALTH_CHECK_TIMEOUT_MS = 2_000; // Timeout for checking existing proxy
const RATE_LIMIT_COOLDOWN_MS = 60_000; // 60 seconds cooldown for rate-limited models
const PORT_RETRY_ATTEMPTS = 5; // Max attempts to bind port (handles TIME_WAIT)
const PORT_RETRY_DELAY_MS = 1_000; // Delay between retry attempts

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
      }
    }

    // Handle settlement failures (gas estimation, on-chain errors)
    if (parsed.error === "Settlement failed" || parsed.details?.includes("Settlement failed")) {
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
 * Track rate-limited models to avoid hitting them again.
 * Maps model ID to the timestamp when the rate limit was hit.
 */
const rateLimitedModels = new Map<string, number>();

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
 * Reorder models to put rate-limited ones at the end.
 */
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
async function checkExistingProxy(port: number): Promise<string | undefined> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = (await response.json()) as { status?: string; wallet?: string };
      if (data.status === "ok" && data.wallet) {
        return data.wallet;
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
];

/**
 * HTTP status codes that indicate provider issues worth retrying with fallback.
 */
const FALLBACK_STATUS_CODES = [
  400, // Bad request - sometimes used for billing errors
  401, // Unauthorized - provider API key issues
  402, // Payment required - but from upstream, not x402
  403, // Forbidden - provider restrictions
  429, // Rate limited
  500, // Internal server error
  502, // Bad gateway
  503, // Service unavailable
  504, // Gateway timeout
];

/**
 * Check if an error response indicates a provider issue that should trigger fallback.
 */
function isProviderError(status: number, body: string): boolean {
  // Check status code first
  if (!FALLBACK_STATUS_CODES.includes(status)) {
    return false;
  }

  // For 5xx errors, always fallback
  if (status >= 500) {
    return true;
  }

  // For 4xx errors, check the body for known provider error patterns
  return PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(body));
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
 * When thinking/extended_thinking is enabled, assistant messages with tool_calls
 * must have reasoning_content (can be empty string if not present).
 * Error: "400 thinking is enabled but reasoning_content is missing in assistant tool call message"
 */
function normalizeMessagesForThinking(messages: ExtendedChatMessage[]): ExtendedChatMessage[] {
  if (!messages || messages.length === 0) return messages;

  let hasChanges = false;
  const normalized = messages.map((msg) => {
    // Skip if not assistant or already has reasoning_content
    if (msg.role !== "assistant" || msg.reasoning_content !== undefined) {
      return msg;
    }

    // Check for OpenAI format: tool_calls array
    const hasOpenAIToolCalls =
      msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;

    // Check for Anthropic format: content array with tool_use blocks
    const hasAnthropicToolUse =
      Array.isArray(msg.content) &&
      (msg.content as Array<{ type?: string }>).some((block) => block?.type === "tool_use");

    if (hasOpenAIToolCalls || hasAnthropicToolUse) {
      hasChanges = true;
      return { ...msg, reasoning_content: "" };
    }
    return msg;
  });

  return hasChanges ? normalized : messages;
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

export type ProxyOptions = {
  walletKey: string;
  apiBase?: string;
  /** Port to listen on (default: 8402) */
  port?: number;
  routingConfig?: Partial<RoutingConfig>;
  /** Request timeout in ms (default: 180000 = 3 minutes). Covers on-chain tx + LLM response. */
  requestTimeoutMs?: number;
  /** Skip balance checks (for testing only). Default: false */
  skipBalanceCheck?: boolean;
  /**
   * Session persistence config. When enabled, maintains model selection
   * across requests within a session to prevent mid-task model switching.
   */
  sessionConfig?: Partial<SessionConfig>;
  onReady?: (port: number) => void;
  onError?: (error: Error) => void;
  onPayment?: (info: { model: string; amount: string; network: string }) => void;
  onRouted?: (decision: RoutingDecision) => void;
  /** Called when balance drops below $1.00 (warning, request still proceeds) */
  onLowBalance?: (info: LowBalanceInfo) => void;
  /** Called when balance is insufficient for a request (request fails) */
  onInsufficientFunds?: (info: InsufficientFundsInfo) => void;
};

export type ProxyHandle = {
  port: number;
  baseUrl: string;
  walletAddress: string;
  balanceMonitor: BalanceMonitor;
  close: () => Promise<void>;
};

/**
 * Build model pricing map from BLOCKRUN_MODELS.
 */
function buildModelPricing(): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const m of BLOCKRUN_MODELS) {
    if (m.id === AUTO_MODEL) continue; // skip meta-model
    map.set(m.id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
  }
  return map;
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

  // Rough estimate: ~4 chars per token for input
  const estimatedInputTokens = Math.ceil(bodyLength / 4);
  const estimatedOutputTokens = maxTokens || model.maxOutput || 4096;

  const costUsd =
    (estimatedInputTokens / 1_000_000) * model.inputPrice +
    (estimatedOutputTokens / 1_000_000) * model.outputPrice;

  // Convert to USDC 6-decimal integer, add 20% buffer for estimation error
  // Minimum 100 ($0.0001) to avoid zero-amount rejections
  const amountMicros = Math.max(100, Math.ceil(costUsd * 1.2 * 1_000_000));
  return amountMicros.toString();
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
  const apiBase = options.apiBase ?? BLOCKRUN_API;

  // Determine port: options.port > env var > default
  const listenPort = options.port ?? getProxyPort();

  // Check if a proxy is already running on this port
  const existingWallet = await checkExistingProxy(listenPort);
  if (existingWallet) {
    // Proxy already running — reuse it instead of failing with EADDRINUSE
    const account = privateKeyToAccount(options.walletKey as `0x${string}`);
    const balanceMonitor = new BalanceMonitor(account.address);
    const baseUrl = `http://127.0.0.1:${listenPort}`;

    // Verify the existing proxy is using the same wallet (or warn if different)
    if (existingWallet !== account.address) {
      console.warn(
        `[ClawRouter] Existing proxy on port ${listenPort} uses wallet ${existingWallet}, but current config uses ${account.address}. Reusing existing proxy.`,
      );
    }

    options.onReady?.(listenPort);

    return {
      port: listenPort,
      baseUrl,
      walletAddress: existingWallet,
      balanceMonitor,
      close: async () => {
        // No-op: we didn't start this proxy, so we shouldn't close it
      },
    };
  }

  // Create x402 payment-enabled fetch from wallet private key
  const account = privateKeyToAccount(options.walletKey as `0x${string}`);
  const { fetch: payFetch } = createPaymentFetch(options.walletKey as `0x${string}`);

  // Create balance monitor for pre-request checks
  const balanceMonitor = new BalanceMonitor(account.address);

  // Build router options (100% local — no external API calls for routing)
  const routingConfig = mergeRoutingConfig(options.routingConfig);
  const modelPricing = buildModelPricing();
  const routerOpts: RouterOptions = {
    config: routingConfig,
    modelPricing,
  };

  // Request deduplicator (shared across all requests)
  const deduplicator = new RequestDeduplicator();

  // Session store for model persistence (prevents mid-task model switching)
  const sessionStore = new SessionStore(options.sessionConfig);

  // Track active connections for graceful cleanup
  const connections = new Set<import("net").Socket>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
      };

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
        res.end(JSON.stringify(stats, null, 2));
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
      const models = BLOCKRUN_MODELS.filter((m) => m.id !== "blockrun/auto").map((m) => ({
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: m.id.split("/")[0] || "unknown",
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models }));
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
          const existingWallet = await checkExistingProxy(listenPort);
          if (existingWallet) {
            // Proxy is actually running - this is fine, reuse it
            console.log(`[ClawRouter] Existing proxy detected on port ${listenPort}, reusing`);
            rejectAttempt({ code: "REUSE_EXISTING", wallet: existingWallet });
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
      const error = err as { code?: string; wallet?: string; attempt?: number };

      if (error.code === "REUSE_EXISTING" && error.wallet) {
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
  payFetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
    preAuth?: PreAuthParams,
  ) => Promise<Response>,
  balanceMonitor: BalanceMonitor,
  signal: AbortSignal,
): Promise<ModelRequestResult> {
  // Update model in body and normalize messages
  let requestBody = body;
  try {
    const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
    parsed.model = modelId;

    // Normalize message roles (e.g., "developer" -> "system")
    if (Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessageRoles(parsed.messages as ChatMessage[]);
    }

    // Sanitize tool IDs to match Anthropic's pattern (alphanumeric, underscore, hyphen only)
    if (Array.isArray(parsed.messages)) {
      parsed.messages = sanitizeToolIds(parsed.messages as ChatMessage[]);
    }

    // Normalize messages for Google models (first non-system message must be "user")
    if (isGoogleModel(modelId) && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForGoogle(parsed.messages as ChatMessage[]);
    }

    // Normalize messages for thinking-enabled requests (add reasoning_content to tool calls)
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

  // Estimate cost for pre-auth
  const estimated = estimateAmount(modelId, requestBody.length, maxTokens);
  const preAuth: PreAuthParams | undefined = estimated ? { estimatedAmount: estimated } : undefined;

  try {
    const response = await payFetch(
      upstreamUrl,
      {
        method,
        headers,
        body: requestBody.length > 0 ? new Uint8Array(requestBody) : undefined,
        signal,
      },
      preAuth,
    );

    // Check for provider errors
    if (response.status !== 200) {
      // Clone response to read body without consuming it
      const errorBody = await response.text();
      const isProviderErr = isProviderError(response.status, errorBody);

      return {
        success: false,
        errorBody,
        errorStatus: response.status,
        isProviderError: isProviderErr,
      };
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
 *   3. Payment pre-auth — estimate USDC amount and pre-sign to skip 402 round trip
 *   4. Smart routing — when model is "blockrun/auto", pick cheapest capable model
 *   5. Fallback chain — on provider errors, try next model in tier's fallback list
 */
async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apiBase: string,
  payFetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
    preAuth?: PreAuthParams,
  ) => Promise<Response>,
  options: ProxyOptions,
  routerOpts: RouterOptions,
  deduplicator: RequestDeduplicator,
  balanceMonitor: BalanceMonitor,
  sessionStore: SessionStore,
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

  // --- Smart routing ---
  let routingDecision: RoutingDecision | undefined;
  let isStreaming = false;
  let modelId = "";
  let maxTokens = 4096;
  let routingProfile: "free" | "eco" | "auto" | "premium" | null = null;
  const isChatCompletion = req.url?.includes("/chat/completions");

  if (isChatCompletion && body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
      isStreaming = parsed.stream === true;
      modelId = (parsed.model as string) || "";
      maxTokens = (parsed.max_tokens as number) || 4096;

      // Force stream: false — BlockRun API doesn't support streaming yet
      // ClawRouter handles SSE heartbeat simulation for upstream compatibility
      let bodyModified = false;
      if (parsed.stream === true) {
        parsed.stream = false;
        bodyModified = true;
      }

      // Normalize model name for comparison (trim whitespace, lowercase)
      const normalizedModel =
        typeof parsed.model === "string" ? parsed.model.trim().toLowerCase() : "";

      // Resolve model aliases (e.g., "claude" -> "anthropic/claude-sonnet-4")
      const resolvedModel = resolveModelAlias(normalizedModel);
      const wasAlias = resolvedModel !== normalizedModel;

      const isRoutingProfile = ROUTING_PROFILES.has(normalizedModel);

      // Extract routing profile type (free/eco/auto/premium)
      if (isRoutingProfile) {
        const profileName = normalizedModel.replace("blockrun/", "");
        routingProfile = profileName as "free" | "eco" | "auto" | "premium";
      }

      // Debug: log received model name
      console.log(
        `[ClawRouter] Received model: "${parsed.model}" -> normalized: "${normalizedModel}"${wasAlias ? ` -> alias: "${resolvedModel}"` : ""}${routingProfile ? `, profile: ${routingProfile}` : ""}`,
      );

      // If alias was resolved, update the model in the request
      if (wasAlias && !isRoutingProfile) {
        parsed.model = resolvedModel;
        modelId = resolvedModel;
        bodyModified = true;
      }

      // Handle routing profiles (free/eco/auto/premium)
      if (isRoutingProfile) {
        // Free profile - direct shortcut to nvidia/gpt-oss-120b (no tier routing)
        if (routingProfile === "free") {
          const freeModel = "nvidia/gpt-oss-120b";
          console.log(`[ClawRouter] Free profile - using ${freeModel} directly`);
          parsed.model = freeModel;
          modelId = freeModel;
          bodyModified = true;

          // Log usage for free profile
          await logUsage({
            timestamp: new Date().toISOString(),
            model: freeModel,
            tier: "SIMPLE",
            cost: 0,
            baselineCost: 0,
            savings: 1.0, // 100% savings
            latencyMs: 0,
          });
        } else {
          // eco/auto/premium - use tier routing
        // Check for session persistence - use pinned model if available
        const sessionId = getSessionId(
          req.headers as Record<string, string | string[] | undefined>,
        );
        const existingSession = sessionId ? sessionStore.getSession(sessionId) : undefined;

        if (existingSession) {
          // Use the session's pinned model instead of re-routing
          console.log(
            `[ClawRouter] Session ${sessionId?.slice(0, 8)}... using pinned model: ${existingSession.model}`,
          );
          parsed.model = existingSession.model;
          modelId = existingSession.model;
          bodyModified = true;
          sessionStore.touchSession(sessionId!);
        } else {
          // No session or expired - route normally
          // Extract prompt from messages
          type ChatMessage = { role: string; content: string };
          const messages = parsed.messages as ChatMessage[] | undefined;
          let lastUserMsg: ChatMessage | undefined;
          if (messages) {
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === "user") {
                lastUserMsg = messages[i];
                break;
              }
            }
          }
          const systemMsg = messages?.find((m: ChatMessage) => m.role === "system");
          const prompt = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
          const systemPrompt =
            typeof systemMsg?.content === "string" ? systemMsg.content : undefined;

          // Tool detection no longer forces agentic mode
          // Agentic mode is now triggered by keyword-based detection (agenticScore >= 0.6)
          // This allows simple queries with tools to use cheaper models
          const tools = parsed.tools as unknown[] | undefined;
          const hasTools = Array.isArray(tools) && tools.length > 0;

          if (hasTools) {
            console.log(`[ClawRouter] Tools detected (${tools.length}), agentic mode via keywords`);
          }

          routingDecision = route(prompt, systemPrompt, maxTokens, {
            ...routerOpts,
            routingProfile: routingProfile ?? undefined,
          });

          // Replace model in body
          parsed.model = routingDecision.model;
          modelId = routingDecision.model;
          bodyModified = true;

          // Pin this model to the session for future requests
          if (sessionId) {
            sessionStore.setSession(sessionId, routingDecision.model, routingDecision.tier);
            console.log(
              `[ClawRouter] Session ${sessionId.slice(0, 8)}... pinned to model: ${routingDecision.model}`,
            );
          }

          options.onRouted?.(routingDecision);
        }
      }
      }

      // Rebuild body if modified
      if (bodyModified) {
        body = Buffer.from(JSON.stringify(parsed));
      }
    } catch (err) {
      // Log routing errors so they're not silently swallowed
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[ClawRouter] Routing error: ${errorMsg}`);
      options.onError?.(new Error(`Routing failed: ${errorMsg}`));
    }
  }

  // --- Dedup check ---
  const dedupKey = RequestDeduplicator.hash(body);

  // Check completed cache first
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
  const isFreeModel = modelId === FREE_MODEL;

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
        // Wallet is empty or insufficient — ALWAYS fallback to free model
        // This ensures new users with empty wallets can still use ClawRouter
        const originalModel = modelId;
        console.log(
          `[ClawRouter] Wallet ${sufficiency.info.isEmpty ? "empty" : "insufficient"} ($${sufficiency.info.balanceUSD}), falling back to free model: ${FREE_MODEL} (requested: ${originalModel})`,
        );
        modelId = FREE_MODEL;
        // Update the body with new model
        const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
        parsed.model = FREE_MODEL;
        body = Buffer.from(JSON.stringify(parsed));

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

  // --- Streaming: early header flush + heartbeat ---
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  let headersSentEarly = false;

  if (isStreaming) {
    // Send 200 + SSE headers immediately, before x402 flow
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
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
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // --- Build fallback chain ---
    // If we have a routing decision, get the full fallback chain for the tier
    // Otherwise, just use the current model (no fallback for explicit model requests)
    let modelsToTry: string[];
    if (routingDecision) {
      // Estimate total context: input tokens (~4 chars per token) + max output tokens
      const estimatedInputTokens = Math.ceil(body.length / 4);
      const estimatedTotalTokens = estimatedInputTokens + maxTokens;

      // Get tier configs (use agentic tiers if routing decided to use them)
      const useAgenticTiers =
        routingDecision.reasoning?.includes("agentic") && routerOpts.config.agenticTiers;
      const tierConfigs = useAgenticTiers
        ? routerOpts.config.agenticTiers!
        : routerOpts.config.tiers;

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

      // Limit to MAX_FALLBACK_ATTEMPTS to prevent infinite loops
      modelsToTry = contextFiltered.slice(0, MAX_FALLBACK_ATTEMPTS);

      // Deprioritize rate-limited models (put them at the end)
      modelsToTry = prioritizeNonRateLimited(modelsToTry);
    } else {
      // For explicit model requests, add free model as emergency fallback
      // in case the primary model fails due to insufficient funds mid-request
      if (modelId && modelId !== FREE_MODEL) {
        modelsToTry = [modelId, FREE_MODEL];
      } else {
        modelsToTry = modelId ? [modelId] : [];
      }
    }

    // --- Fallback loop: try each model until success ---
    let upstream: Response | undefined;
    let lastError: { body: string; status: number } | undefined;
    let actualModelUsed = modelId;

    for (let i = 0; i < modelsToTry.length; i++) {
      const tryModel = modelsToTry[i];
      const isLastAttempt = i === modelsToTry.length - 1;

      console.log(`[ClawRouter] Trying model ${i + 1}/${modelsToTry.length}: ${tryModel}`);

      const result = await tryModelRequest(
        upstreamUrl,
        req.method ?? "POST",
        headers,
        body,
        tryModel,
        maxTokens,
        payFetch,
        balanceMonitor,
        controller.signal,
      );

      if (result.success && result.response) {
        upstream = result.response;
        actualModelUsed = tryModel;
        console.log(`[ClawRouter] Success with model: ${tryModel}`);
        break;
      }

      // Request failed
      lastError = {
        body: result.errorBody || "Unknown error",
        status: result.errorStatus || 500,
      };

      // If it's a provider error and not the last attempt, try next model
      if (result.isProviderError && !isLastAttempt) {
        // Track 429 rate limits to deprioritize this model for future requests
        if (result.errorStatus === 429) {
          markRateLimited(tryModel);
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
    }

    // --- Handle case where all models failed ---
    if (!upstream) {
      const rawErrBody = lastError?.body || "All models in fallback chain failed";
      const errStatus = lastError?.status || 502;

      // Transform payment errors into user-friendly messages
      const transformedErr = transformPaymentError(rawErrBody);

      if (headersSentEarly) {
        // Streaming: send error as SSE event
        // If transformed error is already JSON, parse and use it; otherwise wrap in standard format
        let errPayload: string;
        try {
          const parsed = JSON.parse(transformedErr);
          errPayload = JSON.stringify(parsed);
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
        // Non-streaming: send transformed error response
        res.writeHead(errStatus, { "Content-Type": "application/json" });
        res.end(transformedErr);

        deduplicator.complete(dedupKey, {
          status: errStatus,
          headers: { "content-type": "application/json" },
          body: Buffer.from(transformedErr),
          completedAt: Date.now(),
        });
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
        const reader = upstream.body.getReader();
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }

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

          // Build base chunk structure (reused for all chunks)
          // Match OpenAI's exact format including system_fingerprint
          const baseChunk = {
            id: rsp.id ?? `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: rsp.created ?? Math.floor(Date.now() / 1000),
            model: rsp.model ?? "unknown",
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

              // Chunk 1: role only (mimics OpenAI's first chunk)
              const roleChunk = {
                ...baseChunk,
                choices: [{ index, delta: { role }, logprobs: null, finish_reason: null }],
              };
              const roleData = `data: ${JSON.stringify(roleChunk)}\n\n`;
              safeWrite(res, roleData);
              responseChunks.push(Buffer.from(roleData));

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
          // If parsing fails, send raw response as single chunk
          const sseData = `data: ${jsonStr}\n\n`;
          safeWrite(res, sseData);
          responseChunks.push(Buffer.from(sseData));
        }
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

      res.writeHead(upstream.status, responseHeaders);

      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            safeWrite(res, chunk);
            responseChunks.push(chunk);
          }
        } finally {
          reader.releaseLock();
        }
      }

      res.end();

      // Cache for dedup
      deduplicator.complete(dedupKey, {
        status: upstream.status,
        headers: responseHeaders,
        body: Buffer.concat(responseChunks),
        completedAt: Date.now(),
      });
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
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }

    throw err;
  }

  // --- Usage logging (fire-and-forget) ---
  // Note: Recalculate cost using full body length (not just system+user message)
  // and apply 20% buffer to match actual x402 payment (see estimateAmount())
  if (routingDecision) {
    // Use full body length for accurate cost (matches x402 payment estimation)
    const estimatedInputTokens = Math.ceil(body.length / 4);
    const accurateCosts = calculateModelCost(
      routingDecision.model,
      routerOpts.modelPricing,
      estimatedInputTokens,
      maxTokens,
      routingProfile ?? undefined,
    );
    // Apply 20% buffer to match x402 pre-auth
    const costWithBuffer = accurateCosts.costEstimate * 1.2;
    const baselineWithBuffer = accurateCosts.baselineCost * 1.2;
    const entry: UsageEntry = {
      timestamp: new Date().toISOString(),
      model: routingDecision.model,
      tier: routingDecision.tier,
      cost: costWithBuffer,
      baselineCost: baselineWithBuffer,
      savings: accurateCosts.savings,
      latencyMs: Date.now() - startTime,
    };
    logUsage(entry).catch(() => {});
  }
}
