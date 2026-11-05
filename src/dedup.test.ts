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

  it("preserves timestamp-shaped prefixes in non-leading text blocks (user data, not injected)", () => {
    // OpenClaw only injects into the FIRST text block. A bracketed timestamp at the
    // start of a later text block is the user's own content (e.g. a pasted log line) —
    // stripping it would make two genuinely different requests collide on one key,
    // wrongly deduping a distinct paid request.
    const mk = (day: string) =>
      Buffer.from(
        JSON.stringify({
          model: "blockrun/auto",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "[Mon 2024-01-15 10:30 PST] explain this log line" },
                { type: "text", text: `[${day} 2024-01-16 09:15 UTC] connection refused` },
              ],
            },
          ],
        }),
      );

    expect(RequestDeduplicator.hash(mk("Tue"))).not.toBe(RequestDeduplicator.hash(mk("Wed")));
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

describe("RequestDeduplicator in-flight consumers", () => {
  it("keeps shared work alive until the final consumer releases its lease", () => {
    const dedup = new RequestDeduplicator();
    const controller = dedup.markInflight("shared");
    const releaseProducer = dedup.acquireInflightConsumer("shared")!;
    const releaseJoiner = dedup.acquireInflightConsumer("shared")!;

    releaseProducer();
    expect(controller.signal.aborted).toBe(false);
    expect(dedup.hasInflightConsumers("shared")).toBe(true);

    releaseJoiner();
    expect(controller.signal.aborted).toBe(true);
    expect(dedup.hasInflightConsumers("shared")).toBe(false);
  });

  it("does not abort a completed request when a lease is released later", () => {
    const dedup = new RequestDeduplicator();
    const controller = dedup.markInflight("shared");
    const release = dedup.acquireInflightConsumer("shared")!;
    dedup.complete("shared", {
      status: 200,
      headers: {},
      body: Buffer.from("done"),
      completedAt: Date.now(),
    });

    release();
    expect(controller.signal.aborted).toBe(false);
  });
});
