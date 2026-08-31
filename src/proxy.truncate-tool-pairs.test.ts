import { describe, expect, it } from "vitest";

import { truncateMessages } from "./proxy.js";

/**
 * Regression tests for issue #252: truncateMessages() sliced the conversation
 * with a raw `slice(-N)`, which could separate an assistant `tool_calls` turn
 * from the `role: "tool"` results that answer it. Upstream providers reject
 * that shape (Anthropic: "tool_use block without matching tool_result";
 * OpenAI: "tool_calls referenced but tool response missing"), so a long
 * agentic session would start 400ing exactly when it crossed 200 messages.
 */

type Msg = {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

const MAX = 200;

function user(i: number): Msg {
  return { role: "user", content: `u${i}` };
}
function assistant(i: number): Msg {
  return { role: "assistant", content: `a${i}` };
}
function toolCall(ids: string[]): Msg {
  return {
    role: "assistant",
    content: null,
    tool_calls: ids.map((id) => ({
      id,
      type: "function",
      function: { name: "exec", arguments: "{}" },
    })),
  };
}
function toolResult(id: string): Msg {
  return { role: "tool", content: `result ${id}`, tool_call_id: id };
}

/** Pad the front of a conversation with plain user/assistant turns. */
function filler(n: number): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < n; i++) out.push(i % 2 === 0 ? user(i) : assistant(i));
  return out;
}

/** Every tool message in `messages` must be preceded (somewhere earlier) by an assistant turn carrying its id. */
function assertPairsIntact(messages: Msg[]): void {
  const seenCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) seenCallIds.add(tc.id);
    }
    if (m.role === "tool") {
      expect(seenCallIds.has(m.tool_call_id!), `orphan tool result ${m.tool_call_id}`).toBe(true);
    }
  }
}

describe("truncateMessages keeps tool_calls / tool result pairs together (#252)", () => {
  it("does not touch conversations at or under the limit", () => {
    const messages = [...filler(MAX - 2), toolCall(["c1"]), toolResult("c1")];
    expect(messages).toHaveLength(MAX);
    const r = truncateMessages(messages);
    expect(r.wasTruncated).toBe(false);
    expect(r.messages).toBe(messages);
  });

  it("never starts the kept window on an orphaned tool result", () => {
    // Layout: 50 filler, then [toolCall, toolResult], then enough filler that
    // a naive slice(-200) begins exactly at the toolResult.
    const head = filler(50);
    const pair = [toolCall(["c1"]), toolResult("c1")];
    const tailLen = MAX - 1; // keeps toolResult + 199 more → toolCall would be dropped
    const tail = filler(tailLen);
    const messages = [...head, ...pair, ...tail];

    const r = truncateMessages(messages);
    expect(r.wasTruncated).toBe(true);
    expect(r.messages[0].role).not.toBe("tool");
    assertPairsIntact(r.messages);
    expect(r.messages.length).toBeLessThanOrEqual(MAX);
  });

  it("drops the whole tool exchange when only part of it would survive", () => {
    // A parallel tool call with 3 results; the boundary lands on the 2nd result.
    const head = filler(40);
    const exchange = [
      toolCall(["p1", "p2", "p3"]),
      toolResult("p1"),
      toolResult("p2"),
      toolResult("p3"),
    ];
    const tail = filler(MAX - 2); // naive slice keeps p2, p3 + tail
    const messages = [...head, ...exchange, ...tail];

    const r = truncateMessages(messages);
    assertPairsIntact(r.messages);
    // The exchange straddled the boundary: either it's fully present or fully gone.
    const kept = r.messages.filter((m) => m.role === "tool" && m.tool_call_id?.startsWith("p"));
    expect([0, 3]).toContain(kept.length);
    expect(r.messages.length).toBeLessThanOrEqual(MAX);
  });

  it("keeps system messages and stays within the limit", () => {
    const system: Msg = { role: "system", content: "sys" };
    const messages = [system, ...filler(300), toolCall(["z"]), toolResult("z")];
    const r = truncateMessages(messages);
    expect(r.messages[0]).toBe(system);
    expect(r.messages.length).toBeLessThanOrEqual(MAX);
    assertPairsIntact(r.messages);
    // The trailing (most recent) exchange is always preserved.
    expect(r.messages.at(-1)?.tool_call_id).toBe("z");
  });

  it("handles a tool-result-heavy window without walking back past the limit", () => {
    // Every message after a short prefix is part of tool exchanges; whichever
    // boundary is chosen, output must stay ≤ MAX and pair-safe.
    const msgs: Msg[] = filler(10);
    for (let i = 0; msgs.length < 400; i++) {
      msgs.push(toolCall([`t${i}`]), toolResult(`t${i}`));
    }
    const r = truncateMessages(msgs);
    expect(r.messages.length).toBeLessThanOrEqual(MAX);
    assertPairsIntact(r.messages);
    expect(r.messages[0].role).not.toBe("tool");
  });
});
