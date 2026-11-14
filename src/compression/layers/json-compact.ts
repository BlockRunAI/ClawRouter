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
 * Minify a JSON string by removing whitespace outside string literals.
 * This preserves number representations losslessly, including integers
 * above Number.MAX_SAFE_INTEGER, arbitrary precision decimals, and exponents.
 */
function minifyJson(jsonString: string): string {
  return jsonString.replace(/("(?:\\(?:[\s\S])|[^"\\])*")|[ \t\n\r]+/g, (match, str) =>
    str !== undefined ? str : "",
  );
}

/**
 * Compact a JSON string by validating and stripping whitespace without re-serializing.
 */
export function compactJson(jsonString: string): string {
  try {
    JSON.parse(jsonString);
    return minifyJson(jsonString);
  } catch {
    // Not valid JSON, return as-is
    return jsonString;
  }
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
