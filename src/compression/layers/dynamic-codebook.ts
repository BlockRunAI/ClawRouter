/**
 * L7: Dynamic Codebook Builder
 *
 * Inspired by claw-compactor's frequency-based codebook.
 * Builds codebook from actual content being compressed,
 * rather than relying on static patterns.
 *
 * Finds phrases that appear 3+ times and replaces with short codes.
 */

import { NormalizedMessage } from "../types";

interface DynamicCodebookResult {
  messages: NormalizedMessage[];
  charsSaved: number;
  dynamicCodes: Record<string, string>; // code -> phrase
  substitutions: number;
}

// Config
const MIN_PHRASE_LENGTH = 20;
const MAX_PHRASE_LENGTH = 200;
const MIN_FREQUENCY = 3;
const MAX_ENTRIES = 100;
const CODE_PREFIX = "$D"; // Dynamic codes: $D01, $D02, etc.

/**
 * Find repeated phrases in content.
 */
function findRepeatedPhrases(allContent: string): Map<string, number> {
  const phrases = new Map<string, number>();

  // Split by sentence-like boundaries
  const segments = allContent.split(/(?<=[.!?\n])\s+/);

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.length >= MIN_PHRASE_LENGTH && trimmed.length <= MAX_PHRASE_LENGTH) {
      phrases.set(trimmed, (phrases.get(trimmed) || 0) + 1);
    }
  }

  // Also find repeated lines
  const lines = allContent.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= MIN_PHRASE_LENGTH && trimmed.length <= MAX_PHRASE_LENGTH) {
      phrases.set(trimmed, (phrases.get(trimmed) || 0) + 1);
    }
  }

  return phrases;
}

/**
 * Build dynamic codebook from message content.
 */
function buildDynamicCodebook(messages: NormalizedMessage[]): Record<string, string> {
  // Combine all content
  let allContent = "";
  for (const msg of messages) {
    // Only process string content (skip arrays for multimodal messages)
    if (msg.content && typeof msg.content === "string") {
      allContent += msg.content + "\n";
    }
  }

  // Find repeated phrases
  const phrases = findRepeatedPhrases(allContent);

  // Filter by frequency and sort by savings potential
  const candidates: Array<{ phrase: string; count: number; savings: number }> = [];
  for (const [phrase, count] of phrases.entries()) {
    if (count >= MIN_FREQUENCY) {
      // Savings = (phrase length - code length) * occurrences
      const codeLength = 4; // e.g., "$D01"
      const savings = (phrase.length - codeLength) * count;
      if (savings > 50) {
        candidates.push({ phrase, count, savings });
      }
    }
  }

  // Sort by savings (descending) and take top entries
  candidates.sort((a, b) => b.savings - a.savings);
  const topCandidates = candidates.slice(0, MAX_ENTRIES);

  // Build codebook
  const codebook: Record<string, string> = {};
  topCandidates.forEach((c, i) => {
    const code = `${CODE_PREFIX}${String(i + 1).padStart(2, "0")}`;
    codebook[code] = c.phrase;
  });

  return codebook;
}

/**
 * Escape special regex characters.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply dynamic codebook to messages.
 */
export function applyDynamicCodebook(messages: NormalizedMessage[]): DynamicCodebookResult {
  // Build codebook from content
  const codebook = buildDynamicCodebook(messages);

  if (Object.keys(codebook).length === 0) {
    return {
      messages,
      charsSaved: 0,
      dynamicCodes: {},
      substitutions: 0,
    };
  }

  // Create inverse map for replacement
  const phraseToCode: Record<string, string> = {};
  for (const [code, phrase] of Object.entries(codebook)) {
    phraseToCode[phrase] = code;
  }

  // Sort phrases by length (longest first) to avoid partial replacements
  const sortedPhrases = Object.keys(phraseToCode).sort((a, b) => b.length - a.length);

  let charsSaved = 0;
  let substitutions = 0;

  // Apply replacements
  const result = messages.map((msg) => {
    // Only process string content (skip arrays for multimodal messages)
    if (!msg.content || typeof msg.content !== "string") return msg;

    let content = msg.content;
    for (const phrase of sortedPhrases) {
      const code = phraseToCode[phrase];
      const regex = new RegExp(escapeRegex(phrase), "g");
      const matches = content.match(regex);
      if (matches) {
        content = content.replace(regex, code);
        charsSaved += (phrase.length - code.length) * matches.length;
        substitutions += matches.length;
      }
    }

    return { ...msg, content };
  });

  return {
    messages: result,
    charsSaved,
    dynamicCodes: codebook,
    substitutions,
  };
}

/**
 * Generate header for dynamic codes (to include in system message).
 */
export function generateDynamicCodebookHeader(codebook: Record<string, string>): string {
  if (Object.keys(codebook).length === 0) return "";

  const entries = Object.entries(codebook)
    .slice(0, 20) // Limit header size
    .map(([code, phrase]) => {
      // Truncate long phrases in header
      const displayPhrase = phrase.length > 40 ? phrase.slice(0, 37) + "..." : phrase;
      return `${code}=${displayPhrase}`;
    })
    .join(", ");

  return `[DynDict: ${entries}]`;
}
