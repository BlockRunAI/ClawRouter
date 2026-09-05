/**
 * Reconcile the local usage journal against BlockRun's billing ledger.
 *
 * Two records of the same spend exist and they are not the same thing:
 *
 *   the journal  — what ClawRouter BELIEVED each call cost. Historically a
 *                  local estimate, so it drifts whenever the local price table
 *                  does; six prices were stale until v0.12.270 and `/stats` was
 *                  reporting the wrong money the whole time.
 *   the ledger   — what BlockRun actually CHARGED. Authoritative.
 *
 * Comparing them is the point. The join key is the gateway's own request id,
 * recorded per call since f927cd8 — which is why this can only reconcile calls
 * made after that: an id we never captured cannot be matched, ever.
 *
 * The asymmetry that matters: a row the gateway charged for and the journal has
 * no record of is the finding worth surfacing. It means money left the account
 * for something this machine did not do — another machine on the same key,
 * another product, or a call this proxy failed to record. The reverse (journal
 * row, no ledger row) is usually benign: free models, cached responses, and
 * calls that never reached the gateway are all expected to be missing.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fetchUsagePage, type UsageRow } from "./api-key.js";
import type { UsageEntry } from "./logger.js";

const LOG_DIR = join(homedir(), ".openclaw", "blockrun", "logs");

/** A journal entry that carried a gateway request id. */
export type LocalRow = { requestId: string; model: string; cost: number; timestamp: string };

export type ReconcileResult = {
  /** Present on both sides, keyed by request id. */
  matched: Array<{ local: LocalRow; remote: UsageRow; deltaUsd: number }>;
  /** Charged by the gateway, absent from this machine's journal. */
  chargedNotRecorded: UsageRow[];
  /** Recorded locally with an id the ledger window does not contain. */
  recordedNotCharged: LocalRow[];
  /** Ledger rows whose charge is not final yet — excluded from the totals. */
  pending: UsageRow[];
  localTotalUsd: number;
  gatewayTotalUsd: number;
  unavailableDays: string[];
  /** Journal entries with no request id at all — unreconcilable, not a mismatch. */
  unkeyedLocalCount: number;
};

/** Read journal entries written on or after `since`. */
export async function loadLocalRows(since: Date): Promise<{ rows: LocalRow[]; unkeyed: number }> {
  let files: string[];
  try {
    files = (await readdir(LOG_DIR)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return { rows: [], unkeyed: 0 };
  }
  const rows: LocalRow[] = [];
  let unkeyed = 0;
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(join(LOG_DIR, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: UsageEntry;
      try {
        entry = JSON.parse(line) as UsageEntry;
      } catch {
        continue; // a torn last line is normal on a journal being appended to
      }
      if (!entry.timestamp || new Date(entry.timestamp) < since) continue;
      if (!entry.requestId) {
        // Free models, cache hits and pre-f927cd8 entries have no id. Counted,
        // not reported as a discrepancy — absence of a key is not a mismatch.
        unkeyed++;
        continue;
      }
      rows.push({
        requestId: entry.requestId,
        model: entry.model,
        cost: typeof entry.cost === "number" ? entry.cost : 0,
        timestamp: entry.timestamp,
      });
    }
  }
  return { rows, unkeyed };
}

/** Pull the whole ledger window, following the opaque cursor. */
export async function loadGatewayRows(
  apiKey: string,
  from: string,
  maxPages = 40,
): Promise<{ rows: UsageRow[]; unavailableDays: string[] } | undefined> {
  const rows: UsageRow[] = [];
  const unavailableDays = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchUsagePage(apiKey, { from, limit: 500, cursor });
    if (!result) return page === 0 ? undefined : { rows, unavailableDays: [...unavailableDays] };
    rows.push(...result.rows);
    result.unavailableDays.forEach((d) => unavailableDays.add(d));
    if (!result.nextCursor) break;
    cursor = result.nextCursor; // opaque by contract — passed back, never parsed
  }
  return { rows, unavailableDays: [...unavailableDays] };
}

/** Amounts equal to the cent, allowing for float representation. */
const CENT_EPSILON = 1e-9;

/**
 * Join the two records on request id. Pure, so the classification can be tested
 * without a gateway or a journal on disk.
 */
