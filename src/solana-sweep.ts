/**
 * Solana Wallet Sweep — migrate USDC from legacy (secp256k1) to new (SLIP-10) wallet.
 *
 * Used when upgrading from the old BIP-32 secp256k1 derivation to correct
 * SLIP-10 Ed25519 derivation. Transfers all USDC from the old address to the new one.
 *
 * Uses raw instruction encoding to avoid @solana-program/token dependency.
 */

import {
  address as solAddress,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromPrivateKeyBytes,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  addSignersToTransactionMessage,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  getProgramDerivedAddress,
  getAddressEncoder,
  type Address,
} from "@solana/kit";

const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;

export type SweepResult = {
  transferred: string; // e.g. "$1.23"
  transferredMicros: bigint;
  txSignature: string;
  oldAddress: string;
  newAddress: string;
};

export type SweepError = {
  error: string;
  oldAddress: string;
  newAddress?: string;
  solBalance?: bigint;
  usdcBalance?: bigint;
};

/**
 * Derive the Associated Token Account (ATA) address for an owner + mint.
 */
async function getAssociatedTokenAddress(owner: Address, mint: Address): Promise<Address> {
  const encoder = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [encoder.encode(owner), encoder.encode(TOKEN_PROGRAM), encoder.encode(mint)],
  });
  return ata;
}

/**
 * Build a "create associated token account idempotent" instruction.
 * Instruction index 1 of the Associated Token Account program.
 */
function buildCreateAtaIdempotentInstruction(
  payer: Address,
  ata: Address,
  owner: Address,
  mint: Address,
) {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    accounts: [
      { address: payer, role: 3 /* writable signer */ },
      { address: ata, role: 1 /* writable */ },
      { address: owner, role: 0 /* readonly */ },
      { address: mint, role: 0 /* readonly */ },
      { address: SYSTEM_PROGRAM, role: 0 /* readonly */ },
      { address: TOKEN_PROGRAM, role: 0 /* readonly */ },
    ],
    data: new Uint8Array([1]), // instruction index 1 = CreateIdempotent
  } as const;
}

/**
 * Build a SPL Token "Transfer" instruction (instruction index 3).
 * Encodes amount as little-endian u64.
 */
function buildTokenTransferInstruction(
  source: Address,
  destination: Address,
  authority: Address,
  amount: bigint,
) {
  // SPL Token Transfer: 1 byte instruction (3) + 8 bytes LE u64 amount
  const data = new Uint8Array(9);
  data[0] = 3; // Transfer instruction index
  // Write amount as little-endian u64
  const view = new DataView(data.buffer, data.byteOffset);
  view.setBigUint64(1, amount, true);

  return {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: source, role: 1 /* writable */ },
      { address: destination, role: 1 /* writable */ },
      { address: authority, role: 2 /* signer */ },
    ],
    data,
  } as const;
}

/**
 * Sweep all USDC from old (legacy secp256k1) wallet to new (SLIP-10) wallet.
 *
 * The NEW wallet pays gas fees (not the old one). Users can't access the old
 * wallet from Phantom/Solflare, so they can't send SOL to it. Instead they
 * fund the new (Phantom-compatible) wallet with a tiny bit of SOL for gas.
 *
 * @param oldKeyBytes - 32-byte private key from legacy derivation
 * @param newKeyBytes - 32-byte private key from SLIP-10 derivation (pays gas)
 * @param rpcUrl - Optional RPC URL override
 * @returns SweepResult on success, SweepError on failure
 */
