import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { mnemonicToSeedSync } from "@scure/bip39";

const SOLANA_HARDENED_INDICES = [44 + 0x80000000, 501 + 0x80000000, 0 + 0x80000000, 0 + 0x80000000];

/** Derive the Solana seed at m/44'/501'/0'/0' using SLIP-0010 Ed25519. */
export function deriveSolanaKeyBytes(mnemonic: string): Uint8Array {
  const seed = mnemonicToSeedSync(mnemonic);
  let digest = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let key = digest.slice(0, 32);
  let chainCode = digest.slice(32);

  for (const index of SOLANA_HARDENED_INDICES) {
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key, 1);
    data[33] = (index >>> 24) & 0xff;
    data[34] = (index >>> 16) & 0xff;
    data[35] = (index >>> 8) & 0xff;
    data[36] = index & 0xff;
    digest = hmac(sha512, chainCode, data);
    key = digest.slice(0, 32);
    chainCode = digest.slice(32);
  }

  return new Uint8Array(key);
}
