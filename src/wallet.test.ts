/**
 * Wallet derivation tests — BIP-39 mnemonic + BIP-44 key derivation.
 */

import { describe, it, expect } from "vitest";
import {
  generateWalletMnemonic,
  isValidMnemonic,
  deriveEvmKey,
  deriveSolanaKeyBytes,
  deriveAllKeys,
} from "./wallet.js";

describe("wallet key derivation", () => {
  const TEST_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

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

  describe("deriveSolanaKeyBytes", () => {
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
