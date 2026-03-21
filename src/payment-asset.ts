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

function isHexAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

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

function sortAssets(assets: BasePaymentAsset[]): BasePaymentAsset[] {
  return [...assets].sort(
    (a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
  );
}

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

export async function fetchBasePaymentAsset(
  apiBase: string,
  baseFetch: typeof fetch = fetch,
): Promise<BasePaymentAsset | undefined> {
  const assets = await fetchBasePaymentAssets(apiBase, baseFetch);
  return assets[0];
}
