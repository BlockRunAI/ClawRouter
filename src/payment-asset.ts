/**
 * EIP-3009 payment asset on Base network.
 * Represents a stablecoin that supports `transferWithAuthorization`
 * for gasless, single-step payment settlements.
 */
export type BasePaymentAsset = {
  chain: "base";
  asset: `0x${string}`;
  symbol: string;
  decimals: number;
  name: string;
  transferMethod: "eip3009";
  priority?: number;
  enabled?: boolean;
};

/** Default payment asset: USDC on Base (6 decimals, EIP-3009). */
export const DEFAULT_BASE_PAYMENT_ASSET: BasePaymentAsset = {
  chain: "base",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  symbol: "USDC",
  decimals: 6,
  name: "USD Coin",
  transferMethod: "eip3009",
};

type PaymentMetadataResponse =
  | Partial<BasePaymentAsset>
  | { paymentAssets?: Array<Partial<BasePaymentAsset>> }
  | { paymentAsset?: Partial<BasePaymentAsset> }
  | { base?: Partial<BasePaymentAsset> };

/** Check if a value is a valid 0x-prefixed ERC-20 contract address (40 hex chars). */
function isHexAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Validate and normalize a single payment asset from an API response.
 * Returns undefined if the input is missing required fields or uses a non-EIP-3009 transfer method.
 * Symbols are uppercased; names are trimmed.
 */
export function normalizeBasePaymentAsset(
  value: unknown,
): BasePaymentAsset | undefined {
  if (!value || typeof value !== "object") return undefined;

  const candidate = value as Partial<BasePaymentAsset>;
  if (!isHexAddress(candidate.asset)) return undefined;
  if (typeof candidate.symbol !== "string" || candidate.symbol.trim() === "") return undefined;
  if (
    typeof candidate.decimals !== "number" ||
    !Number.isInteger(candidate.decimals) ||
    candidate.decimals < 0
  ) {
    return undefined;
  }
  if (typeof candidate.name !== "string" || candidate.name.trim() === "") return undefined;
  if (candidate.transferMethod !== undefined && candidate.transferMethod !== "eip3009") {
    return undefined;
  }

  return {
    chain: "base",
    asset: candidate.asset,
    symbol: candidate.symbol.trim().toUpperCase(),
    decimals: candidate.decimals,
    name: candidate.name.trim(),
    transferMethod: "eip3009",
    priority: typeof candidate.priority === "number" ? candidate.priority : undefined,
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : undefined,
  };
}

/** Sort assets by priority (ascending). Assets without priority go last. */
function sortAssets(assets: BasePaymentAsset[]): BasePaymentAsset[] {
  return [...assets].sort(
    (a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Normalize a payment metadata response into an array of valid EIP-3009 assets.
 * Handles flat, nested (`paymentAsset`, `base`), and array (`paymentAssets`) response shapes.
 * Filters out disabled and non-EIP-3009 assets. Falls back to USDC if no valid assets found.
 */
export function normalizeBasePaymentAssets(value: unknown): BasePaymentAsset[] {
  if (!value || typeof value !== "object") return [];

  const payload = value as PaymentMetadataResponse & { paymentAssets?: unknown };
  const candidateList = Array.isArray(payload.paymentAssets)
    ? (payload.paymentAssets as unknown[])
    : [
        (payload as { paymentAsset?: unknown }).paymentAsset,
        (payload as { base?: unknown }).base,
        payload,
      ];

  const normalized = candidateList
    .map((candidate: unknown) => normalizeBasePaymentAsset(candidate))
    .filter((asset: BasePaymentAsset | undefined): asset is BasePaymentAsset => Boolean(asset))
    .filter((asset) => asset.enabled !== false && asset.transferMethod === "eip3009");

  return sortAssets(
    normalized.length > 0 ? normalized : [DEFAULT_BASE_PAYMENT_ASSET],
  );
}

/**
 * Fetch all available EIP-3009 payment assets from the API.
 * Falls back to the default USDC asset on network error or non-OK response.
 */
export async function fetchBasePaymentAssets(
  apiBase: string,
  baseFetch: typeof fetch = fetch,
): Promise<BasePaymentAsset[]> {
  const response = await baseFetch(`${apiBase.replace(/\/+$/, "")}/v1/payment-metadata?chain=base`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return [DEFAULT_BASE_PAYMENT_ASSET];

  const payload = (await response.json()) as PaymentMetadataResponse;
  return normalizeBasePaymentAssets(payload);
}

/**
 * Fetch the highest-priority EIP-3009 payment asset from the API.
 * Convenience wrapper around {@link fetchBasePaymentAssets} that returns only the first asset.
 */
export async function fetchBasePaymentAsset(
  apiBase: string,
  baseFetch: typeof fetch = fetch,
): Promise<BasePaymentAsset | undefined> {
  const assets = await fetchBasePaymentAssets(apiBase, baseFetch);
  return assets[0];
}
