/**
 * Layer 5: JSON Compaction
 *
 * Minifies JSON in tool_call arguments and tool results.
 * Removes pretty-print whitespace from JSON strings.
 *
 * Safe for LLM: JSON semantics unchanged.
 * Expected savings: 2-4%
 */

import { NormalizedMessage, ToolCall } from "../types.js";

export interface JsonCompactResult {
  messages: NormalizedMessage[];
  charsSaved: number;
}

/**
 * Compact a JSON string by removing whitespace between tokens.
 *
 * Tokens are copied as written. Re-stringifying a parsed value would change the
 * data: integers above 2^53 lose digits and 1e400 becomes null.
 */
function compactJson(jsonString: string): string {
  // A client body can hold null or a number here.
  if (typeof jsonString !== "string") return jsonString;
  try {
    JSON.parse(jsonString); // only touch valid JSON
  } catch {
    return jsonString;
  }

  let out = "";
  let start = 0;
  let inString = false;
  for (let i = 0; i < jsonString.length; i++) {
    const ch = jsonString[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      out += jsonString.slice(start, i);
      start = i + 1;
    }
  }
  return out + jsonString.slice(start);
}

/**
 * Check if a string looks like JSON (starts with { or [).
 */
function looksLikeJson(str: string): boolean {
  const trimmed = str.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

/**
 * Compact tool_call arguments in a message.
 */
function compactToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.map((tc) => ({
    ...tc,
    function: {
      ...tc.function,
      arguments: compactJson(tc.function.arguments),
    },
  }));
}

/**
 * Apply JSON compaction to all messages.
 *
 * Targets:
 * - tool_call arguments (in assistant messages)
 * - tool message content (often JSON)
 */
export function compactMessagesJson(messages: NormalizedMessage[]): JsonCompactResult {
  let charsSaved = 0;

  const result = messages.map((message) => {
    const newMessage = { ...message };

    // Compact tool_calls arguments
    if (message.tool_calls && message.tool_calls.length > 0) {
      const originalLength = JSON.stringify(message.tool_calls).length;
      newMessage.tool_calls = compactToolCalls(message.tool_calls);
      const newLength = JSON.stringify(newMessage.tool_calls).length;
      charsSaved += originalLength - newLength;
    }

    // Compact tool message content if it looks like JSON
    // Only process string content (skip arrays for multimodal messages)
    if (
      message.role === "tool" &&
      message.content &&
      typeof message.content === "string" &&
      looksLikeJson(message.content)
    ) {
      const originalLength = message.content.length;
      const compacted = compactJson(message.content);
      charsSaved += originalLength - compacted.length;
      newMessage.content = compacted;
    }

    return newMessage;
  });

  return {
    messages: result,
    charsSaved,
  };
}
