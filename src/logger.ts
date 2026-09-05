/**
 * Usage Logger
 *
 * Logs every LLM request as a JSON line to a daily log file.
 * Files: ~/.openclaw/blockrun/logs/usage-YYYY-MM-DD.jsonl
 *
 * MVP: append-only JSON lines. No rotation, no cleanup.
 * Logging never breaks the request flow — all errors are swallowed.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export type UsageEntry = {
  timestamp: string;
  model: string;
  tier: string;
  cost: number;
  baselineCost: number;
  savings: number; // 0-1 percentage
  latencyMs: number;
  /** Whether the request completed successfully or ended in an error */
  status?: "success" | "error";
  /** Input (prompt) tokens reported by the provider */
  inputTokens?: number;
  /** Output (completion) tokens reported by the provider */
  outputTokens?: number;
  /** Partner service ID (e.g., "image_generation") — only set for partner API calls */
  partnerId?: string;
  /** Partner service name (e.g., "BlockRun") — only set for partner API calls */
  service?: string;
  /**
   * The gateway's own id for this request, from the `x-blockrun-request-id`
   * response header. Absent for requests that never reached the gateway (a
   * cache hit, a local refusal, an aborted call).
   *
   * This is the JOIN KEY for billing reconciliation. Every `cost` in this file
   * is a LOCAL estimate computed from our copy of the price table, so it drifts
   * whenever that copy goes stale — six prices were wrong until v0.12.270, and
   * `/stats` had been reporting the wrong money the whole time. Recording the
   * gateway's id is what will let us diff this journal line-by-line against a
   * server-side ledger and show what was actually charged instead of what we
   * guessed. It cannot be backfilled: a call whose id we did not record is
   * unreconcilable forever, which is why this is captured before the ledger API
   * that will consume it exists. It is also the id support needs to trace one
   * failed call.
   */
  requestId?: string;
};

const LOG_DIR = join(homedir(), ".openclaw", "blockrun", "logs");
let dirReady = false;

async function ensureDir(): Promise<void> {
  if (dirReady) return;
  await mkdir(LOG_DIR, { recursive: true });
  dirReady = true;
}

/**
 * Log a usage entry as a JSON line.
 */
export async function logUsage(entry: UsageEntry): Promise<void> {
  try {
    await ensureDir();
    const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
    const file = join(LOG_DIR, `usage-${date}.jsonl`);
    await appendFile(file, JSON.stringify(entry) + "\n");
  } catch {
    // Never break the request flow
  }
}
