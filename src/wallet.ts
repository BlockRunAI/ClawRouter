/**
 * Wallet Key Derivation
 *
 * BIP-39 mnemonic generation + BIP-44 HD key derivation for EVM and Solana.
 * Absorbed from @blockrun/clawwallet. No file I/O here - auth.ts handles persistence.
 *
 * Solana uses SLIP-10 Ed25519 derivation (Phantom/Solflare/Backpack compatible).
 * EVM uses standard BIP-32 secp256k1 derivation.
 */

import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { privateKeyToAccount } from "viem/accounts";

const ETH_DERIVATION_PATH = "m/44'/60'/0'/0/0";
const SOLANA_HARDENED_INDICES = [44 + 0x80000000, 501 + 0x80000000, 0 + 0x80000000, 0 + 0x80000000]; // m/44'/501'/0'/0'

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
 * Derive 32-byte Solana private key using SLIP-10 Ed25519 derivation.
 * Path: m/44'/501'/0'/0' (Phantom / Solflare / Backpack compatible)
 *
 * Algorithm (SLIP-0010 for Ed25519):
 *   1. Master: HMAC-SHA512(key="ed25519 seed", data=bip39_seed) → IL=key, IR=chainCode
 *   2. For each hardened child index:
 *      HMAC-SHA512(key=chainCode, data=0x00 || key || ser32(index)) → split again
 *   3. Final IL (32 bytes) = Ed25519 private key seed
 */
export function deriveSolanaKeyBytes(mnemonic: string): Uint8Array {
  const seed = mnemonicToSeedSync(mnemonic);

  // Master key from SLIP-10
  // @noble/hashes v2 requires Uint8Array keys (v1 accepted strings)
  let I = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);

  // Derive each hardened child: m/44'/501'/0'/0'
  for (const index of SOLANA_HARDENED_INDICES) {
    const data = new Uint8Array(37);
    data[0] = 0x00;
    data.set(key, 1);
    // ser32 big-endian
    data[33] = (index >>> 24) & 0xff;
    data[34] = (index >>> 16) & 0xff;
    data[35] = (index >>> 8) & 0xff;
    data[36] = index & 0xff;
    I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }

  return new Uint8Array(key);
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Decode the Solana secret-key formats used by the shared BlockRun wallet.
 * The canonical `.solana-session` contains a base58-encoded 64-byte keypair;
 * Solana Kit signs from its first 32-byte Ed25519 seed.
 */
export function decodeSolanaSessionKey(value: string): Uint8Array {
  const key = value.trim();
  let decoded: Uint8Array;

  if (key.startsWith("[")) {
    const parsed = JSON.parse(key) as unknown;
    if (
      !Array.isArray(parsed) ||
      !parsed.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
    ) {
      throw new Error("Solana JSON key must contain byte values from 0 to 255.");
    }
    decoded = Uint8Array.from(parsed as number[]);
  } else {
    const hex = key.startsWith("0x") ? key.slice(2) : key;
    if (/^[0-9a-f]{64}(?:[0-9a-f]{64})?$/i.test(hex)) {
      decoded = Uint8Array.from(Buffer.from(hex, "hex"));
    } else {
      const bytes = [0];
      for (const char of key) {
        const digit = BASE58_ALPHABET.indexOf(char);
        if (digit < 0) throw new Error("Solana key contains a non-base58 character.");
        let carry = digit;
        for (let index = 0; index < bytes.length; index++) {
          carry += bytes[index] * 58;
          bytes[index] = carry & 0xff;
          carry >>= 8;
        }
        while (carry > 0) {
          bytes.push(carry & 0xff);
          carry >>= 8;
        }
      }
      for (let index = 0; index < key.length - 1 && key[index] === "1"; index++) bytes.push(0);
      decoded = Uint8Array.from(bytes.reverse());
    }
  }

  if (decoded.length !== 32 && decoded.length !== 64) {
    throw new Error(`Solana key must decode to 32 or 64 bytes; got ${decoded.length}.`);
  }
  return decoded.slice(0, 32);
}

/**
 * Derive both EVM and Solana keys from a single mnemonic.
 */
export function deriveAllKeys(mnemonic: string): DerivedKeys {
  const { privateKey: evmPrivateKey, address: evmAddress } = deriveEvmKey(mnemonic);
  const solanaPrivateKeyBytes = deriveSolanaKeyBytes(mnemonic);
  return { mnemonic, evmPrivateKey, evmAddress, solanaPrivateKeyBytes };
}

/**
 * Get the Solana address from 32-byte private key bytes.
 * Uses @solana/kit's createKeyPairSignerFromPrivateKeyBytes (dynamic import).
 */
export async function getSolanaAddress(privateKeyBytes: Uint8Array): Promise<string> {
  const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
  const signer = await createKeyPairSignerFromPrivateKeyBytes(privateKeyBytes);
  return signer.address;
}
