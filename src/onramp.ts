import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { toClientEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { resolveOrGenerateWalletKey } from "./auth.js";

const ONRAMP_ENDPOINT = "https://blockrun.ai/api/v1/onramp/token";

/**
 * Mint a short-lived Coinbase-hosted Onramp link for Base USDC.
 *
 * The BlockRun endpoint is priced at $0. Its x402 challenge is used only to
 * prove that the requested destination belongs to the local ClawRouter wallet.
 * The returned session URL is single-use and must never be persisted.
 */
export async function createCoinbaseOnrampUrl(amount = 50): Promise<string> {
  if (!Number.isFinite(amount) || amount < 1 || amount > 2_500) {
    throw new Error("Onramp amount must be between $1 and $2,500.");
  }

  const { key, address } = await resolveOrGenerateWalletKey();
  const account = privateKeyToAccount(key as `0x${string}`);
  const publicClient = createPublicClient({ chain: base, transport: http() });
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });

  const response = await wrapFetchWithPayment(fetch, client)(ONRAMP_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, network: "base", asset: "USDC" }),
    signal: AbortSignal.timeout(30_000),
  });

  const body = (await response.json().catch(() => ({}))) as { error?: unknown; url?: unknown };
  if (!response.ok) {
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : `Onramp gateway returned HTTP ${response.status}.`,
    );
  }
  if (typeof body.url !== "string") throw new Error("Onramp gateway returned no Coinbase link.");

  const url = new URL(body.url);
  if (url.protocol !== "https:" || url.hostname !== "pay.coinbase.com") {
    throw new Error("Onramp gateway returned an invalid Coinbase link.");
  }
  url.searchParams.set("defaultAsset", "USDC");
  url.searchParams.set("defaultNetwork", "base");
  url.searchParams.set("presetFiatAmount", amount.toFixed(2));
  url.searchParams.set("fiatCurrency", "USD");
  return url.toString();
}
