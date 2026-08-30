import { describe, it, expect, beforeEach, vi } from "vitest";
import { ResponseCache } from "./response-cache.js";

describe("ResponseCache", () => {
  let cache: ResponseCache;

  beforeEach(() => {
    cache = new ResponseCache();
  });

  describe("generateKey", () => {
    it("should generate consistent keys for identical requests", () => {
      const body1 = JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      });
      const body2 = JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      });

      expect(ResponseCache.generateKey(body1)).toBe(ResponseCache.generateKey(body2));
    });

    it("should generate different keys for different messages", () => {
      const body1 = JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      });
      const body2 = JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "goodbye" }],
      });

      expect(ResponseCache.generateKey(body1)).not.toBe(ResponseCache.generateKey(body2));
    });

    it("should generate different keys for different models", () => {
      const body1 = JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      });
      const body2 = JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: "hello" }],
      });

      expect(ResponseCache.generateKey(body1)).not.toBe(ResponseCache.generateKey(body2));
    });

    it("should differentiate stream parameter in cache key", () => {
      // Stream flag changes the response shape (SSE vs JSON), so it must be
      // part of the cache key — otherwise the first caller's response shape
      // gets served to the second caller.
      const body1 = JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });
      const body2 = JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });

      expect(ResponseCache.generateKey(body1)).not.toBe(ResponseCache.generateKey(body2));
    });

    it("should strip timestamps from messages", () => {
      const body1 = JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "[Mon 2024-01-15 10:30 PST] hello" }],
      });
      const body2 = JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      });

      expect(ResponseCache.generateKey(body1)).toBe(ResponseCache.generateKey(body2));
    });

    it("should strip timestamps from Anthropic-style array content blocks", () => {
      // Multimodal/vision messages use content: [{type: "text", text}, ...] instead
      // of a plain string. A retried request gets a fresh injected timestamp on the
      // leading text block each time — the key must still match or every retry of a
      // vision message misses the cache and gets billed as a brand-new request.
      const body1 = JSON.stringify({
        model: "gpt-4",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "[Mon 2024-01-15 10:30 PST] describe this" },
              { type: "image_url", image_url: { url: "https://example.com/a.png" } },
            ],
          },
        ],
      });
      const body2 = JSON.stringify({
        model: "gpt-4",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "[Mon 2024-01-15 10:31 PST] describe this" },
              { type: "image_url", image_url: { url: "https://example.com/a.png" } },
            ],
          },
        ],
      });

      expect(ResponseCache.generateKey(body1)).toBe(ResponseCache.generateKey(body2));
    });

    it("should preserve timestamp-shaped prefixes in non-leading text blocks", () => {
      // Only the first text block carries the injected timestamp; a bracketed
      // timestamp starting a later block is user data. Stripping it would give two
      // different requests the same cache key and serve the wrong cached response.
      const mk = (day: string) =>
        JSON.stringify({
          model: "gpt-4",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "[Mon 2024-01-15 10:30 PST] explain this log line" },
                { type: "text", text: `[${day} 2024-01-16 09:15 UTC] connection refused` },
              ],
            },
          ],
        });

      expect(ResponseCache.generateKey(mk("Tue"))).not.toBe(ResponseCache.generateKey(mk("Wed")));
    });

    it("should generate different keys when array content actually differs", () => {
      const mk = (text: string) =>
        JSON.stringify({
          model: "gpt-4",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: `[Mon 2024-01-15 10:30 PST] ${text}` }],
            },
          ],
        });

      expect(ResponseCache.generateKey(mk("describe image A"))).not.toBe(
        ResponseCache.generateKey(mk("describe image B")),
      );
    });

    it("should handle Buffer input", () => {
      const body = Buffer.from(
        JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: "hello" }],
        }),
      );

      expect(ResponseCache.generateKey(body)).toHaveLength(32);
    });
  });

  describe("shouldCache", () => {
    it("should return true by default", () => {
      const body = JSON.stringify({ model: "gpt-4", messages: [] });
      expect(cache.shouldCache(body)).toBe(true);
    });

    it("should return false when Cache-Control: no-cache header is present", () => {
      const body = JSON.stringify({ model: "gpt-4", messages: [] });
      expect(cache.shouldCache(body, { "cache-control": "no-cache" })).toBe(false);
    });

    it("should return true for other Cache-Control values", () => {
      const body = JSON.stringify({ model: "gpt-4", messages: [] });
      expect(cache.shouldCache(body, { "cache-control": "max-age=300" })).toBe(true);
    });

    it("should return false when cache=false in body", () => {
      const body = JSON.stringify({ model: "gpt-4", messages: [], cache: false });
      expect(cache.shouldCache(body)).toBe(false);
    });

    it("should return false when no_cache=true in body", () => {
      const body = JSON.stringify({ model: "gpt-4", messages: [], no_cache: true });
      expect(cache.shouldCache(body)).toBe(false);
    });

    it("should return false when cache is disabled", () => {
      const disabledCache = new ResponseCache({ enabled: false });
      const body = JSON.stringify({ model: "gpt-4", messages: [] });
      expect(disabledCache.shouldCache(body)).toBe(false);
    });
  });

  describe("get/set", () => {
    it("should return undefined for non-existent key", () => {
      expect(cache.get("nonexistent")).toBeUndefined();
    });

    it("should store and retrieve cached response", () => {
      const key = "test-key";
      const response = {
        body: Buffer.from('{"result": "ok"}'),
        status: 200,
        headers: { "content-type": "application/json" },
        model: "gpt-4",
      };

      cache.set(key, response);
      const cached = cache.get(key);

      expect(cached).toBeDefined();
      expect(cached!.body.toString()).toBe('{"result": "ok"}');
      expect(cached!.status).toBe(200);
      expect(cached!.model).toBe("gpt-4");
    });

    it("should not cache error responses (status >= 400)", () => {
      const key = "error-key";
      const response = {
        body: Buffer.from('{"error": "bad request"}'),
        status: 400,
        headers: {},
        model: "gpt-4",
      };

      cache.set(key, response);
      expect(cache.get(key)).toBeUndefined();
    });

    it("should not cache items exceeding maxItemSize", () => {
      const smallCache = new ResponseCache({ maxItemSize: 1 }); // 1KB max
      const key = "large-key";
      const response = {
        body: Buffer.alloc(2 * 1024), // 2KB
        status: 200,
        headers: {},
        model: "gpt-4",
      };

      smallCache.set(key, response);
      expect(smallCache.get(key)).toBeUndefined();
    });

    it("should track hits and misses", () => {
      const key = "stats-key";
      const response = {
        body: Buffer.from("test"),
        status: 200,
        headers: {},
        model: "gpt-4",
      };

      cache.get("missing"); // miss
      cache.set(key, response);
      cache.get(key); // hit
      cache.get(key); // hit

      const stats = cache.getStats();
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(2);
      expect(stats.hitRate).toBe("66.7%");
    });
  });

  describe("TTL expiration", () => {
    it("should expire entries after TTL", () => {
      vi.useFakeTimers();

      const key = "ttl-key";
      const response = {
        body: Buffer.from("test"),
        status: 200,
        headers: {},
        model: "gpt-4",
      };

      cache.set(key, response, 60); // 60 second TTL

      // Should exist before expiration
      expect(cache.get(key)).toBeDefined();

      // Advance time past TTL
      vi.advanceTimersByTime(61 * 1000);

      // Should be expired
      expect(cache.get(key)).toBeUndefined();

      vi.useRealTimers();
    });

    it("should use custom TTL when provided", () => {
      vi.useFakeTimers();

      const key = "custom-ttl";
      const response = {
        body: Buffer.from("test"),
        status: 200,
        headers: {},
        model: "gpt-4",
      };

      cache.set(key, response, 30); // 30 second TTL

      vi.advanceTimersByTime(25 * 1000);
      expect(cache.get(key)).toBeDefined();

      vi.advanceTimersByTime(10 * 1000); // Now 35 seconds total
      expect(cache.get(key)).toBeUndefined();

      vi.useRealTimers();
    });
  });

  describe("LRU eviction", () => {
    it("should evict oldest entries when at capacity", () => {
      const smallCache = new ResponseCache({ maxSize: 3, defaultTTL: 600 });

      for (let i = 0; i < 5; i++) {
        smallCache.set(`key-${i}`, {
          body: Buffer.from(`response-${i}`),
          status: 200,
          headers: {},
          model: "gpt-4",
        });
      }

      const stats = smallCache.getStats();
      expect(stats.size).toBeLessThanOrEqual(3);
      expect(stats.evictions).toBeGreaterThan(0);
    });
  });

  describe("clear", () => {
    it("should remove all entries", () => {
      cache.set("key-1", {
        body: Buffer.from("test"),
        status: 200,
        headers: {},
        model: "gpt-4",
      });
      cache.set("key-2", {
        body: Buffer.from("test"),
        status: 200,
        headers: {},
        model: "gpt-4",
      });

      expect(cache.getStats().size).toBe(2);

      cache.clear();

      expect(cache.getStats().size).toBe(0);
    });
  });

  describe("isEnabled", () => {
    it("should return true when enabled", () => {
      expect(cache.isEnabled()).toBe(true);
    });

    it("should return false when disabled", () => {
      const disabledCache = new ResponseCache({ enabled: false });
      expect(disabledCache.isEnabled()).toBe(false);
    });
  });
});
