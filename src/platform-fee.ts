/**
 * The gateway's platform fee on per-token chat.
 *
 * BlockRun bills per-token paid chat at the vendor's list rate (the
 * `pricing.input` / `pricing.output` a `/v1/models` row publishes) plus a
 * platform fee, published beside those rates as `platform_fee_percent`
 * (BlockRunAI/blockrun specs/2026-11-16-chat-platform-fee.md PF-8). A local
 * estimate that reads only the rates undershoots the 402 quote by that fee.
 *
 * Two shapes are in use: sol.blockrun.ai publishes it inside `pricing` on paid
 * rows; blockrun.ai publishes it there and at the row's top level (paid rows
 * the fee, free rows 0). `pricing` wins, the top level is the fallback.
 *
 * Absent means 0, never a remembered default: an older gateway, and an
 * enterprise gateway that charges no fee (PF-9), simply do not send it.
 * The fee only applies to per-token paid rows. Flat rows are a final price,
 * free rows cost nothing, and media is priced elsewhere (PF-5).
 */

type CatalogRowLike = {
  billing_mode?: unknown;
  pricing?: unknown;
  platform_fee_percent?: unknown;
};

function validPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The platform fee percent a `/v1/models` row says its token cost pays; 0 when absent. */
export function platformFeePercentOf(row: CatalogRowLike): number {
  if (row.billing_mode !== "paid") return 0;
  const pricing =
    row.pricing && typeof row.pricing === "object"
      ? (row.pricing as { platform_fee_percent?: unknown })
      : undefined;
  return validPercent(pricing?.platform_fee_percent) ?? validPercent(row.platform_fee_percent) ?? 0;
}

/** A per-token cost with the platform fee applied: `tokenCostUsd × (1 + percent/100)`. */
export function withPlatformFee(
  tokenCostUsd: number,
  platformFeePercent: number | undefined,
): number {
  const percent = validPercent(platformFeePercent) ?? 0;
  return tokenCostUsd * (1 + percent / 100);
}
