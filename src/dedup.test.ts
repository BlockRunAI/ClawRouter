import { describe, it, expect } from "vitest";
import { RequestDeduplicator } from "./dedup.js";

describe("RequestDeduplicator.hash", () => {
  it("produces the same key for retries that only differ by injected timestamp (string content)", () => {
    const body1 = Buffer.from(
      JSON.stringify({
        model: "blockrun/auto",
        messages: [{ role: "user", content: "[Mon 2024-01-15 10:30 PST] hello" }],
      }),
    );
    const body2 = Buffer.from(
      JSON.stringify({
        model: "blockrun/auto",
        messages: [{ role: "user", content: "[Mon 2024-01-15 10:31 PST] hello" }],
      }),
    );

    expect(RequestDeduplicator.hash(body1)).toBe(RequestDeduplicator.hash(body2));
  });

  it("produces the same key for retries of Anthropic-style array content blocks", () => {
    // Vision/multimodal messages send content as [{type: "text", text}, {type: "image_url", ...}]
    // instead of a plain string. OpenClaw injects a fresh timestamp into the leading text
    // block on every retry — without stripping it there, a timed-out request that gets
    // retried never dedupes against the original and can be paid for twice.
    const body1 = Buffer.from(
      JSON.stringify({
        model: "blockrun/auto",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "[Mon 2024-01-15 10:30 PST] what's in this image?" },
              { type: "image_url", image_url: { url: "https://example.com/a.png" } },
            ],
          },
        ],
      }),
    );
    const body2 = Buffer.from(
      JSON.stringify({
        model: "blockrun/auto",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "[Mon 2024-01-15 10:31 PST] what's in this image?" },
              { type: "image_url", image_url: { url: "https://example.com/a.png" } },
            ],
          },
        ],
      }),
    );

    expect(RequestDeduplicator.hash(body1)).toBe(RequestDeduplicator.hash(body2));
  });

  it("still produces different keys when array content actually differs", () => {
    const body1 = Buffer.from(
      JSON.stringify({
        model: "blockrun/auto",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "[Mon 2024-01-15 10:30 PST] describe image A" }],
          },
        ],
      }),
    );
    const body2 = Buffer.from(
      JSON.stringify({
        model: "blockrun/auto",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "[Mon 2024-01-15 10:30 PST] describe image B" }],
          },
        ],
      }),
    );

    expect(RequestDeduplicator.hash(body1)).not.toBe(RequestDeduplicator.hash(body2));
  });
});
