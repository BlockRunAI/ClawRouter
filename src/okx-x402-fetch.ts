/**
 * Custom payFetch for OKX onchainos mode.
 *
 * onchainos exposes payment signing as a single high-level command
 * (`payment x402-pay --accepts <json>`), not raw EIP-712 typed-data signing.
 * We therefore can't plug it into the @x402/fetch signer plumbing — instead
 * we hand-roll the 402 → sign → replay loop that the official x402 spec
 * describes, mirroring okxclawrouter's reference handler.
 *
 * Supports both x402 protocol versions:
 *   v2: `PAYMENT-REQUIRED` request header → `PAYMENT-SIGNATURE` reply header
 *   v1: JSON-body 402 → `X-PAYMENT` reply header
 *
 * Pre-auth caching is intentionally skipped in this mode — onchainos issues
 * fresh nonces/timestamps per call, so caching the previous payload would
 * produce duplicate authorizations the facilitator rejects.
 */

import type { OnchainOsAdapter } from "./onchainos-adapter.js";

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface PaymentRequirement {
  x402Version?: number;
  resource?: unknown;
  accepted?: unknown;
  accepts?: unknown[];
}

/**
 * Build a payFetch that signs x402 payments through onchainos.
 * Drop-in replacement for `createPayFetchWithPreAuth` when source=okx.
 */
export function createOnchainosPayFetch(baseFetch: FetchFn, onchainos: OnchainOsAdapter): FetchFn {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Snapshot the request so we can replay verbatim after a 402.
    // Cloning consumes the body once, so we materialize it up front.
    const original = new Request(input, init);
    const bodyBuf = await original.clone().arrayBuffer();
    const headersSnapshot = new Headers(original.headers);

    const firstResponse = await baseFetch(original);
    if (firstResponse.status !== 402) return firstResponse;

    // Parse 402 — v2 header takes precedence, then v1 body.
    const paymentRequiredHeader = firstResponse.headers.get("PAYMENT-REQUIRED");
    let requirement: PaymentRequirement;
    let isV2 = false;
    let accepts: unknown[];

    if (paymentRequiredHeader) {
      isV2 = true;
      requirement = JSON.parse(
        Buffer.from(paymentRequiredHeader, "base64").toString(),
      ) as PaymentRequirement;
      accepts = requirement.accepted ? [requirement.accepted] : (requirement.accepts ?? []);
    } else {
      const text = await firstResponse.text();
      try {
        requirement = JSON.parse(text) as PaymentRequirement;
      } catch {
        // 402 without a parseable body — surface a fresh 402 to the caller.
        return new Response(text, {
          status: 402,
          headers: firstResponse.headers,
        });
      }
      accepts = requirement.accepts ?? [];
    }

    if (accepts.length === 0) {
      throw new Error(
        `x402 402 response had no payment options to satisfy ` +
          `(onchainos cannot sign without an 'accepts' array)`,
      );
    }

    // Sign via onchainos.
    const payment = await onchainos.signX402Payment(accepts);

    // Build payment header.
    const accepted = (accepts[0] ?? {}) as Record<string, unknown>;
    const payload: Record<string, unknown> = {
      signature: payment.signature,
      authorization: payment.authorization,
    };

    let headerName: string;
    let headerValue: string;
    if (isV2) {
      const acceptedWithCert: Record<string, unknown> = { ...accepted };
      if (accepted.scheme === "aggr_deferred" && payment.sessionCert) {
        acceptedWithCert.extra = {
          ...((accepted.extra as Record<string, unknown> | undefined) ?? {}),
          sessionCert: payment.sessionCert,
        };
      }
      headerName = "PAYMENT-SIGNATURE";
      headerValue = Buffer.from(
        JSON.stringify({
          x402Version: requirement.x402Version ?? 2,
          resource: requirement.resource ?? { url: original.url },
          accepted: acceptedWithCert,
          payload,
        }),
      ).toString("base64");
    } else {
      headerName = "X-PAYMENT";
      headerValue = Buffer.from(
        JSON.stringify({
          x402Version: 1,
          scheme: accepted.scheme,
          network: accepted.network,
          payload,
        }),
      ).toString("base64");
    }

    // Replay request with payment header attached.
    const replayHeaders = new Headers(headersSnapshot);
    replayHeaders.set(headerName, headerValue);
    const replayInit: RequestInit = {
      method: original.method,
      headers: replayHeaders,
      body: original.method === "GET" || original.method === "HEAD" ? undefined : bodyBuf,
      redirect: original.redirect,
      credentials: original.credentials,
    };
    return baseFetch(original.url, replayInit);
  };
}
