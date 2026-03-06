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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { finished } from "node:stream";
import type { AddressInfo } from "node:net";
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
} from "./models.js";
import { logUsage, type UsageEntry } from "./logger.js";
import { getStats, clearStats } from "./stats.js";
import { RequestDeduplicator } from "./dedup.js";
import { ResponseCache, type ResponseCacheConfig } from "./response-cache.js";
import { BalanceMonitor } from "./balance.js";
import { SolanaBalanceMonitor } from "./solana-balance.js";

/** Union type for chain-agnostic balance monitoring */
type AnyBalanceMonitor = BalanceMonitor | SolanaBalanceMonitor;
import { resolvePaymentChain } from "./auth.js";
import { compressContext, shouldCompress, type NormalizedMessage } from "./compression/index.js";
// Error classes available for programmatic use but not used in proxy
// (universal free fallback means we don't throw balance errors anymore)
// import { InsufficientFundsError, EmptyWalletError } from "./errors.js";
import { USER_AGENT } from "./version.js";
import {
  SessionStore,
  getSessionId,
  deriveSessionId,
  hashRequestContent,
  type SessionConfig,
} from "./session.js";
import { checkForUpdates } from "./updater.js";
import { PROXY_PORT } from "./config.js";
import { SessionJournal } from "./journal.js";

const BLOCKRUN_API = "https://blockrun.ai/api";
const BLOCKRUN_SOLANA_API = "https://sol.blockrun.ai/api";
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
const MAX_MESSAGES = 200; // BlockRun API limit - truncate older messages if exceeded
const CONTEXT_LIMIT_KB = 5120; // Server-side limit: 5MB in KB
const HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000; // 3 minutes (allows for on-chain tx + LLM response)
const MAX_FALLBACK_ATTEMPTS = 5; // Maximum models to try in fallback chain (increased from 3 to ensure cheap models are tried)
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
 * HTTP status codes that indicate provider issues worth retrying with fallback.
 */
