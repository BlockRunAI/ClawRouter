/**
 * Layer 2: Whitespace Normalization
 *
 * Reduces excessive whitespace without changing semantic meaning.
 *
 * Safe for LLM: Tokenizers normalize whitespace anyway.
 * Expected savings: 3-8%
 */

import { NormalizedMessage } from "../types";

export interface WhitespaceResult {
  messages: NormalizedMessage[];
  charsSaved: number;
}

/**
 * Normalize whitespace in a string.
 *
 * - Max 2 consecutive newlines
 * - Remove trailing whitespace from lines
 * - Normalize tabs to spaces
 * - Trim start/end
 */
export function normalizeWhitespace(content: string): string {
  if (!content) return content;

  return (
    content
      // Normalize line endings
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      // Max 2 consecutive newlines (preserve paragraph breaks)
      .replace(/\n{3,}/g, "\n\n")
      // Remove trailing whitespace from each line
      .replace(/[ \t]+$/gm, "")
      // Normalize multiple spaces to single (except at line start for indentation)
      .replace(/([^\n]) {2,}/g, "$1 ")
      // Reduce excessive indentation (more than 8 spaces → 2 spaces per level)
      .replace(/^[ ]{8,}/gm, (match) => "  ".repeat(Math.ceil(match.length / 4)))
      // Normalize tabs to 2 spaces
      .replace(/\t/g, "  ")
      // Trim
      .trim()
  );
}

/**
 * Apply whitespace normalization to all messages.
 */
export function normalizeMessagesWhitespace(messages: NormalizedMessage[]): WhitespaceResult {
  let charsSaved = 0;

  const result = messages.map((message) => {
    if (!message.content) return message;

    const originalLength = message.content.length;
    const normalizedContent = normalizeWhitespace(message.content);
    charsSaved += originalLength - normalizedContent.length;

    return {
      ...message,
      content: normalizedContent,
    };
  });

  return {
    messages: result,
    charsSaved,
  };
}
