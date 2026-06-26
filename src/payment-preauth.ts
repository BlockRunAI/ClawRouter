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

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createPayFetchWithPreAuth(
  baseFetch: FetchFn,
  client: x402Client,
  ttlMs = DEFAULT_TTL_MS,
  options?: { skipPreAuth?: boolean; estimateAmount?: EstimateFn },
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
    if (init?.body) {
      try {
        const bodyStr =
          init.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : typeof init.body === "string"
              ? init.body
              : "";
        if (bodyStr) {
          bodyLength = bodyStr.length;
          const parsed = JSON.parse(bodyStr) as { model?: string; max_tokens?: number };
          requestModel = parsed.model ?? "";
          maxTokens = Number(parsed.max_tokens) || 0;
        }
      } catch {
        /* not JSON, use empty model */
      }
    }
    const cacheKey = `${urlPath}:${requestModel}`;

    // Up-front estimate of what THIS request will cost (USDC micro-units), used
    // both to gate pre-auth reuse and to record what a new cache entry covers.
    const estimateMicros = (): number | undefined => {
      if (!options?.estimateAmount || !requestModel) return undefined;
      const est = options.estimateAmount(requestModel, bodyLength, maxTokens);
      return est === undefined ? undefined : Number(est);
    };
    const needMicros = estimateMicros();

    // Try pre-auth only when we can PROVE the cached payment still covers this
    // request (needMicros <= what the cached entry covered). Skip for Solana:
    // payments use per-tx blockhashes that expire ~60-90s, making cached
    // requirements useless and causing double charges.
    const cached = !options?.skipPreAuth ? cache.get(cacheKey) : undefined;
    const preAuthCovers =
      cached !== undefined &&
      Date.now() - cached.cachedAt < ttlMs &&
      cached.coverMicros !== undefined &&
      needMicros !== undefined &&
      needMicros <= cached.coverMicros;
    if (preAuthCovers) {
      try {
        const payload = await client.createPaymentPayload(cached.paymentRequired);
        const headers = httpClient.encodePaymentSignatureHeader(payload);
        const preAuthRequest = request.clone();
        for (const [key, value] of Object.entries(headers)) {
          preAuthRequest.headers.set(key, value);
        }
        const response = await baseFetch(preAuthRequest);
        if (response.status !== 402) {
          return response; // Pre-auth worked — saved ~200ms
        }
        // Rejected despite our estimate (server priced it higher than we did).
        // The rejection 402 is NOT a reusable challenge, so drop it and fall
        // through to a clean, un-paid request that yields a fresh challenge.
        cache.delete(cacheKey);
      } catch {
        // Pre-auth signing failed — invalidate and fall through.
        cache.delete(cacheKey);
      }
    }

    // Normal flow: make a clean (un-paid) request and handle the 402 if needed.
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

    // Sign payment and retry
    const payload = await client.createPaymentPayload(paymentRequired);
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(payload);
    for (const [key, value] of Object.entries(paymentHeaders)) {
      clonedRequest.headers.set(key, value);
    }
    return baseFetch(clonedRequest);
  };
}
