import { describe, expect, it } from "vitest";

import { compressObservations } from "./observation.js";
import type { NormalizedMessage } from "../types.js";

describe("compressObservations large block deduplication", () => {
  it("keeps distinct messages that share only a leading 200 characters", () => {
    const sharedPrefix = "The quick brown fox jumps over the lazy dog. ".repeat(5);
    const firstContent = `${sharedPrefix}\nALPHA_UNIQUE ${"a".repeat(400)}`;
    const secondContent = `${sharedPrefix}\nBETA_UNIQUE ${"b".repeat(400)}`;
    const first: NormalizedMessage = { role: "assistant", content: firstContent };
    const second: NormalizedMessage = { role: "assistant", content: secondContent };

    expect(firstContent.slice(0, 200)).toBe(secondContent.slice(0, 200));

    const result = compressObservations([first, second]);

    expect(result.messages[1].content).toContain("BETA_UNIQUE");
    expect(result.messages[1].content).not.toContain("same content");
  });

  it("still drops a genuinely repeated large block", () => {
    const sharedPrefix = "The quick brown fox jumps over the lazy dog. ".repeat(5);
    const content = `${sharedPrefix}\nIDENTICAL ${"c".repeat(400)}`;
    const first: NormalizedMessage = { role: "assistant", content };
    const second: NormalizedMessage = { role: "assistant", content };

    const result = compressObservations([first, second]);

    expect(result.messages[1].content).toContain("same content");
  });
});
