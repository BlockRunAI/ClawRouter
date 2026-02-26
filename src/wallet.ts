/**
 * Wallet Key Derivation
 *
 * BIP-39 mnemonic generation + BIP-44 HD key derivation for EVM and Solana.
 * Absorbed from @blockrun/clawwallet. No file I/O here - auth.ts handles persistence.
 */

import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english";
import { privateKeyToAccount } from "viem/accounts";

const ETH_DERIVATION_PATH = "m/44'/60'/0'/0/0";
const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";

export interface DerivedKeys {
  mnemonic: string;
  evmPrivateKey: `0x${string}`;
  evmAddress: string;
  solanaPrivateKeyBytes: Uint8Array; // 32 bytes
}

/**
 * Generate a 24-word BIP-39 mnemonic.
 */
export function generateWalletMnemonic(): string {
  return generateMnemonic(english, 256);
}

/**
 * Validate a BIP-39 mnemonic.
 */
export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, english);
}

/**
 * Derive EVM private key and address from a BIP-39 mnemonic.
 * Path: m/44'/60'/0'/0/0 (standard Ethereum derivation)
 */
export function deriveEvmKey(mnemonic: string): { privateKey: `0x${string}`; address: string } {
  const seed = mnemonicToSeedSync(mnemonic);
  const hdKey = HDKey.fromMasterSeed(seed);
  const derived = hdKey.derive(ETH_DERIVATION_PATH);
  if (!derived.privateKey) throw new Error("Failed to derive EVM private key");
  const hex = `0x${Buffer.from(derived.privateKey).toString("hex")}` as `0x${string}`;
  const account = privateKeyToAccount(hex);
  return { privateKey: hex, address: account.address };
}

/**
 * Derive 32-byte Solana private key from a BIP-39 mnemonic.
 * Path: m/44'/501'/0'/0' (standard Solana derivation)
 */
export function deriveSolanaKeyBytes(mnemonic: string): Uint8Array {
  const seed = mnemonicToSeedSync(mnemonic);
  const hdKey = HDKey.fromMasterSeed(seed);
  const derived = hdKey.derive(SOLANA_DERIVATION_PATH);
  if (!derived.privateKey) throw new Error("Failed to derive Solana private key");
  return new Uint8Array(derived.privateKey);
}

/**
 * Derive both EVM and Solana keys from a single mnemonic.
 */
export function deriveAllKeys(mnemonic: string): DerivedKeys {
  const { privateKey: evmPrivateKey, address: evmAddress } = deriveEvmKey(mnemonic);
  const solanaPrivateKeyBytes = deriveSolanaKeyBytes(mnemonic);
  return { mnemonic, evmPrivateKey, evmAddress, solanaPrivateKeyBytes };
}
