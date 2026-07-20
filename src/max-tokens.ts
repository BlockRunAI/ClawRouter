/**
 * Output-token budget parsing, shared by the proxy and the payment pre-auth
 * layer.
 *
 * Lives in its own module because both `proxy.ts` and `payment-preauth.ts` need
 * it and `proxy.ts` already imports `payment-preauth.ts` — defining it in either
 * one would make the import cycle.
 */

/** Output-token budget assumed when the request declares none. */
export const DEFAULT_MAX_TOKENS = 4096;

/**
 * Read the requested output-token budget from a parsed chat body.
 *
 * OpenAI deprecated `max_tokens` in favour of `max_completion_tokens`; we accept
 * both because this number is not cosmetic. It feeds the routing decision,
 * `estimateAmount` (balance pre-check), the strict-mode `maxCostPerRun` cap,
 * `chargedOutputTokens` in `logUsage`, and the pre-auth reuse check that decides
 * whether a cached payment still covers the request. Reading only the legacy
 * field priced every request from a modern client at the default, which let a
 * large request walk through a cost cap and reuse a pre-auth sized for a small one.
 *
 * When both are present (OpenAI itself rejects that) we take the larger:
 * over-estimating only makes the pre-check stricter, under-estimating defeats it.
 *
 * @param fallback value to return when the body declares no usable budget.
 */
export function resolveMaxTokens(parsed: Record<string, unknown>, fallback = DEFAULT_MAX_TOKENS) {
  const usable = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;

  const candidates = [usable(parsed.max_tokens), usable(parsed.max_completion_tokens)].filter(
    (n): n is number => n !== undefined,
  );

  return candidates.length > 0 ? Math.max(...candidates) : fallback;
}
