/**
 * L6: Observation Compression (AGGRESSIVE)
 *
 * Inspired by claw-compactor's 97% compression on tool results.
 * Tool call results (especially large ones) are summarized to key info only.
 *
 * This is the biggest compression win - tool outputs can be 10KB+ but
 * only ~200 chars of actual useful information.
 */

import { NormalizedMessage } from "../types";

interface ObservationResult {
  messages: NormalizedMessage[];
  charsSaved: number;
  observationsCompressed: number;
}

// Max length for tool results before compression kicks in
const TOOL_RESULT_THRESHOLD = 500;

// Max length to compress tool results down to
const COMPRESSED_RESULT_MAX = 300;

/**
 * Extract key information from tool result.
 * Keeps: errors, key values, status, first/last important lines.
 */
function compressToolResult(content: string): string {
  if (!content || content.length <= TOOL_RESULT_THRESHOLD) {
    return content;
  }

  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Priority 1: Error messages (always keep)
  const errorLines = lines.filter(
    (l) => /error|exception|failed|denied|refused|timeout|invalid/i.test(l) && l.length < 200,
  );

  // Priority 2: Status/result lines
  const statusLines = lines.filter(
    (l) =>
      /success|complete|created|updated|found|result|status|total|count/i.test(l) && l.length < 150,
  );

  // Priority 3: Key JSON fields (extract important values)
  const jsonMatches: string[] = [];
  const jsonPattern = /"(id|name|status|error|message|count|total|url|path)":\s*"?([^",}\n]+)"?/gi;
  let match;
  while ((match = jsonPattern.exec(content)) !== null) {
    jsonMatches.push(`${match[1]}: ${match[2].slice(0, 50)}`);
  }

  // Priority 4: First and last meaningful lines
  const firstLine = lines[0]?.slice(0, 100);
  const lastLine = lines.length > 1 ? lines[lines.length - 1]?.slice(0, 100) : "";

  // Build compressed observation
  const parts: string[] = [];

  if (errorLines.length > 0) {
    parts.push("[ERR] " + errorLines.slice(0, 3).join(" | "));
  }

  if (statusLines.length > 0) {
    parts.push(statusLines.slice(0, 3).join(" | "));
  }

  if (jsonMatches.length > 0) {
    parts.push(jsonMatches.slice(0, 5).join(", "));
  }

  if (parts.length === 0) {
    // Fallback: keep first/last lines with truncation marker
    parts.push(firstLine || "");
    if (lines.length > 2) {
      parts.push(`[...${lines.length - 2} lines...]`);
    }
    if (lastLine && lastLine !== firstLine) {
      parts.push(lastLine);
    }
  }

  let result = parts.join("\n");

  // Final length cap
  if (result.length > COMPRESSED_RESULT_MAX) {
    result = result.slice(0, COMPRESSED_RESULT_MAX - 20) + "\n[...truncated]";
  }

  return result;
}

/**
 * Compress large repeated content blocks.
 * Detects when same large block appears multiple times.
 */
function deduplicateLargeBlocks(messages: NormalizedMessage[]): {
  messages: NormalizedMessage[];
  charsSaved: number;
} {
  const blockHashes = new Map<string, number>(); // hash -> first occurrence index
  let charsSaved = 0;

  const result = messages.map((msg, idx) => {
    if (!msg.content || msg.content.length < 500) {
      return msg;
    }

    // Hash first 200 chars as block identifier
    const blockKey = msg.content.slice(0, 200);

    if (blockHashes.has(blockKey)) {
      const firstIdx = blockHashes.get(blockKey)!;
      const original = msg.content;
      const compressed = `[See message #${firstIdx + 1} - same content]`;
      charsSaved += original.length - compressed.length;
      return { ...msg, content: compressed };
    }

    blockHashes.set(blockKey, idx);
    return msg;
  });

  return { messages: result, charsSaved };
}

/**
 * Compress tool results in messages.
 */
export function compressObservations(messages: NormalizedMessage[]): ObservationResult {
  let charsSaved = 0;
  let observationsCompressed = 0;

  // First pass: compress individual tool results
  let result = messages.map((msg) => {
    // Only compress tool role messages (these are tool call results)
    if (msg.role !== "tool" || !msg.content) {
      return msg;
    }

    const original = msg.content;
    if (original.length <= TOOL_RESULT_THRESHOLD) {
      return msg;
    }

    const compressed = compressToolResult(original);
    const saved = original.length - compressed.length;

    if (saved > 50) {
      charsSaved += saved;
      observationsCompressed++;
      return { ...msg, content: compressed };
    }

    return msg;
  });

  // Second pass: deduplicate large repeated blocks
  const dedupResult = deduplicateLargeBlocks(result);
  result = dedupResult.messages;
  charsSaved += dedupResult.charsSaved;

  return {
    messages: result,
    charsSaved,
    observationsCompressed,
  };
}
