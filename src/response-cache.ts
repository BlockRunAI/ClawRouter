/**
 * Response Cache for LLM Completions
 *
 * Caches LLM responses by request hash (model + messages + params).
 * Inspired by LiteLLM's caching system. Returns cached responses for
 * identical requests, saving both cost and latency.
 *
 * Features:
 * - TTL-based expiration (default 10 minutes)
 * - LRU eviction when cache is full
 * - Size limits per item (1MB max)
 * - Heap-based expiration tracking for efficient pruning
 */

import { createHash } from "node:crypto";

export type CachedLLMResponse = {
  body: Buffer;
  status: number;
  headers: Record<string, string>;
  model: string;
  cachedAt: number;
  expiresAt: number;
};

export type ResponseCacheConfig = {
  /** Maximum number of cached responses. Default: 200 */
  maxSize?: number;
  /** Default TTL in seconds. Default: 600 (10 minutes) */
  defaultTTL?: number;
  /** Maximum size per cached item in bytes. Default: 1MB */
  maxItemSize?: number;
  /** Enable/disable cache. Default: true */
  enabled?: boolean;
};

const DEFAULT_CONFIG: Required<ResponseCacheConfig> = {
  maxSize: 200,
  defaultTTL: 600,
  maxItemSize: 1_048_576, // 1MB
  enabled: true,
};

/**
 * Canonicalize JSON by sorting object keys recursively.
 * Ensures identical logical content produces identical hash.
 */
