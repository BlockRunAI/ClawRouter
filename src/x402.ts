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

import { PaymentCache } from "./payment-cache.js";
import type { WalletSigner } from "./wallet-signer.js";
import { createPrivateKeyWalletSigner } from "./wallet-pk.js";

const BASE_CHAIN_ID = 8453;
const BASE_SEPOLIA_CHAIN_ID = 84532;
const DEFAULT_TOKEN_NAME = "USD Coin";
const DEFAULT_TOKEN_VERSION = "2";
const DEFAULT_NETWORK = "eip155:8453";
const DEFAULT_MAX_TIMEOUT_SECONDS = 300;

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
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as `0x${string}`;
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

function decodeBase64Json<T>(value: string): T {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padding);
  const decoded = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(decoded) as T;
}

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function parsePaymentRequired(headerValue: string): PaymentRequired {
  return decodeBase64Json<PaymentRequired>(headerValue);
}

function normalizeNetwork(network: string | undefined): string {
  if (!network || network.trim().length === 0) {
    return DEFAULT_NETWORK;
  }
  return network.trim().toLowerCase();
}

function resolveChainId(network: string): number {
  const eip155Match = network.match(/^eip155:(\d+)$/i);
  if (eip155Match) {
    const parsed = Number.parseInt(eip155Match[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  if (network === "base") return BASE_CHAIN_ID;
  if (network === "base-sepolia") return BASE_SEPOLIA_CHAIN_ID;
  return BASE_CHAIN_ID;
}

function parseHexAddress(value: string | undefined): `0x${string}` | undefined {
  if (!value) return undefined;

  const direct = value.match(/^0x[a-fA-F0-9]{40}$/);
  if (direct) {
    return direct[0] as `0x${string}`;
  }

  // Some providers send CAIP-style assets (e.g. ".../erc20:0x...").
  const caipSuffix = value.match(/0x[a-fA-F0-9]{40}$/);
  if (caipSuffix) {
    return caipSuffix[0] as `0x${string}`;
  }

  return undefined;
}

function requireHexAddress(value: string | undefined, field: string): `0x${string}` {
  const parsed = parseHexAddress(value);
  if (!parsed) {
    throw new Error(`Invalid ${field} in payment requirements: ${String(value)}`);
  }
  return parsed;
}

function setPaymentHeaders(headers: Headers, payload: string): void {
  // Support both modern and legacy header names for compatibility.
  headers.set("payment-signature", payload);
  headers.set("x-payment", payload);
}

async function createPaymentPayload(
  signer: WalletSigner,
  option: PaymentOption,
  amount: string,
  requestUrl: string,
  resource: PaymentRequired["resource"],
): Promise<string> {
  const network = normalizeNetwork(option.network);
  const chainId = resolveChainId(network);
  const recipient = requireHexAddress(option.payTo, "payTo");
  const verifyingContract = requireHexAddress(option.asset, "asset");

  const maxTimeoutSeconds =
    typeof option.maxTimeoutSeconds === "number" && option.maxTimeoutSeconds > 0
      ? Math.floor(option.maxTimeoutSeconds)
      : DEFAULT_MAX_TIMEOUT_SECONDS;

  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 600;
  const validBefore = now + maxTimeoutSeconds;
  const nonce = createNonce();

  const signature = await signer.signTypedData({
    domain: {
      name: option.extra?.name || DEFAULT_TOKEN_NAME,
      version: option.extra?.version || DEFAULT_TOKEN_VERSION,
      chainId,
      verifyingContract,
    },
    types: TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: signer.address as `0x${string}`,
      to: recipient,
      value: BigInt(amount),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  const paymentData = {
    x402Version: 2,
    resource: {
      url: resource?.url || requestUrl,
      description: resource?.description || "BlockRun AI API call",
      mimeType: "application/json",
    },
    accepted: {
      scheme: option.scheme,
      network,
      amount,
      asset: option.asset,
      payTo: option.payTo,
      maxTimeoutSeconds: option.maxTimeoutSeconds,
      extra: option.extra,
    },
    payload: {
      signature,
      authorization: {
        from: signer.address,
        to: recipient,
        value: amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
    extensions: {},
  };

  return encodeBase64Json(paymentData);
}

/** Pre-auth parameters for skipping the 402 round trip. */
export type PreAuthParams = {
  estimatedAmount: string; // USDC amount in smallest unit (6 decimals)
};

/** Result from createPaymentFetch — includes the fetch wrapper and payment cache. */
export type PaymentFetchResult = {
  fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
    preAuth?: PreAuthParams,
  ) => Promise<Response>;
  cache: PaymentCache;
};

/**
 * Create a fetch wrapper that handles x402 payment automatically.
 *
 * Accepts either:
 *   - A raw 0x private key string (existing behavior — backward compatible)
 *   - A WalletSigner instance (CDP MPC wallet or any custom signer)
 *
 * Supports pre-auth: if cached payment params + estimated amount are available,
 * pre-signs and attaches payment to the first request, skipping the 402 round trip.
 * Falls back to normal 402 flow if pre-signed payment is rejected.
 */
export function createPaymentFetch(signerOrKey: WalletSigner | `0x${string}`): PaymentFetchResult {
  // Accept raw private key for backward compat — wrap in PrivateKeyWalletSigner
  const signer: WalletSigner =
    typeof signerOrKey === "string"
      ? createPrivateKeyWalletSigner(signerOrKey)
      : signerOrKey;

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
        signer,
        {
          scheme: cached.scheme,
          network: cached.network,
          asset: cached.asset,
          payTo: cached.payTo,
          maxTimeoutSeconds: cached.maxTimeoutSeconds,
          extra: cached.extra,
        },
        preAuth.estimatedAmount,
        url,
        {
          url: cached.resourceUrl,
          description: cached.resourceDescription,
        },
      );

      const preAuthHeaders = new Headers(init?.headers);
      setPaymentHeaders(preAuthHeaders, paymentPayload);

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
      resourceUrl: paymentRequired.resource?.url,
      resourceDescription: paymentRequired.resource?.description,
    });

    // Create signed payment
    const paymentPayload = await createPaymentPayload(
        signer,
      option,
      amount,
      url,
      paymentRequired.resource,
    );

    // Retry with payment
    const retryHeaders = new Headers(init?.headers);
    setPaymentHeaders(retryHeaders, paymentPayload);

    return fetch(input, {
      ...init,
      headers: retryHeaders,
    });
  }

  return { fetch: payFetch, cache: paymentCache };
}
