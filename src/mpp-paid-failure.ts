/**
 * Failure AFTER an MPP payment was signed (buyer side).
 *
 * MPP charge settles before the upstream runs the model, so a seller error after the credential
 * went out means the buyer may have paid and got nothing. Three rules, enforced here for both rails:
 *  1. Never pay that request again: the call ends with `MppPaidNoCompletionError`, which the proxy
 *     treats like a payment in doubt (no retry, no fallback model).
 *  2. The spend ledger keeps the spend (a signed credential counts) and carries a note saying it
 *     returned no completion, so the loss is visible in `spending.json` and not only in a log.
 *  3. The error carries a reference for the payment, so a dispute has something to point at.
 *
 * "Signed" is not "settled": on Solana the seller submits the transaction, so a seller that dies
 * first costs nothing. The wording says "signed and sent" and the reference lets a human check.
 * A response that was streaming when it broke is not covered: only the status and thrown errors are.
 */
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { SpendPolicyError, type SpendControl, type SpendRecord } from "./spend-control.js";

export class MppPaidNoCompletionError extends Error {
  readonly reference: string;
  readonly status?: number;
  constructor(message: string, reference: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MppPaidNoCompletionError";
    this.reference = reference;
    this.status = status;
  }
}

export type PaidCall = {
  /** A credential or transaction was produced for this call. */
  signed: boolean;
  /** Stable, non-secret handle for the payment (hash of what was sent), for disputes. */
  reference?: string;
  /** The ledger entry written when the payment was signed, if limits made one. */
  record?: SpendRecord;
};

const storage = new AsyncLocalStorage<PaidCall>();

/** The current call's payment state; undefined outside `guardPaid`. */
export function currentPaidCall(): PaidCall | undefined {
  return storage.getStore();
}

/** Short hash of the signed payload: identifies the payment without exposing it. */
export function paymentReference(payload: string): string {
  return `mpp-${createHash("sha256").update(payload).digest("hex").slice(0, 16)}`;
}

/** Record that this call produced a signed payment. First one wins; a call pays at most once. */
export function markSigned(payload: string, record?: SpendRecord): void {
  const call = storage.getStore();
  if (!call || call.signed) return;
  call.signed = true;
  call.reference = paymentReference(payload);
  call.record = record;
}

/**
 * Run one paid call. If it ends without a completion after a payment was signed, annotate the
 * ledger and throw `MppPaidNoCompletionError`; otherwise behave exactly like `run()`.
 * Local refusals (`SpendPolicyError`) and failures before signing pass through untouched.
 */
export async function guardPaid(
  spend: SpendControl | undefined,
  run: () => Promise<Response>,
): Promise<Response> {
  const call: PaidCall = { signed: false };
  let response: Response;
  try {
    response = await storage.run(call, run);
  } catch (err) {
    if (!call.signed || err instanceof SpendPolicyError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw fail(spend, call, undefined, detail, err);
  }
  if (call.signed && response.status >= 400) {
    let snippet = "";
    try {
      snippet = (await response.clone().text()).slice(0, 200);
    } catch {
      /* body unreadable: the status is enough */
    }
    throw fail(spend, call, response.status, snippet);
  }
  return response;
}

function fail(
  spend: SpendControl | undefined,
  call: PaidCall,
  status: number | undefined,
  detail: string,
  cause?: unknown,
): MppPaidNoCompletionError {
  const reference = call.reference ?? "mpp-unknown";
  const why = status !== undefined ? `HTTP ${status}` : "request failed";
  if (spend && call.record) {
    spend.annotateRecord(call.record, `signed, no completion (${why}) ref ${reference}`);
  }
  return new MppPaidNoCompletionError(
    `MPP payment was signed and sent but no completion came back (${why}${detail ? `: ${detail}` : ""}). ` +
      `Not retrying, to avoid paying twice. Payment reference: ${reference}`,
    reference,
    status,
    { cause },
  );
}
