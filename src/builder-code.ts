/**
 * BlockRun x402 builder-code attribution.
 *
 * Tags every payment ClawRouter signs with the ERC-8021 Schema 2 service code
 * (`s`) so BlockRun-originated traffic is attributed on-chain. The CDP
 * facilitator reads `builder-code.info.s` from the payment payload and encodes
 * it into the settlement calldata suffix — no CBOR/encoding happens here.
 *
 * See https://docs.cdp.coinbase.com/x402/core-concepts/builder-codes
 */

/**
 * BlockRun's CDP-registered builder code (must match `^[a-z0-9_]{1,32}$`).
 * Registered at https://portal.cdp.coinbase.com — this exact value is what the
 * facilitator credits on-chain, so it is the real builder code, not a label.
 */
export const BLOCKRUN_SERVICE_CODE = "bc_5hucoh0l";

/**
 * Merge BlockRun's service code (`s`) into a payment payload's `builder-code`
 * extension, preserving any app code (`a`) the server echoed back in its 402.
 *
 * Returns a new extensions object; the input is not mutated.
 */
export function withBuilderCodeServiceCode(
  extensions?: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(extensions ?? {}) };
  const existing = (merged["builder-code"] as { info?: Record<string, unknown> } | undefined) ?? {};
  const existingServiceCodes = Array.isArray(existing.info?.s)
    ? existing.info.s.filter((code): code is string => typeof code === "string")
    : [];
  merged["builder-code"] = {
    ...existing,
    info: {
      ...(existing.info ?? {}),
      s: existingServiceCodes.includes(BLOCKRUN_SERVICE_CODE)
        ? [...existingServiceCodes]
        : [...existingServiceCodes, BLOCKRUN_SERVICE_CODE],
    },
  };
  return merged;
}
