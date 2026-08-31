/**
 * Wallet derivation tests — BIP-39 mnemonic + BIP-44 key derivation.
 * Tests SLIP-10 Ed25519 (Phantom-compatible) derivation.
 */

import { describe, it, expect } from "vitest";
import {
  generateWalletMnemonic,
  isValidMnemonic,
  deriveEvmKey,
  deriveSolanaKeyBytes,
  decodeSolanaSessionKey,
  deriveAllKeys,
} from "./wallet.js";

describe("wallet key derivation", () => {
  const TEST_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

  // Known SLIP-10 Ed25519 derivation result for the test mnemonic at m/44'/501'/0'/0'
  const EXPECTED_SLIP10_KEY_HEX =
    "7c139e1a603ca04f5f7cff194e1bb6f6d1b9098470ea90695ab628488a9f921b";
  const EXPECTED_SLIP10_ADDRESS = "3Cy3YNTFywCmxoxt8n7UH6hg6dLo5uACowX3CFceaSnx";

  describe("generateWalletMnemonic", () => {
    it("generates a valid 24-word mnemonic", () => {
      const mnemonic = generateWalletMnemonic();
      const words = mnemonic.split(" ");
      expect(words).toHaveLength(24);
      expect(isValidMnemonic(mnemonic)).toBe(true);
    });

    it("generates unique mnemonics each time", () => {
      const a = generateWalletMnemonic();
      const b = generateWalletMnemonic();
      expect(a).not.toBe(b);
    });
  });

  describe("isValidMnemonic", () => {
    it("accepts valid mnemonics", () => {
      expect(isValidMnemonic(TEST_MNEMONIC)).toBe(true);
    });

    it("rejects invalid strings", () => {
      expect(isValidMnemonic("not a valid mnemonic")).toBe(false);
      expect(isValidMnemonic("")).toBe(false);
    });
  });

  describe("deriveEvmKey", () => {
    it("derives a valid 0x-prefixed 66-char hex key", () => {
      const { privateKey, address } = deriveEvmKey(TEST_MNEMONIC);
      expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/);
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("is deterministic for the same mnemonic", () => {
      const a = deriveEvmKey(TEST_MNEMONIC);
      const b = deriveEvmKey(TEST_MNEMONIC);
      expect(a.privateKey).toBe(b.privateKey);
      expect(a.address).toBe(b.address);
    });

    it("derives different keys for different mnemonics", () => {
      const a = deriveEvmKey(TEST_MNEMONIC);
      const b = deriveEvmKey(generateWalletMnemonic());
      expect(a.privateKey).not.toBe(b.privateKey);
    });
  });

  describe("deriveSolanaKeyBytes (SLIP-10 Ed25519)", () => {
    it("returns a 32-byte Uint8Array", () => {
      const bytes = deriveSolanaKeyBytes(TEST_MNEMONIC);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBe(32);
    });

    it("is deterministic for the same mnemonic", () => {
      const a = deriveSolanaKeyBytes(TEST_MNEMONIC);
      const b = deriveSolanaKeyBytes(TEST_MNEMONIC);
      expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
    });

    it("derives different keys for different mnemonics", () => {
      const a = deriveSolanaKeyBytes(TEST_MNEMONIC);
      const b = deriveSolanaKeyBytes(generateWalletMnemonic());
      expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
    });

    it("produces known SLIP-10 key for test mnemonic", () => {
      const bytes = deriveSolanaKeyBytes(TEST_MNEMONIC);
      expect(Buffer.from(bytes).toString("hex")).toBe(EXPECTED_SLIP10_KEY_HEX);
    });

    it("produces Phantom-compatible Solana address", async () => {
      const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
      const bytes = deriveSolanaKeyBytes(TEST_MNEMONIC);
      const signer = await createKeyPairSignerFromPrivateKeyBytes(bytes);
      expect(signer.address).toBe(EXPECTED_SLIP10_ADDRESS);
    });
  });

  describe("decodeSolanaSessionKey", () => {
    it("loads the 64-byte base58 format used by BlockRun Core", () => {
      const encoded =
        "1GMkH3brNXiNNs1tiFZHu4yZSRrzJwxi5wB9bHFtMinfCXNnR1adh8Vo8NTheK4evneedH4qmvjeqcBBNAefgS";
      expect([...decodeSolanaSessionKey(encoded)]).toEqual([...Array(32).keys()]);
    });

    it("accepts Solana CLI JSON and 32-byte seed hex", () => {
      const bytes = [...Array(64).keys()];
      expect([...decodeSolanaSessionKey(JSON.stringify(bytes))]).toEqual(bytes.slice(0, 32));
      expect(Buffer.from(decodeSolanaSessionKey("11".repeat(32))).toString("hex")).toBe(
        "11".repeat(32),
      );
    });

    it("rejects malformed or incorrectly-sized keys", () => {
      expect(() => decodeSolanaSessionKey("not/a/solana/key")).toThrow(/base58/i);
      expect(() => decodeSolanaSessionKey("1111")).toThrow(/32 or 64 bytes/i);
    });
  });

  describe("deriveAllKeys", () => {
    it("returns EVM and Solana keys from a single mnemonic", () => {
      const keys = deriveAllKeys(TEST_MNEMONIC);
      expect(keys.mnemonic).toBe(TEST_MNEMONIC);
      expect(keys.evmPrivateKey).toMatch(/^0x[0-9a-f]{64}$/);
      expect(keys.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(keys.solanaPrivateKeyBytes).toBeInstanceOf(Uint8Array);
      expect(keys.solanaPrivateKeyBytes.length).toBe(32);
    });

    it("uses SLIP-10 derivation for Solana key", () => {
      const keys = deriveAllKeys(TEST_MNEMONIC);
      expect(Buffer.from(keys.solanaPrivateKeyBytes).toString("hex")).toBe(EXPECTED_SLIP10_KEY_HEX);
    });

    it("EVM and Solana keys are different", () => {
      const keys = deriveAllKeys(TEST_MNEMONIC);
      const evmHex = keys.evmPrivateKey.slice(2);
      const solHex = Buffer.from(keys.solanaPrivateKeyBytes).toString("hex");
      expect(evmHex).not.toBe(solHex);
    });
  });

  describe("Solana key produces valid signer", () => {
    it("createKeyPairSignerFromPrivateKeyBytes accepts derived bytes", async () => {
      const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
      const bytes = deriveSolanaKeyBytes(TEST_MNEMONIC);
      const signer = await createKeyPairSignerFromPrivateKeyBytes(bytes);
      expect(typeof signer.address).toBe("string");
      expect(signer.address.length).toBeGreaterThan(20);
    });

    it("same mnemonic produces same Solana address", async () => {
      const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
      const bytesA = deriveSolanaKeyBytes(TEST_MNEMONIC);
      const bytesB = deriveSolanaKeyBytes(TEST_MNEMONIC);
      const signerA = await createKeyPairSignerFromPrivateKeyBytes(bytesA);
      const signerB = await createKeyPairSignerFromPrivateKeyBytes(bytesB);
      expect(signerA.address).toBe(signerB.address);
    });
  });
});