export async function sweepSolanaWallet(
  oldKeyBytes: Uint8Array,
  newKeyBytes: Uint8Array,
  rpcUrl?: string,
): Promise<SweepResult | SweepError> {
  const url = rpcUrl || process["env"].CLAWROUTER_SOLANA_RPC_URL || SOLANA_DEFAULT_RPC;
  const rpc = createSolanaRpc(url);

  // 1. Create signers from both key sets
  const [oldSigner, newSigner] = await Promise.all([
    createKeyPairSignerFromPrivateKeyBytes(oldKeyBytes),
    createKeyPairSignerFromPrivateKeyBytes(newKeyBytes),
  ]);
  const oldAddress = oldSigner.address;
  const newAddress = newSigner.address;

  const mint = solAddress(SOLANA_USDC_MINT);

  // 2. Check NEW wallet SOL balance (it pays gas)
  let newSolBalance: bigint;
  try {
    const solResp = await rpc.getBalance(solAddress(newAddress)).send();
    newSolBalance = solResp.value;
  } catch (err) {
    return {
      error: `Failed to check SOL balance: ${err instanceof Error ? err.message : String(err)}`,
      oldAddress,
      newAddress,
    };
  }

  // 3. Check old wallet USDC balance (track each token account individually)
  type TokenAccountEntry = { pubkey: string; amount: bigint };
  let usdcBalance = 0n;
  const oldTokenAccounts: TokenAccountEntry[] = [];
  try {
    const response = await rpc
      .getTokenAccountsByOwner(
        solAddress(oldAddress),
        { mint },
        { encoding: "jsonParsed" },
      )
      .send();

    if (response.value.length > 0) {
      for (const account of response.value) {
        const parsed = account.account.data as {
          parsed: { info: { tokenAmount: { amount: string } } };
        };
        const amount = BigInt(parsed.parsed.info.tokenAmount.amount);
        if (amount > 0n) {
          usdcBalance += amount;
          oldTokenAccounts.push({ pubkey: account.pubkey, amount });
        }
      }
    }
  } catch (err) {
    return {
      error: `Failed to check USDC balance: ${err instanceof Error ? err.message : String(err)}`,
      oldAddress,
      newAddress,
    };
  }

  if (usdcBalance === 0n) {
    return {
      error: "No USDC found in old wallet. Nothing to sweep.",
      oldAddress,
      newAddress,
      solBalance: newSolBalance,
      usdcBalance: 0n,
    };
  }

  // 4. Check if new wallet has enough SOL for gas (~0.005 SOL = 5_000_000 lamports)
  const MIN_SOL_FOR_GAS = 5_000_000n;
  if (newSolBalance < MIN_SOL_FOR_GAS) {
    const needed = Number(MIN_SOL_FOR_GAS - newSolBalance) / 1e9;
    return {
      error:
        `Insufficient SOL for transaction fees in your new wallet. ` +
        `Send ~${needed.toFixed(4)} SOL to ${newAddress} (your new Phantom-compatible address) to cover gas. ` +
        `Current SOL balance: ${(Number(newSolBalance) / 1e9).toFixed(6)} SOL`,
      oldAddress,
      newAddress,
      solBalance: newSolBalance,
      usdcBalance,
    };
  }

  // 5. Build and send SPL token transfer (new wallet pays gas, old wallet signs transfer)
  try {
    // Derive ATA for new wallet
    const newAta = await getAssociatedTokenAddress(solAddress(newAddress), mint);

    // Get recent blockhash
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    // Build instructions: create ATA (idempotent, paid by new wallet) + one transfer per source account
    const createAtaIx = buildCreateAtaIdempotentInstruction(
      newSigner.address,  // new wallet pays for ATA creation
      newAta,
      solAddress(newAddress),
      mint,
    );

    const transferIxs = oldTokenAccounts.map((acct) =>
      buildTokenTransferInstruction(
        solAddress(acct.pubkey),
        newAta,
        oldSigner.address,  // old wallet authorizes the token transfer
        acct.amount,
      ),
    );

    const txMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(newSigner.address, msg),  // new wallet pays gas
      (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => appendTransactionMessageInstructions([createAtaIx, ...transferIxs], msg),
    );

    // Attach both signers so signTransactionMessageWithSigners can find them
    const txMessageWithSigners = addSignersToTransactionMessage(
      [newSigner, oldSigner],
      txMessage,
    );

    const signedTx = await signTransactionMessageWithSigners(txMessageWithSigners);
    const txSignature = getSignatureFromTransaction(signedTx);

    // Send transaction and poll for confirmation
    const wsUrl = url.replace("https://", "wss://").replace("http://", "ws://");
    const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
    const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendAndConfirm(signedTx as any, { commitment: "confirmed" });

    const dollars = Number(usdcBalance) / 1_000_000;
    return {
      transferred: `$${dollars.toFixed(2)}`,
      transferredMicros: usdcBalance,
      txSignature,
      oldAddress,
      newAddress,
    };
  } catch (err) {
    return {
      error: `Transaction failed: ${err instanceof Error ? err.message : String(err)}`,
      oldAddress,
      newAddress,
      solBalance: newSolBalance,
      usdcBalance,
    };
  }
}