const FALLBACK_STATUS_CODES = [
  400, // Bad request - sometimes used for billing errors
  401, // Unauthorized - provider API key issues
  402, // Payment required - but from upstream, not x402
  403, // Forbidden - provider restrictions
  413, // Payload too large - request exceeds model's context limit
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
    map.set(m.id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
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

  // Rough estimate: ~4 chars per token for input
  const estimatedInputTokens = Math.ceil(bodyLength / 4);
  const estimatedOutputTokens = maxTokens || model.maxOutput || 4096;

  const costUsd =
    (estimatedInputTokens / 1_000_000) * model.inputPrice +
    (estimatedOutputTokens / 1_000_000) * model.outputPrice;

  // Convert to USDC 6-decimal integer, add 20% buffer for estimation error
  // Minimum 1000 ($0.001) to match CDP Facilitator's enforced minimum payment
  const amountMicros = Math.max(1000, Math.ceil(costUsd * 1.2 * 1_000_000));
  return amountMicros.toString();
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
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        safeWrite(res, Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  }

  res.end();

  const latencyMs = Date.now() - startTime;
  console.log(`[ClawRouter] Partner response: ${upstream.status} (${latencyMs}ms)`);

  // Log partner usage (fire-and-forget)
  logUsage({
    timestamp: new Date().toISOString(),
    model: "partner",
    tier: "PARTNER",
    cost: 0, // Actual cost handled by x402 settlement
    baselineCost: 0,
    savings: 0,
    latencyMs,
    partnerId:
      (req.url?.split("?")[0] ?? "").replace(/^\/v1\//, "").replace(/\//g, "_") || "unknown",
    service: "partner",
  }).catch(() => {});
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

  const resp = await fetch("https://catbox.moe/user/api.php", {
    method: "POST",
    body: form,
  });

  if (!resp.ok) throw new Error(`catbox.moe upload failed: HTTP ${resp.status}`);
  const result = await resp.text();
  if (result.startsWith("https://")) {
    return result.trim();
  }
  throw new Error(`catbox.moe upload failed: ${result}`);
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
      `[ClawRouter] Payment chain is Solana but no Solana keys provided. Using Base (EVM).`,
    );
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

    // Use chain-appropriate balance monitor
    const balanceMonitor: AnyBalanceMonitor =
      paymentChain === "solana" && reuseSolanaAddress
        ? new SolanaBalanceMonitor(reuseSolanaAddress)
        : new BalanceMonitor(account.address);

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
    console.log(`[ClawRouter] Solana x402 scheme registered: ${solanaAddress}`);
  }

  // Log which chain is used for each payment
  x402.onAfterPaymentCreation(async (context) => {
    const network = context.selectedRequirements.network;
    const chain = network.startsWith("eip155")
      ? "Base (EVM)"
      : network.startsWith("solana")
        ? "Solana"
        : network;
    console.log(`[ClawRouter] Payment signed on ${chain} (${network})`);
  });

  const payFetch = createPayFetchWithPreAuth(fetch, x402, undefined, {
    skipPreAuth: paymentChain === "solana",
  });

  // Create balance monitor for pre-request checks (chain-appropriate)
  const balanceMonitor: AnyBalanceMonitor =
    paymentChain === "solana" && solanaAddress
      ? new SolanaBalanceMonitor(solanaAddress)
      : new BalanceMonitor(account.address);

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
        paymentChain,
      };
      if (solanaAddress) {
        response.solana = solanaAddress;
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
      const models = buildProxyModelList();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models }));
      return;
    }

    // --- Handle partner API paths (/v1/x/*, /v1/partner/*) ---
    if (req.url?.match(/^\/v1\/(?:x|partner)\//)) {
      try {
        await proxyPartnerRequest(req, res, apiBase, payFetch);
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
    parsed.model = modelId;

    // Normalize message roles (e.g., "developer" -> "system")
    if (Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessageRoles(parsed.messages as ChatMessage[]);
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
      const errorBody = await response.text();
      const isProviderErr = isProviderError(response.status, errorBody);

      return {
        success: false,
        errorBody,
        errorStatus: response.status,
        isProviderError: isProviderErr,
      };
    }

    // Detect provider degradation hidden inside HTTP 200 responses.
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("json") || contentType.includes("text")) {
      try {
        const responseBody = await response.clone().text();
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
  let routingProfile: "free" | "eco" | "auto" | "premium" | null = null;
  let accumulatedContent = ""; // For session journal event extraction
  let responseInputTokens: number | undefined;
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
          ["free", "eco", "auto", "premium"].includes(profileName) ? profileName : "auto"
        ) as "free" | "eco" | "auto" | "premium";

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
              const activeTierConfigs = (() => {
                if (
                  routingDecision.reasoning?.includes("agentic") &&
                  routerOpts.config.agenticTiers
                ) {
                  return routerOpts.config.agenticTiers;
                }
                if (routingProfile === "eco" && routerOpts.config.ecoTiers) {
                  return routerOpts.config.ecoTiers;
                }
                if (routingProfile === "premium" && routerOpts.config.premiumTiers) {
                  return routerOpts.config.premiumTiers;
                }
                return routerOpts.config.tiers;
              })();

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

      // Rebuild body if modified
      if (bodyModified) {
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
  let balanceFallbackNotice: string | undefined;
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
          `[ClawRouter] Wallet ${sufficiency.info.isEmpty ? "empty" : "insufficient"} (${sufficiency.info.balanceUSD}), falling back to free model: ${FREE_MODEL} (requested: ${originalModel})`,
        );
        modelId = FREE_MODEL;
        // Update the body with new model
        const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
        parsed.model = FREE_MODEL;
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

      // Get tier configs matching the profile that was used for routing
      // Must stay in sync with what route() selected in router/index.ts
      const tierConfigs = (() => {
        if (routingDecision.reasoning?.includes("agentic") && routerOpts.config.agenticTiers) {
          return routerOpts.config.agenticTiers;
        }
        if (routingProfile === "eco" && routerOpts.config.ecoTiers) {
          return routerOpts.config.ecoTiers;
        }
        if (routingProfile === "premium" && routerOpts.config.premiumTiers) {
          return routerOpts.config.premiumTiers;
        }
        return routerOpts.config.tiers;
      })();

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

      // Filter to models that support tool calling when request has tools.
      // Prevents models like grok-code-fast-1 from outputting tool invocations
      // as plain text JSON (the "talking to itself" bug).
      let toolFiltered = filterByToolCalling(contextFiltered, hasTools, supportsToolCalling);
      const toolExcluded = contextFiltered.filter((m) => !toolFiltered.includes(m));
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

    // Always ensure free model is the last-resort fallback.
    // If all paid models fail (insufficient funds, rate limits, etc.),
    // the user still gets a response instead of an error.
    if (!modelsToTry.includes(FREE_MODEL)) {
      modelsToTry.push(FREE_MODEL);
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

        // Payment error (insufficient funds, simulation failure) — skip remaining
        // paid models, jump straight to free model. No point trying other paid
        // models with the same wallet state.
        const isPaymentErr = /payment.*verification.*failed|payment.*settlement.*failed|insufficient.*funds|transaction_simulation_failed/i.test(
          result.errorBody || "",
        );
        if (isPaymentErr && tryModel !== FREE_MODEL) {
          const freeIdx = modelsToTry.indexOf(FREE_MODEL);
          if (freeIdx > i + 1) {
            console.log(`[ClawRouter] Payment error — skipping to free model: ${FREE_MODEL}`);
            i = freeIdx - 1; // loop will increment to freeIdx
            continue;
          }
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

          // Extract input token count from upstream response
          if (rsp.usage && typeof rsp.usage === "object") {
            const u = rsp.usage as Record<string, unknown>;
            if (typeof u.prompt_tokens === "number") responseInputTokens = u.prompt_tokens;
          }

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

      // Collect full body for possible notice injection
      const bodyParts: Buffer[] = [];
      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bodyParts.push(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
      }

      let responseBody = Buffer.concat(bodyParts);

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
  // Note: Recalculate cost using full body length (not just system+user message)
  // and apply 20% buffer to match actual x402 payment (see estimateAmount())
  // Log ALL requests: both auto-routed (routingDecision set) and direct model picks
  const logModel = routingDecision?.model ?? modelId;
  if (logModel) {
    // Use full body length for accurate cost (matches x402 payment estimation)
    const estimatedInputTokens = Math.ceil(body.length / 4);
    const accurateCosts = calculateModelCost(
      logModel,
      routerOpts.modelPricing,
      estimatedInputTokens,
      maxTokens,
      routingProfile ?? undefined,
    );
    // Apply 20% buffer for cost estimation accuracy
    const costWithBuffer = accurateCosts.costEstimate * 1.2;
    const baselineWithBuffer = accurateCosts.baselineCost * 1.2;
    const entry: UsageEntry = {
      timestamp: new Date().toISOString(),
      model: logModel,
      tier: routingDecision?.tier ?? "DIRECT",
      cost: costWithBuffer,
      baselineCost: baselineWithBuffer,
      savings: accurateCosts.savings,
      latencyMs: Date.now() - startTime,
      ...(responseInputTokens !== undefined && { inputTokens: responseInputTokens }),
    };
    logUsage(entry).catch(() => {});
  }
}
