/**
 * OpenClaw-injected timestamp stripping, shared by the request deduplicator
 * and the response cache so their key normalization cannot drift apart.
 *
 * OpenClaw injects a fresh [DAY YYYY-MM-DD HH:MM TZ] prefix on every request:
 * for plain-string content it is prepended to the string, and for array-form
 * (multimodal) content it lands in the FIRST text block only. Later text
 * blocks never carry an injected stamp — a bracketed timestamp there is the
 * user's own data (e.g. a pasted log line) and must be preserved, otherwise
 * two genuinely different requests collide on the same key and the wrong
 * cached response is served (or a distinct paid request is wrongly deduped).
 */
export const TIMESTAMP_PATTERN = /^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/;

/**
 * Strip the injected timestamp prefix from the first text block of an
 * array-form content value. All other blocks are returned unchanged.
 */
export function stripLeadingTextBlockTimestamp(blocks: unknown[]): unknown[] {
  let stripped = false;
  return blocks.map((block) => {
    if (
      !stripped &&
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      stripped = true;
      const b = block as { text: string };
      return { ...b, text: b.text.replace(TIMESTAMP_PATTERN, "") };
    }
    return block;
  });
}