export function joinRows(
  localRows: LocalRow[],
  gatewayRows: UsageRow[],
  unkeyed = 0,
  unavailableDays: string[] = [],
): ReconcileResult {
  const localById = new Map(localRows.map((r) => [r.requestId, r]));
  const seen = new Set<string>();

  const matched: ReconcileResult["matched"] = [];
  const chargedNotRecorded: UsageRow[] = [];
  const pending: UsageRow[] = [];
  let gatewayTotalUsd = 0;

  for (const remote of gatewayRows) {
    // "pending" means the charge can still be repriced. Reconciling it as a
    // settled $0 would manufacture a discrepancy that resolves itself later.
    if (remote.costState === "pending") {
      pending.push(remote);
      continue;
    }
    gatewayTotalUsd += remote.costUsd ?? 0;
    const local = localById.get(remote.requestId);
    if (!local) {
      chargedNotRecorded.push(remote);
      continue;
    }
    seen.add(remote.requestId);
    matched.push({ local, remote, deltaUsd: local.cost - (remote.costUsd ?? 0) });
  }

  const recordedNotCharged = localRows.filter((r) => !seen.has(r.requestId));
  const localTotalUsd = localRows.reduce((sum, r) => sum + r.cost, 0);

  return {
    matched,
    chargedNotRecorded,
    recordedNotCharged,
    pending,
    localTotalUsd,
    gatewayTotalUsd,
    unavailableDays,
    unkeyedLocalCount: unkeyed,
  };
}

export async function reconcile(apiKey: string, days: number): Promise<ReconcileResult> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [{ rows: localRows, unkeyed }, gateway] = await Promise.all([
    loadLocalRows(since),
    loadGatewayRows(apiKey, since.toISOString()),
  ]);
  if (!gateway) throw new Error("Could not read the BlockRun usage ledger (GET /v1/usage).");
  return joinRows(localRows, gateway.rows, unkeyed, gateway.unavailableDays);
}

const usd = (n: number): string => (Math.abs(n) < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(2)}`);

/** Render a reconciliation for a terminal. */
export function formatReconcile(r: ReconcileResult, days: number): string {
  const out: string[] = [];
  const mismatched = r.matched.filter((m) => Math.abs(m.deltaUsd) > CENT_EPSILON);

  out.push(`\nBlockRun reconciliation — last ${days} day${days === 1 ? "" : "s"}\n`);
  out.push(
    `  Gateway charged:  ${usd(r.gatewayTotalUsd)}   (${r.matched.length + r.chargedNotRecorded.length} settled calls)`,
  );
  out.push(`  Journal recorded: ${usd(r.localTotalUsd)}`);
  out.push(
    `  Matched:          ${r.matched.length}, of which ${mismatched.length} disagree on amount`,
  );

  if (mismatched.length > 0) {
    out.push(`\n  Amount mismatches (journal vs gateway):`);
    for (const m of mismatched.slice(0, 10)) {
      out.push(
        `    ${m.remote.requestId.slice(0, 8)}  ${(m.local.model || m.remote.endpoint).padEnd(28)} journal ${usd(m.local.cost)}  gateway ${usd(m.remote.costUsd ?? 0)}`,
      );
    }
    if (mismatched.length > 10) out.push(`    …and ${mismatched.length - 10} more`);
  }

  if (r.chargedNotRecorded.length > 0) {
    // The one that matters: money left the account for something this machine
    // has no record of.
    const total = r.chargedNotRecorded.reduce((s, x) => s + (x.costUsd ?? 0), 0);
    out.push(
      `\n  ⚠ Charged but NOT in this machine's journal: ${r.chargedNotRecorded.length} call(s), ${usd(total)}`,
    );
    out.push(
      `    Expected if the same key is used elsewhere — another machine, another BlockRun product,`,
    );
    out.push(`    or a call made before this proxy started recording request ids.`);
    for (const x of r.chargedNotRecorded.slice(0, 10)) {
      out.push(
        `    ${x.requestId.slice(0, 8)}  ${x.timestamp.slice(0, 19)}  ${x.endpoint.padEnd(26)} ${usd(x.costUsd ?? 0)}`,
      );
    }
    if (r.chargedNotRecorded.length > 10) {
      out.push(`    …and ${r.chargedNotRecorded.length - 10} more`);
    }
  }

  if (r.recordedNotCharged.length > 0) {
    out.push(
      `\n  Recorded locally with no settled ledger row: ${r.recordedNotCharged.length} call(s)`,
    );
    out.push(`    Usually benign — free models, cache hits, and calls still pending pricing.`);
  }
  if (r.pending.length > 0) {
    out.push(`\n  Pending pricing (excluded from totals): ${r.pending.length} call(s)`);
    out.push(`    Usage recorded, charge not final. These can still be repriced.`);
  }
  if (r.unkeyedLocalCount > 0) {
    out.push(`\n  Journal entries with no request id: ${r.unkeyedLocalCount} (not reconcilable)`);
  }
  if (r.unavailableDays.length > 0) {
    out.push(`\n  ⚠ Gateway could not list these days: ${r.unavailableDays.join(", ")}`);
    out.push(`    Totals above are incomplete for that period.`);
  }

  out.push(`\n  Note: the top-up fee (5.5% + $0.30) is charged at purchase, not per call,`);
  out.push(`  so the sum above is less than your card was charged by exactly those fees.\n`);
  return out.join("\n");
}
