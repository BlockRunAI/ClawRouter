import { describe, it, expect, beforeEach, vi } from "vitest";
import { ResponseCache } from "./response-cache.js";

describe("ResponseCache Edge Cases", () => {
  let cache: ResponseCache;

  beforeEach(() => {
    cache = new ResponseCache();
  });

  describe("generateKey edge cases", () => {
    it("should handle empty body", () => {
      expect(() => ResponseCache.generateKey("")).not.toThrow();
      expect(ResponseCache.generateKey("")).toHaveLength(32);
    });

    it("should handle invalid JSON", () => {
      expect(() => ResponseCache.generateKey("not json {{{")).not.toThrow();
      expect(ResponseCache.generateKey("not json {{{")).toHaveLength(32);
    });

    it("should handle empty object", () => {
      expect(ResponseCache.generateKey("{}")).toHaveLength(32);
    });

    it("should handle null values in messages", () => {
      const body = JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: null }],
      });
      expect(() => ResponseCache.generateKey(body)).not.toThrow();
    });

    it("should handle empty messages array", () => {
      const body = JSON.stringify({ model: "gpt-4", messages: [] });
      expect(ResponseCache.generateKey(body)).toHaveLength(32);
    });

    it("should handle missing model field", () => {
      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      expect(ResponseCache.generateKey(body)).toHaveLength(32);
    });

    it("should handle unicode characters", () => {
      const body = JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "你好世界 🚀 émoji" }],
      });
      expect(ResponseCache.generateKey(body)).toHaveLength(32);
    });

    it("should handle very long content", () => {
      const longContent = "a".repeat(100000);
      const body = JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: longContent }],
      });
      expect(ResponseCache.generateKey(body)).toHaveLength(32);
    });

    it("should handle nested objects in messages", () => {
      const body = JSON.stringify({
        model: "gpt-4",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "image_url", image_url: { url: "data:..." } },
            ],
          },
        ],
      });
      expect(ResponseCache.generateKey(body)).toHaveLength(32);
    });

    it("should handle special characters in content", () => {
      const body = JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: 'line1\nline2\ttab\\backslash"quote' }],
      });
      expect(ResponseCache.generateKey(body)).toHaveLength(32);
    });

    it("should produce same key regardless of field order", () => {
      const body1 = JSON.stringify({ model: "gpt-4", temperature: 0.7 });
      const body2 = JSON.stringify({ temperature: 0.7, model: "gpt-4" });
      expect(ResponseCache.generateKey(body1)).toBe(ResponseCache.generateKey(body2));
    });
  });

  describe("shouldCache edge cases", () => {
    it("should handle empty headers object", () => {
      const body = JSON.stringify({ model: "gpt-4" });
      expect(cache.shouldCache(body, {})).toBe(true);
    });

    it("should handle undefined headers", () => {
      const body = JSON.stringify({ model: "gpt-4" });
      expect(cache.shouldCache(body, undefined)).toBe(true);
    });

    it("should handle mixed case Cache-Control header", () => {
      const body = JSON.stringify({ model: "gpt-4" });
      // Directive names are case-insensitive (RFC 9111).
      expect(cache.shouldCache(body, { "cache-control": "NO-CACHE" })).toBe(false);
      expect(cache.shouldCache(body, { "cache-control": "no-cache, no-store" })).toBe(false);
    });

    it("should handle cache-control with extra spaces", () => {
      const body = JSON.stringify({ model: "gpt-4" });
      expect(cache.shouldCache(body, { "cache-control": "  no-cache  " })).toBe(false);
    });

    it("should handle invalid JSON in body gracefully", () => {
      expect(cache.shouldCache("not json")).toBe(true);
    });

    it("should handle Buffer body", () => {
      const body = Buffer.from(JSON.stringify({ model: "gpt-4" }));
      expect(cache.shouldCache(body)).toBe(true);
    });
  });

  describe("set/get edge cases", () => {
    it("should handle zero-byte response body", () => {
      cache.set("empty", {
        body: Buffer.from(""),
        status: 200,
        headers: {},
        model: "gpt-4",
      });
      const cached = cache.get("empty");
      expect(cached).toBeDefined();
      expect(cached!.body.length).toBe(0);
    });

    it("should handle binary response body", () => {
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
      cache.set("binary", {
        body: binaryData,
        status: 200,
        headers: {},
        model: "gpt-4",
      });
      const cached = cache.get("binary");
      expect(cached!.body).toEqual(binaryData);
    });

    it("should handle all 4xx status codes", () => {
      for (const status of [400, 401, 403, 404, 429, 499]) {
        cache.set(`error-${status}`, {
          body: Buffer.from("error"),
          status,
          headers: {},
          model: "gpt-4",
        });
        expect(cache.get(`error-${status}`)).toBeUndefined();
      }
    });

    it("should handle all 5xx status codes", () => {
      for (const status of [500, 502, 503, 504]) {
        cache.set(`error-${status}`, {
          body: Buffer.from("error"),
          status,
          headers: {},
          model: "gpt-4",
        });
        expect(cache.get(`error-${status}`)).toBeUndefined();
      }
    });

    it("should cache 2xx status codes", () => {
      for (const status of [200, 201, 204]) {
        cache.set(`ok-${status}`, {
          body: Buffer.from("ok"),
          status,
          headers: {},
          model: "gpt-4",
        });
        expect(cache.get(`ok-${status}`)).toBeDefined();
      }
    });

    it("should handle 3xx status codes (redirects)", () => {
      // 3xx are < 400, so they should be cached
      cache.set("redirect", {
        body: Buffer.from("redirect"),
        status: 302,
        headers: {},
        model: "gpt-4",
      });
      expect(cache.get("redirect")).toBeDefined();
    });

    it("should handle empty string key", () => {
      cache.set("", {
        body: Buffer.from("test"),
        status: 200,
        headers: {},
        model: "gpt-4",
      });
      expect(cache.get("")).toBeDefined();
    });

    it("should handle very long key", () => {
      const longKey = "k".repeat(10000);
      cache.set(longKey, {
        body: Buffer.from("test"),
        status: 200,
        headers: {},
        model: "gpt-4",
      });
      expect(cache.get(longKey)).toBeDefined();
    });

    it("should handle special characters in key", () => {
      const specialKey = "key/with:special?chars&more=stuff";
      cache.set(specialKey, {
        body: Buffer.from("test"),
        status: 200,
        headers: {},
        model: "gpt-4",
      });
      expect(cache.get(specialKey)).toBeDefined();
    });

    it("should overwrite existing key", () => {
      cache.set("key", {
        body: Buffer.from("first"),
        status: 200,
        headers: {},
        model: "gpt-4",
      });
      cache.set("key", {
        body: Buffer.from("second"),
        status: 200,
        headers: {},
        model: "gpt-4",
      });
      expect(cache.get("key")!.body.toString()).toBe("second");
    });

    it("should preserve headers with special values", () => {
      const headers = {
        "content-type": "application/json; charset=utf-8",
        "x-custom": "value with spaces",
        "x-empty": "",
      };
      cache.set("headers", {
        body: Buffer.from("test"),
        status: 200,
        headers,
        model: "gpt-4",
      });
      expect(cache.get("headers")!.headers).toEqual(headers);
    });
  });

  describe("TTL edge cases", () => {
    it("should handle zero TTL (immediate expiration)", () => {
      vi.useFakeTimers();

      cache.set(
        "zero-ttl",
        {
          body: Buffer.from("test"),
          status: 200,
          headers: {},
          model: "gpt-4",
        },
        0,
      );

      // With 0 TTL, should expire immediately on next tick
      vi.advanceTimersByTime(1);
      expect(cache.get("zero-ttl")).toBeUndefined();

      vi.useRealTimers();
    });

    it("should handle very large TTL", () => {
      vi.useFakeTimers();

      const oneYear = 365 * 24 * 60 * 60; // seconds
      cache.set(
        "long-ttl",
        {
          body: Buffer.from("test"),
          status: 200,
          headers: {},
          model: "gpt-4",
        },
        oneYear,
      );

      // Advance 364 days
      vi.advanceTimersByTime(364 * 24 * 60 * 60 * 1000);
      expect(cache.get("long-ttl")).toBeDefined();

      // Advance past 1 year
      vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000);
      expect(cache.get("long-ttl")).toBeUndefined();

      vi.useRealTimers();
    });

    it("should handle negative TTL as immediate expiration", () => {
      vi.useFakeTimers();

      cache.set(
        "negative-ttl",
        {
          body: Buffer.from("test"),
          status: 200,
          headers: {},
          model: "gpt-4",
        },
        -100,
      );

      // Negative TTL means already expired
      expect(cache.get("negative-ttl")).toBeUndefined();

      vi.useRealTimers();
    });

    it("should handle fractional TTL", () => {
      vi.useFakeTimers();

      cache.set(
        "fractional-ttl",
        {
          body: Buffer.from("test"),
          status: 200,
          headers: {},
          model: "gpt-4",
        },
        0.5, // 500ms
      );

      vi.advanceTimersByTime(400);
      expect(cache.get("fractional-ttl")).toBeDefined();

      vi.advanceTimersByTime(200);
      expect(cache.get("fractional-ttl")).toBeUndefined();

      vi.useRealTimers();
    });
  });

  describe("capacity edge cases", () => {
    it("should handle maxSize of 0", () => {
      const zeroCache = new ResponseCache({ maxSize: 0 });
      zeroCache.set("key", {
        body: Buffer.from("test"),
        status: 200,
        headers: {},
        model: "gpt-4",
      });
      // With maxSize 0, nothing should be cached
      expect(zeroCache.getStats().size).toBe(0);
    });

    it("should handle maxSize of 1", () => {
      const tinyCache = new ResponseCache({ maxSize: 1 });

      tinyCache.set("first", {
        body: Buffer.from("first"),
        status: 200,
        headers: {},
        model: "gpt-4",
      });
      tinyCache.set("second", {
        body: Buffer.from("second"),
        status: 200,
        headers: {},
        model: "gpt-4",
      });

      expect(tinyCache.getStats().size).toBe(1);
      expect(tinyCache.get("second")).toBeDefined();
    });

    it("should handle rapid sequential sets", () => {
      const smallCache = new ResponseCache({ maxSize: 10 });

      for (let i = 0; i < 100; i++) {
        smallCache.set(`key-${i}`, {
          body: Buffer.from(`response-${i}`),
          status: 200,
          headers: {},
          model: "gpt-4",
        });
      }

      expect(smallCache.getStats().size).toBeLessThanOrEqual(10);
      expect(smallCache.getStats().evictions).toBeGreaterThan(0);
    });

    it("should handle exact capacity boundary", () => {
      const cache5 = new ResponseCache({ maxSize: 5 });

      for (let i = 0; i < 5; i++) {
        cache5.set(`key-${i}`, {
          body: Buffer.from(`response-${i}`),
          status: 200,
          headers: {},
          model: "gpt-4",
        });
      }

      expect(cache5.getStats().size).toBe(5);
      expect(cache5.getStats().evictions).toBe(0);

      // Add one more to trigger eviction
      cache5.set("key-5", {
        body: Buffer.from("response-5"),
        status: 200,
        headers: {},
        model: "gpt-4",
      });

      expect(cache5.getStats().size).toBe(5);
      expect(cache5.getStats().evictions).toBeGreaterThan(0);
    });
  });

  describe("size limit edge cases", () => {
    it("should handle item exactly at maxItemSize", () => {
      // maxItemSize is in bytes
      const cache1kb = new ResponseCache({ maxItemSize: 1024 }); // 1024 bytes = 1KB
      const exactSize = Buffer.alloc(1024); // Exactly 1024 bytes

      cache1kb.set("exact", {
        body: exactSize,
        status: 200,
        headers: {},
        model: "gpt-4",
      });

      // Should be cached (at limit, not over)
      expect(cache1kb.get("exact")).toBeDefined();
    });

    it("should reject item just over maxItemSize", () => {
      // maxItemSize is in bytes
      const cache1kb = new ResponseCache({ maxItemSize: 1024 }); // 1024 bytes
      const overSize = Buffer.alloc(1025); // 1 byte over limit

      cache1kb.set("over", {
        body: overSize,
        status: 200,
        headers: {},
        model: "gpt-4",
      });

      expect(cache1kb.get("over")).toBeUndefined();
    });
  });

  describe("concurrent access patterns", () => {
    it("should handle interleaved get/set operations", () => {
      for (let i = 0; i < 50; i++) {
        cache.set(`key-${i % 10}`, {
          body: Buffer.from(`value-${i}`),
          status: 200,
          headers: {},
          model: "gpt-4",
        });

        const result = cache.get(`key-${(i + 5) % 10}`);
        // Result may or may not exist depending on order
        if (result) {
          expect(result.body).toBeDefined();
        }
      }

      // Should not crash and should have some entries
      expect(cache.getStats().size).toBeGreaterThan(0);
    });
  });

  describe("stats edge cases", () => {
    it("should handle stats with no operations", () => {
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.hitRate).toBe("0%");
    });

    it("should handle 100% miss rate", () => {
      cache.get("miss1");
      cache.get("miss2");
      cache.get("miss3");

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(3);
      expect(stats.hitRate).toBe("0.0%");
    });

    it("should handle 100% hit rate", () => {
      cache.set("key", {
        body: Buffer.from("test"),
        status: 200,
        headers: {},
        model: "gpt-4",
      });

      cache.get("key");
      cache.get("key");
      cache.get("key");

      const stats = cache.getStats();
      expect(stats.hits).toBe(3);
      expect(stats.misses).toBe(0);
      expect(stats.hitRate).toBe("100.0%");
    });
  });

  describe("clear edge cases", () => {
    it("should handle clear on empty cache", () => {
      expect(() => cache.clear()).not.toThrow();
      expect(cache.getStats().size).toBe(0);
    });

    it("should handle double clear", () => {
      cache.set("key", {
        body: Buffer.from("test"),
        status: 200,
        headers: {},
        model: "gpt-4",
      });

      cache.clear();
      cache.clear();

      expect(cache.getStats().size).toBe(0);
    });

    it("should allow new entries after clear", () => {
      cache.set("before", {
        body: Buffer.from("before"),
        status: 200,
        headers: {},
        model: "gpt-4",
      });

      cache.clear();

      cache.set("after", {
        body: Buffer.from("after"),
        status: 200,
        headers: {},
        model: "gpt-4",
      });

      expect(cache.get("before")).toBeUndefined();
      expect(cache.get("after")).toBeDefined();
    });
  });

  describe("config edge cases", () => {
    it("should handle all config options as undefined", () => {
      const defaultCache = new ResponseCache({
        maxSize: undefined,
        defaultTTL: undefined,
        maxItemSize: undefined,
        enabled: undefined,
      });

      // Should use defaults
      expect(defaultCache.isEnabled()).toBe(true);
    });

    it("should handle partial config", () => {
      const partialCache = new ResponseCache({ maxSize: 50 });
      partialCache.set("key", {
        body: Buffer.from("test"),
        status: 200,
        headers: {},
        model: "gpt-4",
      });
      expect(partialCache.get("key")).toBeDefined();
    });
  });
});
