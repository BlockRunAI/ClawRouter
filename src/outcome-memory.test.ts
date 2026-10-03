import { describe, it, expect, beforeEach } from "vitest";
import {
  demoteUnreliable,
  isUnreliable,
  recordOutcome,
  resetOutcomeMemory,
} from "./outcome-memory.js";

describe("outcome memory", () => {
  beforeEach(() => resetOutcomeMemory());

  it("demotes a model after repeated failures on that request kind only", () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) recordOutcome("a", "tools", false, t + i);
    expect(isUnreliable("a", "tools", t + 10)).toBe(true);
    expect(isUnreliable("a", "chat", t + 10)).toBe(false);
    expect(demoteUnreliable(["a", "b", "c"], "tools", undefined, t + 10)).toEqual({
      chain: ["b", "c", "a"],
      demoted: ["a"],
    });
  });

  it("does not demote on a mostly-successful record or too few failures", () => {
    const t = 1_000_000;
    recordOutcome("a", "chat", false, t);
    recordOutcome("a", "chat", false, t + 1);
    expect(isUnreliable("a", "chat", t + 2)).toBe(false); // only 2 failures
    for (let i = 0; i < 5; i++) recordOutcome("a", "chat", true, t + 3 + i);
    recordOutcome("a", "chat", false, t + 9);
    expect(isUnreliable("a", "chat", t + 10)).toBe(false); // 3 of 8 < 50%
  });

  it("forgets failures after the TTL so a recovered model gets its place back", () => {
    const t = 1_000_000;
    for (let i = 0; i < 4; i++) recordOutcome("a", "tools", false, t + i);
    expect(isUnreliable("a", "tools", t + 31 * 60_000)).toBe(false);
  });

  it("never moves the pinned model and leaves an all-bad chain unchanged", () => {
    const t = 1_000_000;
    for (const m of ["a", "b"]) for (let i = 0; i < 3; i++) recordOutcome(m, "chat", false, t + i);
    expect(demoteUnreliable(["a", "c"], "chat", "a", t + 5).chain).toEqual(["a", "c"]);
    expect(demoteUnreliable(["a", "b"], "chat", undefined, t + 5)).toEqual({
      chain: ["a", "b"],
      demoted: [],
    });
  });
});
