/**
 * LLM-Safe Context Compression Types
 *
 * Types for the 7-layer compression system that reduces token usage
 * while preserving semantic meaning for LLM queries.
 */

// Normalized message structure (matches OpenAI format)
export interface NormalizedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// Compression configuration
export interface CompressionConfig {
  enabled: boolean;
  preserveRaw: boolean; // Keep original for logging

  // Per-layer toggles
  layers: {
    deduplication: boolean;
    whitespace: boolean;
    dictionary: boolean;
    paths: boolean;
    jsonCompact: boolean;
    observation: boolean; // L6: Compress tool results (BIG WIN)
    dynamicCodebook: boolean; // L7: Build codebook from content
  };

  // Dictionary settings
  dictionary: {
    maxEntries: number;
    minPhraseLength: number;
    includeCodebookHeader: boolean; // Include codebook in system message
  };
}

// Compression statistics
export interface CompressionStats {
  duplicatesRemoved: number;
  whitespaceSavedChars: number;
  dictionarySubstitutions: number;
  pathsShortened: number;
  jsonCompactedChars: number;
  observationsCompressed: number; // L6: Tool results compressed
  observationCharsSaved: number; // L6: Chars saved from observations
  dynamicSubstitutions: number; // L7: Dynamic codebook substitutions
  dynamicCharsSaved: number; // L7: Chars saved from dynamic codebook
}

// Result from compression
export interface CompressionResult {
  messages: NormalizedMessage[];
  originalMessages: NormalizedMessage[]; // For logging

  // Token estimates
  originalChars: number;
  compressedChars: number;
  compressionRatio: number; // 0.85 = 15% reduction

  // Per-layer stats
  stats: CompressionStats;

  // Codebook used (for decompression in logs)
  codebook: Record<string, string>;
  pathMap: Record<string, string>;
  dynamicCodes: Record<string, string>; // L7: Dynamic codebook
}

// Log data extension for compression metrics
export interface CompressionLogData {
  enabled: boolean;
  ratio: number;
  original_chars: number;
  compressed_chars: number;
  stats: {
    duplicates_removed: number;
    whitespace_saved: number;
    dictionary_subs: number;
    paths_shortened: number;
    json_compacted: number;
  };
}

// Default configuration - CONSERVATIVE settings for model compatibility
// Only enable layers that don't require the model to decode anything
export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  enabled: true,
  preserveRaw: true,
  layers: {
    deduplication: true, // Safe: removes duplicate messages
    whitespace: true, // Safe: normalizes whitespace
    dictionary: false, // DISABLED: requires model to understand codebook
    paths: false, // DISABLED: requires model to understand path codes
    jsonCompact: true, // Safe: just removes JSON whitespace
    observation: false, // DISABLED: may lose important context
    dynamicCodebook: false, // DISABLED: requires model to understand codes
  },
  dictionary: {
    maxEntries: 50,
    minPhraseLength: 15,
    includeCodebookHeader: false, // No codebook header needed
  },
};
