/**
 * x402 Payment Implementation
 *
 * Based on BlockRun's proven implementation.
 * Handles 402 Payment Required responses with EIP-712 signed USDC transfers.
 *
 * Optimizations (v0.3.0):
 *   - Payment cache: after first 402, caches {payTo, asset, network} per endpoint.
 *     On subsequent requests, pre-signs payment and sends with first request,
 *     skipping the 402 round trip (~200ms savings).
 *   - Falls back to normal 402 flow if pre-signed payment is rejected.
 */

import { signTypedData, privateKeyToAccount } from "viem/accounts";
import { PaymentCache, type CachedPaymentParams } from "./payment-cache.js";

const BASE_CHAIN_ID = 8453;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const USDC_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: BASE_CHAIN_ID,
  verifyingContract: USDC_BASE,
} as const;

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function createNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
}

interface PaymentOption {
  scheme: string;
  network: string;
  amount?: string;
  maxAmountRequired?: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

interface PaymentRequired {
  accepts: PaymentOption[];
  resource?: { url?: string; description?: string };
}

function parsePaymentRequired(headerValue: string): PaymentRequired {
  const decoded = atob(headerValue);
  return JSON.parse(decoded) as PaymentRequired;
}

async function createPaymentPayload(
  privateKey: `0x${string}`,
  fromAddress: string,
  recipient: string,
  amount: string,
  resourceUrl: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 600;
  const validBefore = now + 300;
  const nonce = createNonce();

  const signature = await signTypedData({
    privateKey,
    domain: USDC_DOMAIN,
    types: TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: fromAddress as `0x${string}`,
      to: recipient as `0x${string}`,
      value: BigInt(amount),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  const paymentData = {
    x402Version: 2,
    resource: {
      url: resourceUrl,
      description: "BlockRun AI API call",
      mimeType: "application/json",
    },
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      amount,
      asset: USDC_BASE,
      payTo: recipient,
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    },
    payload: {
      signature,
      authorization: {
        from: fromAddress,
        to: recipient,
        value: amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
    extensions: {},
  };

  return btoa(JSON.stringify(paymentData));
}

/** Pre-auth parameters for skipping the 402 round trip. */
export type PreAuthParams = {
  estimatedAmount: string; // USDC amount in smallest unit (6 decimals)
};

/** Result from createPaymentFetch — includes the fetch wrapper and payment cache. */
export type PaymentFetchResult = {
  fetch: (input: RequestInfo | URL, init?: RequestInit, preAuth?: PreAuthParams) => Promise<Response>;
  cache: PaymentCache;
};

/**
 * Create a fetch wrapper that handles x402 payment automatically.
 *
 * Supports pre-auth: if cached payment params + estimated amount are available,
 * pre-signs and attaches payment to the first request, skipping the 402 round trip.
 * Falls back to normal 402 flow if pre-signed payment is rejected.
 */
export function createPaymentFetch(privateKey: `0x${string}`): PaymentFetchResult {
  const account = privateKeyToAccount(privateKey);
  const walletAddress = account.address;
  const paymentCache = new PaymentCache();

  const payFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
    preAuth?: PreAuthParams,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const endpointPath = new URL(url).pathname;

    // --- Pre-auth path: skip 402 round trip ---
    const cached = paymentCache.get(endpointPath);
    if (cached && preAuth?.estimatedAmount) {
      const paymentPayload = await createPaymentPayload(
        privateKey,
        walletAddress,
        cached.payTo,
        preAuth.estimatedAmount,
        url,
      );

      const preAuthHeaders = new Headers(init?.headers);
      preAuthHeaders.set("payment-signature", paymentPayload);

      const response = await fetch(input, { ...init, headers: preAuthHeaders });

      // Pre-auth accepted — skip 402 entirely
      if (response.status !== 402) {
        return response;
      }

      // Pre-auth rejected (wrong amount, payTo changed, etc.)
      // Try to use this 402's payment header for a proper retry
      const paymentHeader = response.headers.get("x-payment-required");
      if (paymentHeader) {
        return handle402(input, init, url, endpointPath, paymentHeader);
      }

      // No payment header — invalidate cache and retry clean (no payment header)
      // to get a proper 402 with payment requirements
      paymentCache.invalidate(endpointPath);
      const cleanResponse = await fetch(input, init);
      if (cleanResponse.status !== 402) {
        return cleanResponse;
      }
      const cleanHeader = cleanResponse.headers.get("x-payment-required");
      if (!cleanHeader) {
        throw new Error("402 response missing x-payment-required header");
      }
      return handle402(input, init, url, endpointPath, cleanHeader);
    }

    // --- Normal path: first request may get 402 ---
    const response = await fetch(input, init);

    if (response.status !== 402) {
      return response;
    }

    const paymentHeader = response.headers.get("x-payment-required");
    if (!paymentHeader) {
      throw new Error("402 response missing x-payment-required header");
    }

    return handle402(input, init, url, endpointPath, paymentHeader);
  };

  /** Handle a 402 response: parse, cache params, sign, retry. */
  async function handle402(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    url: string,
    endpointPath: string,
    paymentHeader: string,
  ): Promise<Response> {
    const paymentRequired = parsePaymentRequired(paymentHeader);
    const option = paymentRequired.accepts?.[0];
    if (!option) {
      throw new Error("No payment options in 402 response");
    }

    const amount = option.amount || option.maxAmountRequired;
    if (!amount) {
      throw new Error("No amount in payment requirements");
    }

    // Cache payment params for future pre-auth
    paymentCache.set(endpointPath, {
      payTo: option.payTo,
      asset: option.asset,
      scheme: option.scheme,
      network: option.network,
      extra: option.extra,
      maxTimeoutSeconds: option.maxTimeoutSeconds,
    });

    // Create signed payment
    const paymentPayload = await createPaymentPayload(
      privateKey,
      walletAddress,
      option.payTo,
      amount,
      url,
    );

    // Retry with payment
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set("payment-signature", paymentPayload);

    return fetch(input, {
      ...init,
      headers: retryHeaders,
    });
  }

  return { fetch: payFetch, cache: paymentCache };
}
