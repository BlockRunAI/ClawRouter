/**
 * Payment Pre-Auth Cache
 *
 * Wraps the @x402/fetch SDK with pre-authorization caching.
 * After the first 402 response, caches payment requirements per endpoint.
 * On subsequent requests, pre-signs payment and attaches it to the first
 * request, skipping the 402 round trip (~200ms savings per request).
 *
 * IMPORTANT — pricing is per-request, not per-model. BlockRun prices each call
 * on (input tokens + max_tokens reservation), so two calls to the SAME model
 * can cost different amounts. A cached payment authorizes one EXACT amount, so
 * blindly reusing it for a larger request underpays — the gateway then rejects
 * it with a 402 that is NOT a fresh x402 challenge, and parsing that throws
 * "Failed to parse payment requirements". To stay correct we:
 *   1. only reuse a cached pre-auth when an up-front cost estimate proves the
 *      cached amount still covers this request (never knowingly underpay), and
 *   2. if a pre-auth is rejected anyway, discard it and re-request WITHOUT
 *      payment to obtain a fresh, canonical challenge — never treat the
 *      rejection response itself as the challenge.
 *
 * Falls back to the normal 402 flow whenever pre-auth can't be proven safe.
 */

import type { x402Client } from "@x402/fetch";
import { x402HTTPClient } from "@x402/fetch";

import { resolveMaxTokens } from "./max-tokens.js";
import { SpendPolicyError } from "./spend-control.js";

type PaymentRequired = Parameters<InstanceType<typeof x402Client>["createPaymentPayload"]>[0];

interface CachedEntry {
  paymentRequired: PaymentRequired;
  cachedAt: number;
  /** Estimated cost (USDC micro-units) of the request that established this
   *  entry. The cached payment is known to cover at least this much, so it is
   *  only reused when a new request's estimate is <= this value. `undefined`
   *  when the cost couldn't be estimated — in which case pre-auth is skipped. */
  coverMicros: number | undefined;
}

/** Up-front per-request cost estimator (USDC micro-units as a string), e.g.
 *  proxy.ts#estimateAmount. Returns undefined when the model/cost is unknown. */
type EstimateFn = (modelId: string, bodyLength: number, maxTokens: number) => string | undefined;

const DEFAULT_TTL_MS = 3_600_000; // 1 hour

/** Most a reused pre-auth may exceed this request's estimate by — the gateway's
 *  over-signed band (blockrun x402.ts PAYMENT_TOLERANCE). */
const PREAUTH_OVERPAY_TOLERANCE = 0.03;

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type PaymentNotification = { model: string; amount: string; network: string };

/** Structural slice of @blockrun/llm's SolanaBatchPayer that this layer drives. */
export interface BatchPayerLike {
  pay(
    paymentRequired: PaymentRequired,
    send: (headers: Record<string, string>) => Promise<Response>,
    rechallenge: () => Promise<
      | { kind: "challenge"; paymentRequired: PaymentRequired }
      | { kind: "served"; response: Response }
    >,
    closesAtStart?: number,
  ): Promise<
    | { kind: "paid"; response: Response; chargedUsd: number }
    | { kind: "fallback"; reason: string; paymentRequired?: PaymentRequired }
    | { kind: "served"; response: Response }
    | { kind: "failed"; error: unknown }
  >;
  closeFence(): Promise<number | undefined>;
}

/** How a batch `pay()` ended, for the caller's accounting. */
export type BatchOutcome =
  /** `chargedMicros` is undefined when no receipt states the charge: keep the ceiling. */
  | { kind: "paid"; chargedMicros: bigint | undefined }
  | { kind: "not_charged" }
  | { kind: "in_doubt" };

/**
 * A batch payment was sent and then the call failed in a way that proves
 * nothing (an abort, a transport error). It may have been charged, so the
 * request must not be paid again: no exact, no retry, no next model.
 */
