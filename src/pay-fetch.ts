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
};

/** `Error.name` that marks "signed and sent, no completion". Matched by name so a rail in another package works. */
export const PAYMENT_SETTLED_NO_COMPLETION = "PaymentSettledNoCompletionError";
