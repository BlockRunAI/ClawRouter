/** In-memory credit row. No chain write and no signer. */

export type CreditEntry = Readonly<{
  payer: string;
  amount: string;
  challengeId: string;
  reason: string;
}>;

export class CreditLedger {
  private readonly rows: CreditEntry[] = [];

  /** One row per payer and challenge. A retry returns the first row. */
  recordOnce(entry: CreditEntry): CreditEntry {
    const prior = this.rows.find(
      (row) => row.payer === entry.payer && row.challengeId === entry.challengeId,
    );
    if (prior) return prior;
    this.rows.push(Object.freeze({ ...entry }));
    return this.rows[this.rows.length - 1];
  }

  read(): readonly CreditEntry[] {
    return Object.freeze([...this.rows]);
  }
}

/** Pure read. Does not sign and does not add a row. */
export function readCredits(ledger: CreditLedger): readonly CreditEntry[] {
  return ledger.read();
}
