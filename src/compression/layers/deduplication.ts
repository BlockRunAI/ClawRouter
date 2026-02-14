/**
 * Layer 1: Message Deduplication
 *
 * Removes exact duplicate messages from conversation history.
 * Common in heartbeat patterns and repeated tool calls.
 *
 * Safe for LLM: Identical messages add no new information.
 * Expected savings: 2-5%
 */

import { NormalizedMessage } from "../types";
import crypto from "crypto";

export interface DeduplicationResult {
  messages: NormalizedMessage[];
  duplicatesRemoved: number;
  originalCount: number;
}

/**
 * Generate a hash for a message based on its semantic content.
 * Uses role + content + tool_call_id to identify duplicates.
 */
function hashMessage(message: NormalizedMessage): string {
  const parts = [
    message.role,
    message.content || "",
    message.tool_call_id || "",
    message.name || "",
  ];

  // Include tool_calls if present
  if (message.tool_calls) {
    parts.push(
      JSON.stringify(
        message.tool_calls.map((tc) => ({
          name: tc.function.name,
          args: tc.function.arguments,
        })),
      ),
    );
  }

  const content = parts.join("|");
  return crypto.createHash("md5").update(content).digest("hex");
}

/**
 * Remove exact duplicate messages from the conversation.
 *
 * Strategy:
 * - Keep first occurrence of each unique message
 * - Preserve order for semantic coherence
 * - Never dedupe system messages (they set context)
 * - Allow duplicate user messages (user might repeat intentionally)
 * - CRITICAL: Never dedupe assistant messages with tool_calls that are
 *   referenced by subsequent tool messages (breaks Anthropic tool_use/tool_result pairing)
 */
export function deduplicateMessages(messages: NormalizedMessage[]): DeduplicationResult {
  const seen = new Set<string>();
  const result: NormalizedMessage[] = [];
  let duplicatesRemoved = 0;

  // First pass: collect all tool_call_ids that are referenced by tool messages
  // These tool_calls MUST be preserved to maintain tool_use/tool_result pairing
  const referencedToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id) {
      referencedToolCallIds.add(message.tool_call_id);
    }
  }

  for (const message of messages) {
    // Always keep system messages (they set important context)
    if (message.role === "system") {
      result.push(message);
      continue;
    }

    // Always keep user messages (user might repeat intentionally)
    if (message.role === "user") {
      result.push(message);
      continue;
    }

    // Always keep tool messages (they are results of tool calls)
    // Removing them would break the tool_use/tool_result pairing
    if (message.role === "tool") {
      result.push(message);
      continue;
    }

    // For assistant messages with tool_calls, check if any are referenced
    // by subsequent tool messages - if so, we MUST keep this message
    if (message.role === "assistant" && message.tool_calls) {
      const hasReferencedToolCall = message.tool_calls.some((tc) =>
        referencedToolCallIds.has(tc.id),
      );
      if (hasReferencedToolCall) {
        // This assistant message has tool_calls that are referenced - keep it
        result.push(message);
        continue;
      }
    }

    // For other assistant messages, check for duplicates
    const hash = hashMessage(message);

    if (!seen.has(hash)) {
      seen.add(hash);
      result.push(message);
    } else {
      duplicatesRemoved++;
    }
  }

  return {
    messages: result,
    duplicatesRemoved,
    originalCount: messages.length,
  };
}
