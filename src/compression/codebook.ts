/**
 * Dictionary Codebook
 *
 * Static dictionary of frequently repeated phrases observed in LLM prompts.
 * Built from analysis of BlockRun production logs.
 *
 * Format: Short code ($XX) -> Long phrase
 * The LLM receives a codebook header and decodes in-context.
 */

// Static codebook - common patterns from system prompts
// Ordered by expected frequency and impact
export const STATIC_CODEBOOK: Record<string, string> = {
  // High-impact: OpenClaw/Agent system prompt patterns (very common)
  $OC01: "unbrowse_", // Common prefix in tool names
  $OC02: "<location>",
  $OC03: "</location>",
  $OC04: "<name>",
  $OC05: "</name>",
  $OC06: "<description>",
  $OC07: "</description>",
  $OC08: "(may need login)",
  $OC09: "API skill for OpenClaw",
  $OC10: "endpoints",

  // Skill/tool markers
  $SK01: "<available_skills>",
  $SK02: "</available_skills>",
  $SK03: "<skill>",
  $SK04: "</skill>",

  // Schema patterns (very common in tool definitions)
  $T01: 'type: "function"',
  $T02: '"type": "function"',
  $T03: '"type": "string"',
  $T04: '"type": "object"',
  $T05: '"type": "array"',
  $T06: '"type": "boolean"',
  $T07: '"type": "number"',

  // Common descriptions
  $D01: "description:",
  $D02: '"description":',

  // Common instructions
  $I01: "You are a personal assistant",
  $I02: "Tool names are case-sensitive",
  $I03: "Call tools exactly as listed",
  $I04: "Use when",
  $I05: "without asking",

  // Safety phrases
  $S01: "Do not manipulate or persuade",
  $S02: "Prioritize safety and human oversight",
  $S03: "unless explicitly requested",

  // JSON patterns
  $J01: '"required": ["',
  $J02: '"properties": {',
  $J03: '"additionalProperties": false',

  // Heartbeat patterns
  $H01: "HEARTBEAT_OK",
  $H02: "Read HEARTBEAT.md if it exists",

  // Role markers
  $R01: '"role": "system"',
  $R02: '"role": "user"',
  $R03: '"role": "assistant"',
  $R04: '"role": "tool"',

  // Common endings/phrases
  $E01: "would you like to",
  $E02: "Let me know if you",
  $E03: "internal APIs",
  $E04: "session cookies",

  // BlockRun model aliases (common in prompts)
  $M01: "blockrun/",
  $M02: "openai/",
  $M03: "anthropic/",
  $M04: "google/",
  $M05: "xai/",
};

/**
 * Get the inverse codebook for decompression.
 */
export function getInverseCodebook(): Record<string, string> {
  const inverse: Record<string, string> = {};
  for (const [code, phrase] of Object.entries(STATIC_CODEBOOK)) {
    inverse[phrase] = code;
  }
  return inverse;
}

/**
 * Generate the codebook header for inclusion in system message.
 * LLMs can decode in-context using this header.
 */
export function generateCodebookHeader(
  usedCodes: Set<string>,
  pathMap: Record<string, string> = {},
): string {
  if (usedCodes.size === 0 && Object.keys(pathMap).length === 0) {
    return "";
  }

  const parts: string[] = [];

  // Add used dictionary codes
  if (usedCodes.size > 0) {
    const codeEntries = Array.from(usedCodes)
      .map((code) => `${code}=${STATIC_CODEBOOK[code]}`)
      .join(", ");
    parts.push(`[Dict: ${codeEntries}]`);
  }

  // Add path map
  if (Object.keys(pathMap).length > 0) {
    const pathEntries = Object.entries(pathMap)
      .map(([code, path]) => `${code}=${path}`)
      .join(", ");
    parts.push(`[Paths: ${pathEntries}]`);
  }

  return parts.join("\n");
}

/**
 * Decompress a string using the codebook (for logging).
 */
export function decompressContent(
  content: string,
  codebook: Record<string, string> = STATIC_CODEBOOK,
): string {
  let result = content;
  for (const [code, phrase] of Object.entries(codebook)) {
    result = result.split(code).join(phrase);
  }
  return result;
}