export class PaymentInDoubtError extends Error {
  constructor(cause: unknown) {
    super(
      `batch-settlement payment sent, outcome unknown: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "PaymentInDoubtError";
  }
}

/**
 * Solana batch-settlement for chat completions. `begin` is called before the
 * payer signs anything and returns a marker; `settle` reports how that `pay()`
 * ended. Every signature it made was recorded by the signing hooks at its
 * per-call ceiling; `settle` lets the caller void the ones proven not charged
 * and book the charged one at what it actually cost.
 */
export interface SolanaBatchRoute {
  payer: BatchPayerLike;
  begin(): number | undefined;
  settle(mark: number | undefined, outcome: BatchOutcome): void;
}

/** Only non-streaming chat completions are paid in batch (they carry a receipt). */
function batchEligible(method: string, urlPath: string, bodyStr: string): boolean {
  if (method !== "POST" || !urlPath.endsWith("/v1/chat/completions") || !bodyStr) return false;
  try {
    return (JSON.parse(bodyStr) as { stream?: unknown }).stream !== true;
  } catch {
    return false;
  }
}

export function createPayFetchWithPreAuth(
  baseFetch: FetchFn,
  client: x402Client,
  ttlMs = DEFAULT_TTL_MS,
  options?: {
    skipPreAuth?: boolean;
    estimateAmount?: EstimateFn;
    onPayment?: (info: PaymentNotification) => void;
    /** The payment this call just signed was answered with a 402: declined,
     *  nothing settled. No amount is passed — a v1 payload does not carry the
     *  accepted quote — so the receiver reverses the signature it recorded. */
    onPaymentDeclined?: () => void;
    /** Opt-in Solana batch-settlement for chat completions (see {@link SolanaBatchRoute}). */
    solanaBatch?: SolanaBatchRoute;
  },
): FetchFn {
  const httpClient = new x402HTTPClient(client);
  const cache = new Map<string, CachedEntry>();

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const urlPath = new URL(request.url).pathname;

    // Extract model + size from the request body. Model gives a per-model cache
    // key (a cached sonnet payment must not be applied to a free model); body
    // length + max_tokens drive the up-front cost estimate used to decide
    // whether a cached pre-auth still covers this (possibly larger) request.
    let requestModel = "";
    let bodyLength = 0;
    let maxTokens = 0;
    let requestBody = "";
    if (init?.body) {
      try {
        const bodyStr =
          init.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : typeof init.body === "string"
              ? init.body
              : "";
        if (bodyStr) {
          requestBody = bodyStr;
          bodyLength = bodyStr.length;
          const parsed = JSON.parse(bodyStr) as Record<string, unknown>;
          requestModel = (parsed.model as string) ?? "";
          // Accept OpenAI's current `max_completion_tokens` as well as the
          // legacy `max_tokens` — reading only the latter sized a large request
          // as 0 tokens, letting it reuse a pre-auth bought for a tiny one.
          // Fallback stays 0 here (not the proxy's 4096): with no declared
          // budget this layer prices on body length alone, as it always has.
          maxTokens = resolveMaxTokens(parsed, 0);
        }
      } catch {
        /* not JSON, use empty model */
      }
    }
    const cacheKey = `${urlPath}:${requestModel}`;

    const notifyAcceptedPayment = (
      response: Response,
      payload: { accepted: { amount: string; network: string } },
    ): void => {
      const settled =
        response.headers.has("payment-response") || response.headers.has("x-payment-response");
      if (!settled || !options?.onPayment) return;
      try {
        options.onPayment({
          model: requestModel,
          amount: payload.accepted.amount,
          network: payload.accepted.network,
        });
      } catch (error) {
        // The observer runs after settlement. Its failure must not turn a paid
        // response into a retryable request and risk a second charge.
        console.error(
          `[ClawRouter] onPayment callback failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    // Up-front estimate of what THIS request will cost (USDC micro-units), used
    // both to gate pre-auth reuse and to record what a new cache entry covers.
    const estimateMicros = (): number | undefined => {
      if (!options?.estimateAmount || !requestModel) return undefined;
      const est = options.estimateAmount(requestModel, bodyLength, maxTokens);
      return est === undefined ? undefined : Number(est);
    };
    const needMicros = estimateMicros();

    const notifyDeclinedPayment = (): void => {
      if (!options?.onPaymentDeclined) return;
      try {
        options.onPaymentDeclined();
      } catch (error) {
        console.error(
          `[ClawRouter] onPaymentDeclined callback failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    // Try pre-auth only when we can PROVE the cached payment still covers this
    // request (needMicros <= what the cached entry covered) AND does not
    // overpay it by more than PREAUTH_OVERPAY_TOLERANCE. exact settles the
    // whole signed amount, so reusing a pre-auth bought for a bigger request
    // charged the user the bigger price; the gateway now refuses that with a
    // 402 (PAYMENT_OVERSIGNED), so reusing it would only cost a wasted round
    // trip. Skip for Solana: payments use per-tx blockhashes that expire
    // ~60-90s, making cached requirements useless and causing double charges.
    const cached = !options?.skipPreAuth ? cache.get(cacheKey) : undefined;
    const preAuthCovers =
      cached !== undefined &&
      Date.now() - cached.cachedAt < ttlMs &&
      cached.coverMicros !== undefined &&
      needMicros !== undefined &&
      needMicros <= cached.coverMicros &&
      cached.coverMicros <= needMicros * (1 + PREAUTH_OVERPAY_TOLERANCE);
    if (preAuthCovers) {
      // Whether a request carrying a SIGNED payment has left this process. Once
      // it has, a failure is ambiguous: "never arrived" and "arrived, settled,
      // response lost" look identical from here, and the fall-through path
      // below signs a second, distinct payment. That second authorization has a
      // fresh nonce, so replay protection passes it, and it happens inside one
      // payFetch call, so the proxy's response dedup never sees it — one user
      // request, two USDC charges (#317). Resolve the ambiguity the safe way:
      // fail the request rather than risk paying twice.
      let paymentInFlight = false;
      try {
        const payload = await client.createPaymentPayload(cached.paymentRequired);
        const headers = httpClient.encodePaymentSignatureHeader(payload);
        const preAuthRequest = request.clone();
        for (const [key, value] of Object.entries(headers)) {
          preAuthRequest.headers.set(key, value);
        }
        paymentInFlight = true;
        const response = await baseFetch(preAuthRequest);
        if (response.status !== 402) {
          notifyAcceptedPayment(response, payload);
          return response; // Pre-auth worked — saved ~200ms
        }
        // Rejected despite our estimate (server priced it higher than we did).
        // A 402 is an ANSWER: the gateway declined the payment, so nothing was
        // settled and re-signing is safe. The rejection 402 is NOT a reusable
        // challenge, so drop it and fall through to a clean, un-paid request
        // that yields a fresh challenge.
        paymentInFlight = false;
        notifyDeclinedPayment();
        cache.delete(cacheKey);
      } catch (err) {
        cache.delete(cacheKey);
        // A spend-policy refusal is deterministic: falling through would sign
        // the same blocked payment again on the fresh-challenge path, costing
        // an extra unpaid upstream round trip to reach the identical denial.
        if (err instanceof SpendPolicyError) {
          throw err;
        }
        // The send failed with a payment attached — see above. Surface the
        // transport error instead of quietly authorizing a second one. An
        // abort lands here too and must stay an abort, not a silent retry.
        if (paymentInFlight) {
          throw err;
        }
        // Pre-auth signing failed before anything was sent — unambiguous, so
        // invalidate and fall through to the normal 402 flow.
      }
    }

    // Normal flow: make a clean (un-paid) request and handle the 402 if needed.
    const batch =
      options?.solanaBatch && batchEligible(request.method, urlPath, requestBody)
        ? options.solanaBatch
        : undefined;
    // Taken before the first request: a channel close that completes while
    // this call waits for its 402 keeps it from opening a new channel.
    const closesAtStart = batch ? await batch.payer.closeFence() : undefined;
    const batchTemplate = batch ? request.clone() : undefined;
    const clonedRequest = request.clone();
    const response = await baseFetch(request);
    if (response.status !== 402) {
      return response;
    }

    // Parse 402 response and cache for future pre-auth
    let paymentRequired: PaymentRequired;
    try {
      const getHeader = (name: string) => response.headers.get(name);
      let body: unknown;
      try {
        const responseText = await Promise.race([
          response.text(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Body read timeout")), 30_000),
          ),
        ]);
        if (responseText) body = JSON.parse(responseText);
      } catch {
        /* empty body is fine */
      }
      paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, body);
      // Record what this cached payment covers (this request's estimate). It is
      // only reused later when a new request's estimate is <= this value.
      cache.set(cacheKey, { paymentRequired, cachedAt: Date.now(), coverMicros: needMicros });
    } catch (error) {
      throw new Error(
        `Failed to parse payment requirements: ${error instanceof Error ? error.message : "Unknown error"}`,
        { cause: error },
      );
    }

    if (batch && batchTemplate) {
      const outcome = await payInBatch(
        batch,
        batchTemplate,
        paymentRequired,
        closesAtStart,
        baseFetch,
        httpClient,
      );
      if (outcome.kind === "done") {
        if (outcome.charged && options?.onPayment) {
          try {
            options.onPayment({ model: requestModel, ...outcome.charged });
          } catch (error) {
            // Same rule as exact: the observer runs after settlement and must
            // not turn a paid response into a retryable failure.
            console.error(
              `[ClawRouter] onPayment callback failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return outcome.response;
      }
      // Proven not charged, or batch unavailable: pay exact, against the
      // freshest challenge the batch attempt saw.
      paymentRequired = outcome.paymentRequired;
    }

    // Sign payment and retry
    const payload = await client.createPaymentPayload(paymentRequired);
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(payload);
    for (const [key, value] of Object.entries(paymentHeaders)) {
      clonedRequest.headers.set(key, value);
    }
    const paidResponse = await baseFetch(clonedRequest);
    if (paidResponse.status === 402) notifyDeclinedPayment();
    notifyAcceptedPayment(paidResponse, payload);
    return paidResponse;
  };
}

/**
 * Pay one chat request in batch. Returns the response to hand back, or the
 * challenge to pay with `exact` when the payer fell back (nothing was charged).
 * A payment in doubt throws (the payer's BatchPaymentUnresolvedError) and is
 * never replaced by an exact payment.
 */
async function payInBatch(
  batch: SolanaBatchRoute,
  template: Request,
  paymentRequired: PaymentRequired,
  closesAtStart: number | undefined,
  fetchPaid: FetchFn,
  httpClient: x402HTTPClient,
): Promise<
  | { kind: "done"; response: Response; charged?: { amount: string; network: string } }
  | { kind: "exact"; paymentRequired: PaymentRequired }
> {
  // A fresh challenge that answered neither 402 nor 2xx: handed back as is.
  let unpaidAnswer: Response | undefined;
  const mark = batch.begin();
  let sent = false;
  let attempt: Awaited<ReturnType<BatchPayerLike["pay"]>>;
  try {
    attempt = await batch.payer.pay(
      paymentRequired,
      (headers) => {
        const paid = template.clone();
        for (const [key, value] of Object.entries(headers)) paid.headers.set(key, value);
        sent = true;
        return fetchPaid(paid);
      },
      async () => {
        const fresh = await fetchPaid(template.clone());
        if (fresh.status === 402) {
          const text = await fresh.text().catch(() => "");
          let body: unknown;
          try {
            body = text ? JSON.parse(text) : undefined;
          } catch {
            /* header-only challenge */
          }
          return {
            kind: "challenge",
            paymentRequired: httpClient.getPaymentRequiredResponse(
              (name) => fresh.headers.get(name),
              body,
            ),
          };
        }
        if (fresh.ok) return { kind: "served", response: fresh };
        unpaidAnswer = fresh;
        throw new Error(`fresh challenge answered HTTP ${fresh.status}`);
      },
      closesAtStart,
    );
  } catch (error) {
    if (!sent) {
      // Nothing left this process carrying a payment: an ordinary failure.
      batch.settle(mark, { kind: "not_charged" });
      throw error;
    }
    // A payment was sent: in doubt, never paid again. The payer's own
    // BatchPaymentUnresolvedError says so; anything else (an abort, a
    // transport error) is wrapped so the caller treats it the same way.
    batch.settle(mark, { kind: "in_doubt" });
    if (error instanceof Error && error.name === "BatchPaymentUnresolvedError") throw error;
    throw new PaymentInDoubtError(error);
  }
  if (attempt.kind === "paid") {
    // The charge is known only from a receipt that states it. A 200 without
    // one, or with one that is malformed or names no amount, makes the payer
    // report 0, which proves nothing: the ceiling then keeps counting.
    const chargedMicros = receiptChargedMicros(attempt.response);
    batch.settle(mark, { kind: "paid", chargedMicros });
    const accept = paymentRequired.accepts.find((a) => a.scheme === "batch-settlement");
    const charged =
      chargedMicros !== undefined
        ? { amount: chargedMicros.toString(), network: accept?.network ?? "solana" }
        : undefined;
    return { kind: "done", response: attempt.response, charged };
  }
  batch.settle(mark, { kind: "not_charged" });
  if (attempt.kind === "served") return { kind: "done", response: attempt.response };
  if (attempt.kind === "failed") {
    if (unpaidAnswer) return { kind: "done", response: unpaidAnswer };
    throw attempt.error;
  }
  return { kind: "exact", paymentRequired: attempt.paymentRequired ?? paymentRequired };
}

/**
 * The charge a batch receipt states, in micro-USDC, or undefined when no
 * receipt states one: `extra.chargedAmount` (where sol.blockrun.ai puts the
 * per-call charge), else the top-level `amount`. Only a canonical decimal
 * integer counts.
 */
function receiptChargedMicros(response: Response): bigint | undefined {
  const header =
    response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
  if (!header) return undefined;
  let receipt: { amount?: unknown; extra?: { chargedAmount?: unknown } | null } | undefined;
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as unknown;
    receipt = parsed && typeof parsed === "object" ? (parsed as typeof receipt) : undefined;
  } catch {
    return undefined;
  }
  for (const value of [receipt?.extra?.chargedAmount, receipt?.amount]) {
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  }
  return undefined;
}
