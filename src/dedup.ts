/**
 * Request Deduplication
 *
 * Prevents double-charging when OpenClaw retries a request after timeout.
 * Tracks in-flight requests and caches completed responses for a short TTL.
 */

import { createHash } from "node:crypto";

export type CachedResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  completedAt: number;
};

type InflightEntry = {
  resolve: (result: CachedResponse) => void;
  waiters: Promise<CachedResponse>[];
};

const DEFAULT_TTL_MS = 30_000; // 30 seconds
const MAX_BODY_SIZE = 1_048_576; // 1MB

export class RequestDeduplicator {
  private inflight = new Map<string, InflightEntry>();
  private completed = new Map<string, CachedResponse>();
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Hash request body to create a dedup key. */
  static hash(body: Buffer): string {
    return createHash("sha256").update(body).digest("hex").slice(0, 16);
  }

  /** Check if a response is cached for this key. */
  getCached(key: string): CachedResponse | undefined {
    const entry = this.completed.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.completedAt > this.ttlMs) {
      this.completed.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Check if a request with this key is currently in-flight. Returns a promise to wait on. */
  getInflight(key: string): Promise<CachedResponse> | undefined {
    const entry = this.inflight.get(key);
    if (!entry) return undefined;
    const promise = new Promise<CachedResponse>((resolve) => {
      // Will be resolved when the original request completes
      entry.waiters.push(
        new Promise<CachedResponse>((r) => {
          const orig = entry.resolve;
          entry.resolve = (result) => {
            orig(result);
            resolve(result);
            r(result);
          };
        }),
      );
    });
    return promise;
  }

  /** Mark a request as in-flight. */
  markInflight(key: string): void {
    this.inflight.set(key, {
      resolve: () => {},
      waiters: [],
    });
  }

  /** Complete an in-flight request — cache result and notify waiters. */
  complete(key: string, result: CachedResponse): void {
    // Only cache responses within size limit
    if (result.body.length <= MAX_BODY_SIZE) {
      this.completed.set(key, result);
    }

    const entry = this.inflight.get(key);
    if (entry) {
      entry.resolve(result);
      this.inflight.delete(key);
    }

    this.prune();
  }

  /** Remove an in-flight entry on error (don't cache failures). */
  removeInflight(key: string): void {
    this.inflight.delete(key);
  }

  /** Prune expired completed entries. */
  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.completed) {
      if (now - entry.completedAt > this.ttlMs) {
        this.completed.delete(key);
      }
    }
  }
}
