/**
 * LLM-Safe Context Compression
 *
 * Reduces token usage by 15-40% while preserving semantic meaning.
 * Implements 7 compression layers inspired by claw-compactor.
 *
 * Usage:
 *   const result = await compressContext(messages);
 *   // result.messages -> compressed version to send to provider
 *   // result.originalMessages -> original for logging
 */

import {
  NormalizedMessage,
  CompressionConfig,
  CompressionResult,
  CompressionStats,
  DEFAULT_COMPRESSION_CONFIG,
} from "./types";
import { deduplicateMessages } from "./layers/deduplication";
import { normalizeMessagesWhitespace } from "./layers/whitespace";
import { encodeMessages } from "./layers/dictionary";
import { shortenPaths, generatePathMapHeader } from "./layers/paths";
import { compactMessagesJson } from "./layers/json-compact";
import { compressObservations } from "./layers/observation";
import { applyDynamicCodebook, generateDynamicCodebookHeader } from "./layers/dynamic-codebook";
import { generateCodebookHeader, STATIC_CODEBOOK } from "./codebook";

export * from "./types";
export { STATIC_CODEBOOK } from "./codebook";

/**
 * Calculate total character count for messages.
 */
function calculateTotalChars(messages: NormalizedMessage[]): number {
  return messages.reduce((total, msg) => {
    let chars = msg.content?.length || 0;
    if (msg.tool_calls) {
      chars += JSON.stringify(msg.tool_calls).length;
    }
    return total + chars;
  }, 0);
}

/**
 * Deep clone messages to preserve originals.
 */
function cloneMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  return JSON.parse(JSON.stringify(messages));
}

/**
 * Prepend codebook header to the first USER message (not system).
 *
 * Why not system message?
 * - Google Gemini uses systemInstruction which doesn't support codebook format
 * - The codebook header in user message is still visible to all LLMs
 * - This ensures compatibility across all providers
 */
function prependCodebookHeader(
  messages: NormalizedMessage[],
  usedCodes: Set<string>,
  pathMap: Record<string, string>,
): NormalizedMessage[] {
  const header = generateCodebookHeader(usedCodes, pathMap);
  if (!header) return messages;

  // Find first user message (not system - Google's systemInstruction doesn't support codebook)
  const userIndex = messages.findIndex((m) => m.role === "user");

  if (userIndex === -1) {
    // No user message, add codebook as system (fallback)
    return [{ role: "system", content: header }, ...messages];
  }

  // Prepend to first user message
  return messages.map((msg, i) => {
    if (i === userIndex) {
      return {
        ...msg,
        content: `${header}\n\n${msg.content || ""}`,
      };
    }
    return msg;
  });
}

/**
 * Main compression function.
 *
 * Applies 5 layers in sequence:
 * 1. Deduplication - Remove exact duplicate messages
 * 2. Whitespace - Normalize excessive whitespace
 * 3. Dictionary - Replace common phrases with codes
 * 4. Paths - Shorten repeated file paths
 * 5. JSON - Compact JSON in tool calls
 *
 * Then prepends a codebook header for the LLM to decode in-context.
 */
