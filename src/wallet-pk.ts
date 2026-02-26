/**
 * PrivateKeyWalletSigner
 *
 * WalletSigner implementation for raw 0x private keys.
 * Wraps viem's signTypedData to satisfy the WalletSigner interface.
 * This is the existing behavior — no functional change.
 */

import { signTypedData, privateKeyToAccount } from "viem/accounts";
import type { WalletSigner, TypedDataParams } from "./wallet-signer.js";

export function createPrivateKeyWalletSigner(privateKey: `0x${string}`): WalletSigner {
  const account = privateKeyToAccount(privateKey);

  return {
    address: account.address,

    async signTypedData(params: TypedDataParams): Promise<`0x${string}`> {
      return signTypedData({
        privateKey,
        domain: params.domain,
        types: params.types as Parameters<typeof signTypedData>[0]["types"],
        primaryType: params.primaryType,
        message: params.message,
      });
    },
  };
}
