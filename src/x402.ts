/**
 * x402 Payment Implementation
 *
 * Based on BlockRun's proven implementation.
 * Handles 402 Payment Required responses with EIP-712 signed USDC transfers.
 */

import { signTypedData, privateKeyToAccount } from "viem/accounts";

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

/**
 * Create a fetch wrapper that handles x402 payment automatically.
 */
export function createPaymentFetch(privateKey: `0x${string}`): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const account = privateKeyToAccount(privateKey);
  const walletAddress = account.address;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // First request - may get 402
    const response = await fetch(input, init);

    if (response.status !== 402) {
      return response;
    }

    // Parse 402 payment requirements
    const paymentHeader = response.headers.get("x-payment-required");
    if (!paymentHeader) {
      throw new Error("402 response missing x-payment-required header");
    }

    const paymentRequired = parsePaymentRequired(paymentHeader);
    const option = paymentRequired.accepts?.[0];
    if (!option) {
      throw new Error("No payment options in 402 response");
    }

    const amount = option.amount || option.maxAmountRequired;
    if (!amount) {
      throw new Error("No amount in payment requirements");
    }

    // Create signed payment
    const paymentPayload = await createPaymentPayload(
      privateKey,
      walletAddress,
      option.payTo,
      amount,
      url
    );

    // Retry with payment
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set("payment-signature", paymentPayload);

    return fetch(input, {
      ...init,
      headers: retryHeaders,
    });
  };
}
