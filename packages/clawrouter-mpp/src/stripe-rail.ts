/**
 * Stripe-shaped PayFetch. No Stripe SDK, no secret, and no PaymentIntent.
 *
 * The HTTP call is an injected stub. The default throws if a caller forgets the double,
 * so this module cannot reach Stripe by accident. Amount, currency, and payee are checked
 * before that stub runs. A refusal never calls it. A non-2xx after the check, or a caller
 * signal that the payment already happened, is a paid-no-completion and does not call it again.
 */
import {
  assertSpendPolicyAllows,
  SpendPolicyError,
  type QuotedRequirements,
  type SpendControl,
  type SpendRecord,
} from "@twzrd1111/clawrouter";
import type { PayFetch } from "./mpp-fetch.js";
import { boundedSnippet, MppPaidNoCompletionError, paymentReference } from "./mpp-paid-failure.js";

/** Quote checked before any HTTP. `amount` is canonical micro-USD when currency is usd. */
export type StripeQuote = {
  amount: string;
  currency: string;
  payee: string;
};

export type StripePayFetchOptions = {
  quote: StripeQuote;
  /** When set, the quote is checked against these limits before the stub runs. */
  spend?: SpendControl;
  /** Test double. The default throws and never performs a live Stripe request. */
  http?: typeof fetch;
};

const ALREADY_PAID = "x-stripe-payment-happened";
const CANONICAL_AMOUNT = /^\d+$/;

/** Header the caller sets to say this payment was already sent. Value is a reference. */
export const STRIPE_ALREADY_PAID_HEADER = ALREADY_PAID;

function defaultHttp(): Promise<Response> {
  throw new Error("stripe-rail: no HTTP stub; refusing a live Stripe call");
}

function headerValue(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const value = new Headers(headers).get(name)?.trim();
  return value ? value : undefined;
}

function alreadyPaidReference(input: RequestInfo | URL, init?: RequestInit): string | undefined {
  const fromInit = headerValue(init?.headers, ALREADY_PAID);
  if (fromInit) return safeReference(fromInit);
  if (typeof input !== "string" && !(input instanceof URL) && input instanceof Request) {
    const fromRequest = input.headers.get(ALREADY_PAID)?.trim();
    if (fromRequest) return safeReference(fromRequest);
  }
  return undefined;
}

function safeReference(raw: string): string {
  if (/^[A-Za-z0-9:_-]{1,80}$/.test(raw)) return raw;
  return paymentReference(raw);
}

function readQuote(quote: StripeQuote): { amount: string; currency: string; payee: string } {
  const amount = typeof quote.amount === "string" ? quote.amount.trim() : "";
  const currency = typeof quote.currency === "string" ? quote.currency.trim().toLowerCase() : "";
  const payee = typeof quote.payee === "string" ? quote.payee.trim() : "";
  if (!CANONICAL_AMOUNT.test(amount)) {
    throw new SpendPolicyError(
      `Stripe quote amount is missing or not a canonical decimal integer (${JSON.stringify(quote.amount)}); refusing before any charge`,
    );
  }
  if (!currency) {
    throw new SpendPolicyError("Stripe quote currency is missing; refusing before any charge");
  }
  if (!payee) {
    throw new SpendPolicyError("Stripe quote payee is missing; refusing before any charge");
  }
  return { amount, currency, payee };
}

function requirements(
  quote: { amount: string; currency: string; payee: string },
  spend: SpendControl | undefined,
): QuotedRequirements {
  const base = { payTo: quote.payee, network: "stripe", asset: quote.currency };
  if (quote.currency === "usd") return { ...base, amount: quote.amount };
  if (spend?.hasAmountLimits()) {
    throw new SpendPolicyError(
      `Stripe quote currency ${quote.currency} cannot be priced as USD; refusing to pay against a configured spend limit`,
    );
  }
  return base;
}

function paidNoCompletion(
  reference: string,
  status: number | undefined,
  detail: string,
): MppPaidNoCompletionError {
  const why = status !== undefined ? `HTTP ${status}` : "payment already happened";
  return new MppPaidNoCompletionError(
    `Stripe charge was sent but no completion came back (${why}${detail ? `: ${detail}` : ""}). ` +
      `Not retrying, to avoid paying twice. Payment reference: ${reference}`,
    reference,
    status,
  );
}

export function createStripePayFetch(opts: StripePayFetchOptions): PayFetch {
  const spend = opts.spend;
  const http = opts.http ?? defaultHttp;
  // One stub call per invocation. A paid failure is remembered so a repeat of this
  // fetch does not send the same charge again.
  let paidWithoutCompletion: string | undefined;
  const paidResponses = new WeakMap<Response, { reference: string; record?: SpendRecord }>();

  const payFetch: PayFetch = async (input, init) => {
    const signaled = alreadyPaidReference(input, init);
    if (signaled || paidWithoutCompletion) {
      throw paidNoCompletion(
        signaled ?? paidWithoutCompletion ?? "stripe-unknown",
        undefined,
        signaled
          ? "caller signaled payment already happened"
          : "an earlier charge did not complete",
      );
    }

    const quote = readQuote(opts.quote);
    let reservationId: string | undefined;
    if (spend) {
      reservationId = assertSpendPolicyAllows(spend, requirements(quote, spend));
    }

    let response: Response;
    try {
      response = await http(input, init);
    } catch (err) {
      if (spend && reservationId !== undefined) spend.releaseReservation(reservationId);
      throw err;
    }

    const reference = paymentReference(`stripe:${quote.currency}:${quote.amount}:${quote.payee}`);
    const record =
      spend && reservationId !== undefined
        ? spend.settleReservation(reservationId, { action: "stripe charge" })
        : undefined;
    if (response.status < 200 || response.status >= 300) {
      paidWithoutCompletion = reference;
      const detail = await boundedSnippet(response);
      if (spend && record) {
        spend.annotateRecord(
          record,
          `signed, no completion (HTTP ${response.status}) ref ${reference}`,
        );
      }
      throw paidNoCompletion(reference, response.status, detail);
    }
    paidResponses.set(response, { reference, record });
    return response;
  };

  payFetch.enforcesSpend = spend !== undefined;
  payFetch.isPaidResponse = (response) => paidResponses.has(response);
  payFetch.onNoCompletion = (response, reason) => {
    const paid = paidResponses.get(response);
    if (!paid) return;
    paidWithoutCompletion = paid.reference;
    if (spend && paid.record) {
      spend.annotateRecord(paid.record, `signed, no completion (${reason}) ref ${paid.reference}`);
    }
    throw paidNoCompletion(paid.reference, response.status, reason);
  };
  return payFetch;
}