function canonicalize(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalize);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalize((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Strip fields that shouldn't affect cache key:
 * - timestamps injected by OpenClaw
 * - request IDs
 *
 * `stream` IS part of the key because it changes the stored response shape
 * (JSON body vs SSE text/event-stream). A stream:true and stream:false request
 * with otherwise-identical bodies produce different responses and must live in
 * separate cache slots — otherwise the first one's response is served to the
 * second, which breaks the client.
 */
const TIMESTAMP_PATTERN = /^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/;

function normalizeForCache(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Skip fields that don't affect response content
    if (["user", "request_id", "x-request-id"].includes(key)) {
      continue;
    }

    if (key === "messages" && Array.isArray(value)) {
      // Strip timestamps from message content
      result[key] = value.map((msg: unknown) => {
        if (typeof msg === "object" && msg !== null) {
          const m = msg as Record<string, unknown>;
          if (typeof m.content === "string") {
            return { ...m, content: m.content.replace(TIMESTAMP_PATTERN, "") };
          }
          if (Array.isArray(m.content)) {
            // Anthropic-style content blocks — the timestamp lives in the leading
            // text block's `text` field. Without this, a retried multimodal message
            // (vision, image attachments) gets a fresh injected timestamp each time
            // and never hits the cache, so it's billed as a brand-new request.
            const newContent = m.content.map((block: unknown) => {
              if (
                block &&
                typeof block === "object" &&
                (block as { type?: unknown }).type === "text" &&
                typeof (block as { text?: unknown }).text === "string"
              ) {
                const b = block as { text: string };
                return { ...b, text: b.text.replace(TIMESTAMP_PATTERN, "") };
              }
              return block;
            });
            return { ...m, content: newContent };
          }
        }
        return msg;
      });
    } else {
      result[key] = value;
    }
  }

  return result;
}

export class ResponseCache {
  private cache = new Map<string, CachedLLMResponse>();
  private expirationHeap: Array<{ expiresAt: number; key: string }> = [];
  private config: Required<ResponseCacheConfig>;

  // Stats for monitoring
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
  };

  constructor(config: ResponseCacheConfig = {}) {
    // Filter out undefined values so they don't override defaults
    const filtered = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined),
    ) as ResponseCacheConfig;
    this.config = { ...DEFAULT_CONFIG, ...filtered };
  }

  /**
   * Generate cache key from request body.
   * Hashes: model + messages + temperature + max_tokens + other params
   */
  static generateKey(body: Buffer | string): string {
    try {
      const parsed = JSON.parse(typeof body === "string" ? body : body.toString());
      const normalized = normalizeForCache(parsed);
      const canonical = canonicalize(normalized);
      const keyContent = JSON.stringify(canonical);
      return createHash("sha256").update(keyContent).digest("hex").slice(0, 32);
    } catch {
      // Fallback: hash raw body
      const content = typeof body === "string" ? body : body.toString();
      return createHash("sha256").update(content).digest("hex").slice(0, 32);
    }
  }

  /**
   * Check if caching is enabled for this request.
   * Respects cache control headers and request params.
   */
  shouldCache(body: Buffer | string, headers?: Record<string, string>): boolean {
    if (!this.config.enabled) return false;

    // Respect Cache-Control: no-cache header
    if (headers?.["cache-control"]?.includes("no-cache")) {
      return false;
    }

    // Check for explicit cache disable in body
    try {
      const parsed = JSON.parse(typeof body === "string" ? body : body.toString());
      if (parsed.cache === false || parsed.no_cache === true) {
        return false;
      }
    } catch {
      // Not JSON, allow caching
    }

    return true;
  }

  /**
   * Get cached response if available and not expired.
   */
  get(key: string): CachedLLMResponse | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      return undefined;
    }

    this.stats.hits++;
    return entry;
  }

  /**
   * Cache a response with optional custom TTL.
   */
  set(
    key: string,
    response: {
      body: Buffer;
      status: number;
      headers: Record<string, string>;
      model: string;
    },
    ttlSeconds?: number,
  ): void {
    // Don't cache if disabled or maxSize is 0
    if (!this.config.enabled || this.config.maxSize <= 0) return;

    // Don't cache if item too large
    if (response.body.length > this.config.maxItemSize) {
      console.log(`[ResponseCache] Skipping cache - item too large: ${response.body.length} bytes`);
      return;
    }

    // Don't cache error responses
    if (response.status >= 400) {
      return;
    }

    // Evict if at capacity
    if (this.cache.size >= this.config.maxSize) {
      this.evict();
    }

    const now = Date.now();
    const ttl = ttlSeconds ?? this.config.defaultTTL;
    const expiresAt = now + ttl * 1000;

    const entry: CachedLLMResponse = {
      ...response,
      cachedAt: now,
      expiresAt,
    };

    this.cache.set(key, entry);
    this.expirationHeap.push({ expiresAt, key });
  }

  /**
   * Evict expired and oldest entries to make room.
   */
  private evict(): void {
    const now = Date.now();

    // First pass: remove expired entries
    this.expirationHeap.sort((a, b) => a.expiresAt - b.expiresAt);

    while (this.expirationHeap.length > 0) {
      const oldest = this.expirationHeap[0];

      // Check if entry still exists and matches
      const entry = this.cache.get(oldest.key);
      if (!entry || entry.expiresAt !== oldest.expiresAt) {
        // Stale heap entry, remove it
        this.expirationHeap.shift();
        continue;
      }

      if (oldest.expiresAt <= now) {
        // Expired, remove both
        this.cache.delete(oldest.key);
        this.expirationHeap.shift();
        this.stats.evictions++;
      } else {
        // Not expired, stop
        break;
      }
    }

    // Second pass: if still at capacity, evict oldest
    while (this.cache.size >= this.config.maxSize && this.expirationHeap.length > 0) {
      const oldest = this.expirationHeap.shift()!;
      if (this.cache.has(oldest.key)) {
        this.cache.delete(oldest.key);
        this.stats.evictions++;
      }
    }
  }

  /**
   * Get cache statistics.
   */
  getStats(): {
    size: number;
    maxSize: number;
    hits: number;
    misses: number;
    evictions: number;
    hitRate: string;
  } {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? ((this.stats.hits / total) * 100).toFixed(1) + "%" : "0%";

    return {
      size: this.cache.size,
      maxSize: this.config.maxSize,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      hitRate,
    };
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
    this.expirationHeap = [];
  }

  /**
   * Check if cache is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}
