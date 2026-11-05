/**
 * Seller-side spent-proof ledger. In memory only.
 *
 * A proof is one payment transaction signature plus one challenge id.
 * The buyer's 402 followed by the authorized retry is one proof: the 402
 * carries no transaction signature, so it never claims a slot.
 */

export class ReplayRejectedError extends Error {
  readonly status = 409;
  readonly code = "proof_replayed";
  constructor(
    readonly networkId: string,
    readonly txSignature: string,
    readonly challengeId: string,
  ) {
    super("payment transaction or challenge already used on this network");
    this.name = "ReplayRejectedError";
  }
}

export class SpentProofLedger {
  private readonly transactions = new Map<string, string>();
  private readonly challenges = new Map<string, string>();

  claim(networkId: string, txSignature: string, challengeId: string): boolean {
    if (!networkId || !txSignature || !challengeId)
      throw new TypeError("network id, transaction signature, and challenge id are required");
    const transactionKey = JSON.stringify([networkId, txSignature]);
    const challengeKey = JSON.stringify([networkId, challengeId]);
    // A verified transaction is one spend, and a challenge is one fulfillment.
    // Check both indexes before mutating either so rejected claims remain atomic.
    if (this.transactions.has(transactionKey) || this.challenges.has(challengeKey)) return false;
    this.transactions.set(transactionKey, challengeId);
    this.challenges.set(challengeKey, txSignature);
    return true;
  }
}

/**
 * Accept one paid proof and call the model at most once.
 * The claim is synchronous, so two overlapping calls yield one winner.
 */
export async function fulfillPaidProof<T>(opts: {
  ledger: SpentProofLedger;
  networkId: string;
  txSignature: string;
  challengeId: string;
  upstream: () => Promise<T>;
}): Promise<T> {
  const won = opts.ledger.claim(opts.networkId, opts.txSignature, opts.challengeId);
  if (!won) throw new ReplayRejectedError(opts.networkId, opts.txSignature, opts.challengeId);
  return opts.upstream();
}
