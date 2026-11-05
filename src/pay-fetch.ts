/**
 * The upstream-fetch contract a payment rail implements.
 *
 * `startProxy({ payFetch })` replaces the built-in x402 / API-key rails with one of these, so a rail can
 * live outside this package. Two obligations come with it:
 *
 *  1. Spend limits. A rail that signs payments must check them before it signs and say so by setting
 *     `enforcesSpend = true`. The proxy refuses to start with a rail that leaves it unset while amount
 *     limits are configured. Build the check on `assertSpendPolicyAllows` / `SpendControl`
 *     (reserve, then `settleReservation` when signed, `releaseReservation` otherwise).
 *  2. Payment in doubt. If a payment was signed and the call then fails, throw an error whose `name` is
 *     `PaymentSettledNoCompletionError` (optionally with `reference` and `status`). The proxy answers 502
 *     `payment_settled_no_completion` and stops: no retry and no fallback model, since either would pay twice.
 */
export type PayFetch = ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) & {
  /** True when this fetch checks the configured spend limits before signing. */
  enforcesSpend?: boolean;
  /**
   * For `stream: true` callers, hold the final response headers until this fetch returns, so settlement
   * metadata such as `Payment-Receipt` can ride on the final HTTP 200. While waiting the proxy sends HTTP 102
   * (informational, commits nothing) instead of an early 200 plus SSE heartbeats, and errors keep their real
   * status. Unset keeps the early-SSE behavior. Independent of `enforcesSpend`.
   */
  deferStreamingHeaders?: boolean;
  /** Request native upstream SSE for streaming callers; JSON replies still work. */
  supportsNativeStreaming?: boolean;
  /** True when this exact successful Response was produced after a payment was signed. */
  isPaidResponse?: (response: Response) => boolean;
  /**
   * The host found a provider error hidden in a successful HTTP response, or a
   * paid response stream failed or ended without a completion. A rail that paid
   * for this response must throw PaymentSettledNoCompletionError here so the
   * host records the failure instead of paying a fallback model. The host must
   * pass the original Response object returned by this fetch.
   * Leave unsigned responses alone so ordinary provider fallback still works.
   */
  onNoCompletion?: (response: Response, reason: string) => void;
};

/** `Error.name` that marks "signed and sent, no completion". Matched by name so a rail in another package works. */
export const PAYMENT_SETTLED_NO_COMPLETION = "PaymentSettledNoCompletionError";