export async function compressContext(
  messages: NormalizedMessage[],
  config: Partial<CompressionConfig> = {},
): Promise<CompressionResult> {
  const fullConfig: CompressionConfig = {
    ...DEFAULT_COMPRESSION_CONFIG,
    ...config,
    layers: {
      ...DEFAULT_COMPRESSION_CONFIG.layers,
      ...config.layers,
    },
    dictionary: {
      ...DEFAULT_COMPRESSION_CONFIG.dictionary,
      ...config.dictionary,
    },
  };

  // If compression disabled, return as-is
  if (!fullConfig.enabled) {
    const originalChars = calculateTotalChars(messages);
    return {
      messages,
      originalMessages: messages,
      originalChars,
      compressedChars: originalChars,
      compressionRatio: 1,
      stats: {
        duplicatesRemoved: 0,
        whitespaceSavedChars: 0,
        dictionarySubstitutions: 0,
        pathsShortened: 0,
        jsonCompactedChars: 0,
        observationsCompressed: 0,
        observationCharsSaved: 0,
        dynamicSubstitutions: 0,
        dynamicCharsSaved: 0,
      },
      codebook: {},
      pathMap: {},
      dynamicCodes: {},
    };
  }

  // Preserve originals for logging
  const originalMessages = fullConfig.preserveRaw ? cloneMessages(messages) : messages;
  const originalChars = calculateTotalChars(messages);

  // Initialize stats
  const stats: CompressionStats = {
    duplicatesRemoved: 0,
    whitespaceSavedChars: 0,
    dictionarySubstitutions: 0,
    pathsShortened: 0,
    jsonCompactedChars: 0,
    observationsCompressed: 0,
    observationCharsSaved: 0,
    dynamicSubstitutions: 0,
    dynamicCharsSaved: 0,
  };

  let result = cloneMessages(messages);
  let usedCodes = new Set<string>();
  let pathMap: Record<string, string> = {};
  let dynamicCodes: Record<string, string> = {};

  // Layer 1: Deduplication
  if (fullConfig.layers.deduplication) {
    const dedupResult = deduplicateMessages(result);
    result = dedupResult.messages;
    stats.duplicatesRemoved = dedupResult.duplicatesRemoved;
  }

  // Layer 2: Whitespace normalization
  if (fullConfig.layers.whitespace) {
    const wsResult = normalizeMessagesWhitespace(result);
    result = wsResult.messages;
    stats.whitespaceSavedChars = wsResult.charsSaved;
  }

  // Layer 3: Dictionary encoding
  if (fullConfig.layers.dictionary) {
    const dictResult = encodeMessages(result);
    result = dictResult.messages;
    stats.dictionarySubstitutions = dictResult.substitutionCount;
    usedCodes = dictResult.usedCodes;
  }

  // Layer 4: Path shortening
  if (fullConfig.layers.paths) {
    const pathResult = shortenPaths(result);
    result = pathResult.messages;
    pathMap = pathResult.pathMap;
    stats.pathsShortened = Object.keys(pathMap).length;
  }

  // Layer 5: JSON compaction
  if (fullConfig.layers.jsonCompact) {
    const jsonResult = compactMessagesJson(result);
    result = jsonResult.messages;
    stats.jsonCompactedChars = jsonResult.charsSaved;
  }

  // Layer 6: Observation compression (BIG WIN - 97% on tool results)
  if (fullConfig.layers.observation) {
    const obsResult = compressObservations(result);
    result = obsResult.messages;
    stats.observationsCompressed = obsResult.observationsCompressed;
    stats.observationCharsSaved = obsResult.charsSaved;
  }

  // Layer 7: Dynamic codebook (learns from actual content)
  if (fullConfig.layers.dynamicCodebook) {
    const dynResult = applyDynamicCodebook(result);
    result = dynResult.messages;
    stats.dynamicSubstitutions = dynResult.substitutions;
    stats.dynamicCharsSaved = dynResult.charsSaved;
    dynamicCodes = dynResult.dynamicCodes;
  }

  // Add codebook header if enabled and we have codes to include
  if (
    fullConfig.dictionary.includeCodebookHeader &&
    (usedCodes.size > 0 || Object.keys(pathMap).length > 0 || Object.keys(dynamicCodes).length > 0)
  ) {
    result = prependCodebookHeader(result, usedCodes, pathMap);
    // Also add dynamic codebook header if we have dynamic codes
    if (Object.keys(dynamicCodes).length > 0) {
      const dynHeader = generateDynamicCodebookHeader(dynamicCodes);
      if (dynHeader) {
        const systemIndex = result.findIndex((m) => m.role === "system");
        if (systemIndex >= 0) {
          result[systemIndex] = {
            ...result[systemIndex],
            content: `${dynHeader}\n${result[systemIndex].content || ""}`,
          };
        }
      }
    }
  }

  // Calculate final stats
  const compressedChars = calculateTotalChars(result);
  const compressionRatio = compressedChars / originalChars;

  // Build used codebook for logging
  const usedCodebook: Record<string, string> = {};
  usedCodes.forEach((code) => {
    usedCodebook[code] = STATIC_CODEBOOK[code];
  });

  return {
    messages: result,
    originalMessages,
    originalChars,
    compressedChars,
    compressionRatio,
    stats,
    codebook: usedCodebook,
    pathMap,
    dynamicCodes,
  };
}

/**
 * Quick check if compression would benefit these messages.
 * Returns true if messages are large enough to warrant compression.
 */
export function shouldCompress(messages: NormalizedMessage[]): boolean {
  const chars = calculateTotalChars(messages);
  // Only compress if > 5000 chars (roughly 1000 tokens)
  return chars > 5000;
}
