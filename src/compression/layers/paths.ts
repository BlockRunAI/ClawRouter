/**
 * Layer 4: Path Shortening
 *
 * Detects common filesystem path prefixes and replaces them with short codes.
 * Common in coding assistant contexts with repeated file paths.
 *
 * Safe for LLM: Lossless abbreviation with path map header.
 * Expected savings: 1-3%
 */

import { NormalizedMessage } from "../types";

export interface PathShorteningResult {
  messages: NormalizedMessage[];
  pathMap: Record<string, string>; // $P1 -> /home/user/project/
  charsSaved: number;
}

// Regex to match filesystem paths
const PATH_REGEX = /(?:\/[\w.-]+){3,}/g;

/**
 * Extract all paths from messages and find common prefixes.
 */
function extractPaths(messages: NormalizedMessage[]): string[] {
  const paths: string[] = [];

  for (const message of messages) {
    // Only process string content (skip arrays for multimodal messages)
    if (!message.content || typeof message.content !== "string") continue;
    const matches = message.content.match(PATH_REGEX);
    if (matches) {
      paths.push(...matches);
    }
  }

  return paths;
}

/**
 * Group paths by their common prefixes.
 * Returns prefixes that appear at least 3 times.
 */
function findFrequentPrefixes(paths: string[]): string[] {
  const prefixCounts = new Map<string, number>();

  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);

    // Try prefixes of different lengths
    for (let i = 2; i < parts.length; i++) {
      const prefix = "/" + parts.slice(0, i).join("/") + "/";
      prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
    }
  }

  // Return prefixes that appear 3+ times, sorted by length (longest first)
  return Array.from(prefixCounts.entries())
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[0].length - a[0].length)
    .slice(0, 5) // Max 5 path codes
    .map(([prefix]) => prefix);
}

/**
 * Apply path shortening to all messages.
 */
export function shortenPaths(messages: NormalizedMessage[]): PathShorteningResult {
  const allPaths = extractPaths(messages);

  if (allPaths.length < 5) {
    // Not enough paths to benefit from shortening
    return {
      messages,
      pathMap: {},
      charsSaved: 0,
    };
  }

  const prefixes = findFrequentPrefixes(allPaths);

  if (prefixes.length === 0) {
    return {
      messages,
      pathMap: {},
      charsSaved: 0,
    };
  }

  // Create path map
  const pathMap: Record<string, string> = {};
  prefixes.forEach((prefix, i) => {
    pathMap[`$P${i + 1}`] = prefix;
  });

  // Replace paths in messages
  let charsSaved = 0;

  const result = messages.map((message) => {
    // Only process string content (skip arrays for multimodal messages)
    if (!message.content || typeof message.content !== "string") return message;

    let content = message.content;
    const originalLength = content.length;

    // Replace prefixes (longest first to avoid partial replacements)
    for (const [code, prefix] of Object.entries(pathMap)) {
      content = content.split(prefix).join(code + "/");
    }

    charsSaved += originalLength - content.length;

    return {
      ...message,
      content,
    };
  });

  return {
    messages: result,
    pathMap,
    charsSaved,
  };
}

/**
 * Generate the path map header for the codebook.
 */
export function generatePathMapHeader(pathMap: Record<string, string>): string {
  if (Object.keys(pathMap).length === 0) return "";

  const entries = Object.entries(pathMap)
    .map(([code, path]) => `${code}=${path}`)
    .join(", ");

  return `[Paths: ${entries}]`;
}
