/**
 * The Polymarket SDKs pull in ethers v5, whose signer runs on `elliptic`. Every
 * elliptic release (<= 6.6.1, no fix published) can emit a faulty ECDSA signature,
 * and a faulty plus a correct signature over the same input leak the private key
 * (GHSA-848j-6mx2-7j84). The key here is the user's funded wallet.
 *
 * We are safe only because we hand both SDKs a viem WalletClient, and each SDK then
 * signs through viem (noble), never elliptic. This test pins that: elliptic's sign
 * is made to throw, and every signing path we use runs through the real SDK code.
 * If an SDK update starts wrapping a viem client in an ethers signer, this fails.
 */
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { OrderBuilder, Side, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { createAbstractSigner } from "@polymarket/builder-abstract-signer";

const require = createRequire(import.meta.url);
// Resolve elliptic the way ethers' signing-key does, so the spy is on the copy it uses.
const signingKeyPath = require.resolve("@ethersproject/signing-key");
const elliptic = createRequire(signingKeyPath)("elliptic") as {
  ec: { prototype: { sign: (...args: unknown[]) => unknown } };
};

// Throwaway key: never funded, used only to exercise the signing code paths.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const DEPOSIT_WALLET = "0x00000000000000000000000000000000000000d1" as Hex;

function walletClient() {
  // Never contacted: a local account signs in-process.
  return createWalletClient({
    account: privateKeyToAccount(KEY),
    chain: polygon,
    transport: http("http://127.0.0.1:9"),
  });
}

const ORDER = { tokenID: "123456789", price: 0.5, size: 10, side: Side.BUY };

describe("Polymarket signing never reaches elliptic", () => {
  let ellipticSign: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ellipticSign = vi.spyOn(elliptic.ec.prototype, "sign").mockImplementation(() => {
      throw new Error("elliptic ECDSA was used to sign with the wallet key");
    });
  });

  afterEach(() => {
    ellipticSign.mockRestore();
  });

  it("the trap fires when an ethers v5 Wallet signs, so a pass below means something", async () => {
    const { Wallet } = require("@ethersproject/wallet") as typeof import("@ethersproject/wallet");
    await expect(new Wallet(KEY).signMessage("x")).rejects.toThrow(/elliptic ECDSA/);
    expect(ellipticSign).toHaveBeenCalled();
  });

  it.each([
    ["EOA", SignatureTypeV2.EOA, undefined],
    ["POLY_1271 deposit wallet", SignatureTypeV2.POLY_1271, DEPOSIT_WALLET],
  ])("CLOB orders (%s) sign through viem", async (_label, signatureType, funder) => {
    const builder = new OrderBuilder(walletClient(), 137, signatureType, funder);

    const order = (await builder.buildOrder(ORDER, { tickSize: "0.01", negRisk: false })) as {
      signature: string;
    };

    expect(order.signature).toMatch(/^0x[0-9a-f]{130,}$/);
    expect(ellipticSign).not.toHaveBeenCalled();
  });

  it("relayer signing (builder-abstract-signer) signs through viem", async () => {
    const signer = createAbstractSigner(137, walletClient());

    const message = await signer.signMessage(`0x${"ab".repeat(32)}`);
    const typed = await signer.signTypedData(
      { name: "Test", version: "1", chainId: 137 },
      { Mail: [{ name: "contents", type: "string" }] },
      { contents: "hello" },
      "Mail",
    );

    expect(message).toMatch(/^0x[0-9a-f]{130}$/);
    expect(typed).toMatch(/^0x[0-9a-f]{130}$/);
    expect(ellipticSign).not.toHaveBeenCalled();
  });
});
