/**
 * CDP Wallet Support for ClawRouter
 *
 * Adds Coinbase Developer Platform (CDP) MPC wallet as an alternative
 * to the raw private key wallet for x402 payments.
 *
 * Why CDP?
 *   - MPC-based key management — no single private key to leak or lose
 *   - Coinbase-managed backup and recovery
 *   - Programmatic wallet creation via API (no seed phrase)
 *   - Enterprise-grade for production agent deployments
 *
 * Setup:
 *   1. Create a CDP API key at https://portal.cdp.coinbase.com
 *   2. Set BLOCKRUN_CDP_API_KEY_NAME and BLOCKRUN_CDP_PRIVATE_KEY env vars
 *   3. Optionally set BLOCKRUN_CDP_WALLET_ID to reuse an existing wallet
 *
 * @see https://docs.cdp.coinbase.com
 */

import { Coinbase, Wallet } from "@coinbase/coinbase-sdk";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { WalletSigner, TypedDataParams } from "./wallet-signer.js";

const CDP_DIR = join(homedir(), ".openclaw", "blockrun", "cdp");
const CDP_WALLET_FILE = join(CDP_DIR, "wallet.json");

/**
 * Create a WalletSigner backed by a CDP MPC wallet.
 *
 * Flow:
 *   1. Configure CDP SDK with API key
 *   2. Load persisted wallet (if exists) or create a new one
 *   3. Return signer that uses CDP's signHash for EIP-712 typed data
 */
export async function createCdpWalletSigner(opts: {
  apiKeyName: string;
  privateKey: string;
  walletId?: string;
  network?: string;
}): Promise<WalletSigner & { walletId: string }> {
  const { apiKeyName, privateKey, walletId, network = Coinbase.networks.BaseMainnet } = opts;

  // Configure CDP SDK
  Coinbase.configure({
    apiKeyName,
    privateKey,
  });

  let wallet: Wallet;

  // Try loading persisted wallet first
  if (existsSync(CDP_WALLET_FILE)) {
    try {
      const data = JSON.parse(await readFile(CDP_WALLET_FILE, "utf8"));
      const seed = data.seed as string;
      const id = walletId || (data.walletId as string);
      if (id && seed) {
        wallet = await Wallet.fetch(id);
        await wallet.setSeed(seed);
        console.log(`[ClawRouter CDP] ✓ Loaded CDP wallet ${id}`);
      } else {
        throw new Error("Invalid wallet file");
      }
    } catch {
      console.log("[ClawRouter CDP] Persisted wallet unavailable — creating new wallet");
      wallet = await createAndPersistWallet(network);
    }
  } else if (walletId) {
    // Explicit wallet ID provided — fetch without seed (read-only metadata)
    wallet = await Wallet.fetch(walletId);
    console.log(`[ClawRouter CDP] ✓ Fetched CDP wallet ${walletId}`);
  } else {
    wallet = await createAndPersistWallet(network);
  }

  const defaultAddress = await wallet.getDefaultAddress();
  const address = defaultAddress.getId() as `0x${string}`;

  console.log(`[ClawRouter CDP] ✓ Active address: ${address}`);
  console.log(`[ClawRouter CDP]   Wallet ID:      ${wallet.getId()}`);
  console.log(`[ClawRouter CDP]   Network:        ${network}`);

  return {
    address,
    walletId: wallet.getId() ?? "",

    async signTypedData(params: TypedDataParams): Promise<`0x${string}`> {
      // CDP AgentKit-style EIP-712 signing via invokeContract / signHash
      // CDP SDK exposes signHash on Address for arbitrary payloads.
      // We hash the typed data using viem then sign via CDP.
      const { hashTypedData } = await import("viem");

      const hash = hashTypedData({
        domain: params.domain,
        types: params.types as Parameters<typeof hashTypedData>[0]["types"],
        primaryType: params.primaryType,
        message: params.message,
      });

      const sig = await defaultAddress.signHash(hash);
      return sig as `0x${string}`;
    },
  };
}

async function createAndPersistWallet(network: string): Promise<Wallet> {
  const wallet = await Wallet.create({ networkId: network });
  const defaultAddress = await wallet.getDefaultAddress();

  // Export and persist seed for recovery
  const exported = await wallet.export();

  await mkdir(CDP_DIR, { recursive: true });
  await writeFile(
    CDP_WALLET_FILE,
    JSON.stringify(
      {
        walletId: wallet.getId(),
        address: defaultAddress.getId(),
        network,
        createdAt: new Date().toISOString(),
        seed: exported.seed,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  console.log(`[ClawRouter CDP]`);
  console.log(`[ClawRouter CDP] ══════════════════════════════════════════════`);
  console.log(`[ClawRouter CDP]   NEW CDP WALLET CREATED`);
  console.log(`[ClawRouter CDP] ══════════════════════════════════════════════`);
  console.log(`[ClawRouter CDP]   Address  : ${defaultAddress.getId()}`);
  console.log(`[ClawRouter CDP]   Wallet ID: ${wallet.getId()}`);
  console.log(`[ClawRouter CDP]   Saved to : ${CDP_WALLET_FILE}`);
  console.log(`[ClawRouter CDP]`);
  console.log(`[ClawRouter CDP]   Fund with USDC on Base to start using ClawRouter:`);
  console.log(`[ClawRouter CDP]   https://coinbase.com → send USDC to the address above`);
  console.log(`[ClawRouter CDP] ══════════════════════════════════════════════`);
  console.log(`[ClawRouter CDP]`);

  return wallet;
}

/**
 * Resolve CDP credentials from environment variables.
 * Returns undefined if CDP env vars are not set.
 */
export function resolveCdpEnvCredentials(): {
  apiKeyName: string;
  privateKey: string;
  walletId?: string;
} | undefined {
  const apiKeyName = process.env.BLOCKRUN_CDP_API_KEY_NAME;
  const cdpPrivateKey = process.env.BLOCKRUN_CDP_PRIVATE_KEY;

  if (!apiKeyName || !cdpPrivateKey) return undefined;

  return {
    apiKeyName,
    privateKey: cdpPrivateKey,
    walletId: process.env.BLOCKRUN_CDP_WALLET_ID,
  };
}
