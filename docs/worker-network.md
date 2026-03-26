# BlockRun Worker Network

> **For Claude implementing this:** Use `superpowers:executing-plans` to implement the tasks section task-by-task.

**Goal:** Let ClawRouter users opt in as worker nodes — poll tasks, execute HTTP checks, earn USDC via x402 micropayments.

**Architecture:** ClawRouter polls every 30s, signs results with existing wallet key. BlockRun verifies signature, writes to DB, triggers batched x402 payout at $0.01 threshold, simultaneously writes calldata log tx to Base for immutable audit trail.

**Tech Stack:** viem (signing + calldata tx), x402 reversed payTo (worker payout), DB (credits ledger), GCS (result logs + reputation source), Base calldata (audit trail)

---

## Overview

ClawRouter Worker Mode transforms any ClawRouter installation into a node in a decentralized uptime monitoring network. Workers earn USDC by executing HTTP health checks assigned by BlockRun. Buyers purchase monitoring with tamper-proof, multi-node uptime proof — a stronger signal than self-reported metrics.

**Current supply-side advantage:** ~1,000 paying ClawRouter users already have wallets and geographic distribution. Turning them into workers requires zero additional setup.

---

## Target Customers

### Primary: Web3 Protocols (Phase 1)

Blockchain protocols, L1/L2 chains, DeFi applications, RPC providers.

**Why they buy:**

- CEX listing requirements mandate uptime SLA proof
- Institutional investors require auditable availability records
- Decentralized proof (multi-node, on-chain payment trail) is more credible than self-reported metrics
- Already comfortable with USDC payments — no payment education needed

**Example customers:** New L2 chains seeking Binance/Coinbase listing, DeFi protocols pitching institutional LPs, bridge protocols, oracle networks

### Secondary: AI API Providers (Phase 2)

OpenAI, Anthropic, and the long tail of AI API businesses.

### Tertiary: SaaS & Fintech (Phase 2+)

Any B2B company that sells to enterprises or operates under financial regulation.

---

## Pricing Model

### For Buyers

| Tier            | SLA                                            | Price         | BlockRun margin |
| --------------- | ---------------------------------------------- | ------------- | --------------- |
| **Best Effort** | Checks run when workers online (~90% coverage) | $0.0003/check | 67%             |
| **Standard**    | ≥1 check/min guaranteed (BlockRun fills gaps)  | $0.001/check  | 90%             |
| **Premium**     | 30s guaranteed + multi-region report           | $0.003/check  | 97%             |

Monthly equivalent per endpoint (30s Standard):

- 2,880 checks/day × 30 × $0.001 = **$86.40/month**
- Worker cost: 2,880 × $0.0001 = **$8.64/month**
- **BlockRun margin: $77.76/endpoint/month**

### For Workers

Base rate: **$0.0001/check** (100 USDC micros)

Multiplied by reputation tier (see below). Payouts trigger at **$0.01 threshold** to minimize gas.

---

## Reputation Flywheel

BlockRun already has all payment data from LLM inference. **No third-party needed.**

```
用户付钱买 LLM → 积累 reputation
高 reputation → 拿到更多/更好 worker 任务
赚到更多 USDC → 继续买 LLM
→ 循环
```

### Reputation Tiers (based on lifetime USDC paid to BlockRun)

| Tier         | Condition   | Worker reward         | Task priority                |
| ------------ | ----------- | --------------------- | ---------------------------- |
| **Bronze**   | New user    | $0.0001/check (1x)    | Standard                     |
| **Silver**   | ≥ $10 paid  | $0.00012/check (1.2x) | Priority assignment          |
| **Gold**     | ≥ $50 paid  | $0.00015/check (1.5x) | High-value tasks             |
| **Platinum** | ≥ $200 paid | $0.0002/check (2x)    | Enterprise tasks, first pick |

Reputation is computed from BlockRun's own GCS logs (LLM call history per wallet), refreshed daily. Cached in DB per wallet — not queried on every request.

---

## Worker Availability Reality

ClawRouter users are developers on their own machines, not 24/7 server operators.

**Estimated concurrent online workers:**

```
Peak (US + EU working hours):  200–300
Average (any time):            100–150
Off-peak (US overnight):        30–50
```

### Task Redundancy (not consensus)

**Each task is assigned to 3 workers per cycle.** First valid submission wins and gets paid. The other 2 are discarded. This is purely for redundancy — not to verify each other's work. Workers have no incentive to cheat (work is trivially cheap, reward is tiny).

```
task_br_health sent to:
  worker_042 (US-West)  → submits 200, 45ms  ✅ WINS, gets paid
  worker_731 (EU)       → submits 200, 120ms → discarded
  worker_209 (US-East)  → submits 200, 52ms  → discarded
```

**Task queue logic:** Return tasks where `now - lastSuccessfulCheck > targetInterval`. Workers naturally fill gaps. No orphaned assignments.

**Standard/Premium tiers:** BlockRun runs always-on backup workers to guarantee baseline coverage.

---

## Payment Architecture

### Full Money Flow

```
Buyer wallet
  ──$0.001/check──▶ BlockRun (x402, payTo = BlockRun address)
                     ↓
                    DB: worker_credits[address] += rewardMicros
                     ↓ (when credits ≥ $0.01)
                    BlockRun treasury
                      ──$0.01──▶ Worker wallet
                                  x402 (payTo = worker address)
                                  + 0 ETH calldata log tx on Base
                     ↓
                    BlockRun keeps the spread ($0.009 per $0.01 payout)
```

### Why x402 Both Directions

x402 is EIP-3009 TransferWithAuthorization. The `payTo` field is just an address — change it to the worker's wallet:

- **Buyer → BlockRun:** `from: buyer, to: blockrunWallet`
- **BlockRun → Worker:** `from: treasury, to: workerWallet`

Same CDP facilitator `/settle` endpoint. No new payment infrastructure.

### Payout Batching

Do NOT pay $0.0001 per check immediately:

- Accumulate credits in DB per worker
- Pay when worker reaches **$0.01 threshold** (~100 checks)
- Base L2 gas ≈ $0.0001/tx → gas overhead = **1%** of payout

---

## Storage Architecture (Dual-Write)

Every payout writes to **two places simultaneously**:

| Layer             | Purpose                                          | Data                 |
| ----------------- | ------------------------------------------------ | -------------------- |
| **DB**            | Fast reads, operational queries, pending credits | All tables below     |
| **Base calldata** | Immutable audit trail, independent verification  | Payout receipts only |

### DB Schema

```sql
CREATE TABLE worker_credits (
  address         TEXT PRIMARY KEY,
  pending_micros  BIGINT NOT NULL DEFAULT 0,
  total_earned    BIGINT NOT NULL DEFAULT 0,
  total_paid      BIGINT NOT NULL DEFAULT 0,
  last_payout_at  TIMESTAMPTZ,
  last_payout_tx  TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE worker_results (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          TEXT NOT NULL,
  worker_address   TEXT NOT NULL,
  timestamp        BIGINT NOT NULL,
  success          BOOLEAN NOT NULL,
  response_time_ms INTEGER,
  status_code      INTEGER,
  reward_micros    INTEGER NOT NULL,
  paid             BOOLEAN NOT NULL DEFAULT FALSE,
  payout_id        UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON worker_results (worker_address, paid);
CREATE INDEX ON worker_results (created_at);

CREATE TABLE worker_payouts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_address TEXT NOT NULL,
  amount_micros  BIGINT NOT NULL,
  result_count   INTEGER NOT NULL,
  results_hash   TEXT NOT NULL,   -- SHA256 of result IDs (also written to calldata)
  tx_hash        TEXT,            -- USDC transfer tx on Base
  log_tx_hash    TEXT,            -- 0 ETH calldata log tx on Base
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending/confirmed/failed
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE wallet_reputation (
  address        TEXT PRIMARY KEY,
  total_paid_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  tier           TEXT NOT NULL DEFAULT 'bronze',   -- bronze/silver/gold/platinum
  multiplier     NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  refreshed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Blockchain Calldata (on every payout)

A separate 0 ETH transaction broadcast alongside the USDC transfer:

```typescript
// to: BLOCKRUN_LOG_ADDRESS (BlockRun's own address)
// value: 0 ETH
// calldata: encoded payout receipt
{
  v: 1,
  type: "worker_payout",
  worker: "0x...",
  amountMicros: 10000,
  resultCount: 100,
  resultsHash: "0xabc...",   // SHA256 of result IDs
  payoutId: "uuid",
  payoutTxHash: "0x...",
  ts: 1234567890
}
```

**Independent verification:** Anyone can scan Base for txs to `BLOCKRUN_LOG_ADDRESS`, decode calldata, and verify all worker payouts without trusting BlockRun's DB.

---

## Trust & Verification Model

Workers are **existing paying ClawRouter users**. The work is trivially cheap:

```javascript
const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
return { status: res.status, latency: Date.now() - start };
```

Cost to do the work: ~10ms, $0.
Cost to fake: write cheating code, risk ban.
Reward either way: $0.0001.

**No rational incentive to cheat.** Simple EIP-191 signature proves identity. That's sufficient.

Future (V2): nonce injection for BlockRun-owned endpoints, spot-check verification for third-party.

---

## All Design Decisions

| Question                   | Decision                                          |
| -------------------------- | ------------------------------------------------- |
| 3-worker consensus needed? | No — redundancy only, not verification            |
| How to pay workers?        | x402 reversed payTo, same CDP facilitator         |
| Workers always online?     | No — 100-150 avg, 3x redundancy compensates       |
| Verify work authenticity?  | Trust-based (paying users, no incentive to cheat) |
| Track credits per worker?  | DB (primary) + Base calldata (audit)              |
| Pay per check on-chain?    | No — batch at $0.01 threshold, 1% gas overhead    |
| Calldata mechanism?        | Separate 0 ETH tx to BLOCKRUN_LOG_ADDRESS         |
| Reputation source?         | BlockRun's own GCS logs, no third-party           |
| DB choice?                 | TBD — any Postgres-compatible works               |

---

## Go-to-Market

### Phase 1: Supply Side (Month 1–2)

- Ship `CLAWROUTER_WORKER=1` to 1,000 existing users
- Pilot: 3 hardcoded tasks monitoring BlockRun's own endpoints
- Target: 50+ active workers, end-to-end payment verified on-chain

### Phase 2: First Buyers (Month 2–3)

- Buyer dashboard — register any endpoint, choose SLA tier
- First 10 customers: 30-day free trial
- Publish node map (marketing)
- Target: 5 paying customers, $2,500 MRR

### Phase 3: Scale (Month 3–6)

- Standard/Premium tiers with BlockRun-backed SLA
- "State of Web3 Uptime" report from aggregated data
- Coinbase/Base ecosystem partnership
- Target: $15,000 MRR

---

## Success Metrics

| Metric                | Month 3    | Month 6    |
| --------------------- | ---------- | ---------- |
| Active workers        | 50         | 200        |
| Monitored endpoints   | 25         | 150        |
| Paying customers      | 5          | 30         |
| MRR                   | $2,500     | $15,000    |
| USDC to workers/month | $250       | $1,500     |
| On-chain payout txs   | verifiable | verifiable |

---

## Open Questions (V2)

1. Geographic routing — assign tasks by region
2. Buyer dashboard — web UI for endpoint config
3. Nonce injection — cryptographic proof for owned endpoints
4. Worker reputation UI — let workers see their tier and earnings
5. Legal — liability for uptime certificates in regulatory filings

---

---

# Implementation Plan

## Files to Touch

### ClawRouter

| File                   | Action |
| ---------------------- | ------ |
| `src/worker/types.ts`  | CREATE |
| `src/worker/checks.ts` | CREATE |
| `src/worker/index.ts`  | CREATE |
| `src/index.ts`         | MODIFY |

### BlockRun

| File                                     | Action |
| ---------------------------------------- | ------ |
| `src/lib/worker-tasks.ts`                | CREATE |
| `src/lib/worker-credits.ts`              | CREATE |
| `src/lib/worker-payouts.ts`              | CREATE |
| `src/lib/worker-reputation.ts`           | CREATE |
| `src/app/api/v1/worker/tasks/route.ts`   | CREATE |
| `src/app/api/v1/worker/results/route.ts` | CREATE |

### Environment Variables

**ClawRouter `.env` / shell:**

```bash
CLAWROUTER_WORKER=1
WORKER_REGION=US-West            # optional
BLOCKRUN_API_BASE=https://blockrun.ai/api   # override for local dev
```

**BlockRun `.env.local`:**

```bash
WORKER_PAYOUT_WALLET_KEY=0x...   # treasury signing key — never commit
BLOCKRUN_LOG_ADDRESS=0x...       # BlockRun's own address for calldata logs
DATABASE_URL=postgres://...      # your DB
```

---

## Task 1: ClawRouter — Types

**File:** `src/worker/types.ts`

```typescript
export interface WorkerTask {
  id: string;
  type: "http_check";
  url: string;
  expectedStatus: number;
  timeoutMs: number;
  rewardMicros: number;
  region?: string;
}

export interface WorkerResult {
  taskId: string;
  workerAddress: string;
  timestamp: number;
  success: boolean;
  responseTimeMs: number;
  statusCode?: number;
  error?: string;
  // EIP-191 signature of JSON.stringify({ taskId, workerAddress, timestamp, success })
  signature: string;
}

export interface WorkerStatus {
  address: string;
  completedTasks: number;
  totalEarnedMicros: number;
  lastPollAt?: number;
  busy: boolean;
}
```

**Steps:**

1. `mkdir src/worker && touch src/worker/types.ts` — paste content above
2. `npx tsc --noEmit` — expect no errors
3. `git add src/worker/types.ts && git commit -m "feat(worker): add types"`

---

## Task 2: ClawRouter — HTTP Check Executor

**File:** `src/worker/checks.ts`

```typescript
import type { WorkerTask } from "./types.js";

export async function executeHttpCheck(task: WorkerTask): Promise<{
  success: boolean;
  responseTimeMs: number;
  statusCode?: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const res = await fetch(task.url, {
      method: "GET",
      signal: AbortSignal.timeout(task.timeoutMs),
      redirect: "follow",
      headers: { "User-Agent": "BlockRun-Worker/1.0" },
    });
    return {
      success: res.status === task.expectedStatus,
      responseTimeMs: Date.now() - start,
      statusCode: res.status,
    };
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      success: false,
      responseTimeMs: Date.now() - start,
      error: isTimeout
        ? `Timeout after ${task.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}

// Must produce identical JSON on both sides for signature verification
export function buildSignableMessage(params: {
  taskId: string;
  workerAddress: string;
  timestamp: number;
  success: boolean;
}): string {
  return JSON.stringify({
    taskId: params.taskId,
    workerAddress: params.workerAddress,
    timestamp: params.timestamp,
    success: params.success,
  });
}
```

**Steps:**

1. Create `src/worker/checks.ts` — paste above
2. `npx tsc --noEmit`
3. `git add src/worker/checks.ts && git commit -m "feat(worker): add HTTP check executor"`

---

## Task 3: ClawRouter — WorkerNode Class

**File:** `src/worker/index.ts`

```typescript
import { privateKeyToAccount } from "viem/accounts";
import type { WorkerTask, WorkerResult, WorkerStatus } from "./types.js";
import { executeHttpCheck, buildSignableMessage } from "./checks.js";

const BLOCKRUN_API = process.env.BLOCKRUN_API_BASE ?? "https://blockrun.ai/api";
const POLL_INTERVAL_MS = 30_000;
const MAX_CONCURRENT = 10;
const REGION = process.env.WORKER_REGION ?? "unknown";

export class WorkerNode {
  private privateKey: `0x${string}`;
  private address: string;
  private apiBase: string;
  private busy = false;
  private status: WorkerStatus;

  constructor(walletKey: string, walletAddress: string, apiBase = BLOCKRUN_API) {
    this.privateKey = walletKey as `0x${string}`;
    this.address = walletAddress;
    this.apiBase = apiBase;
    this.status = { address: walletAddress, completedTasks: 0, totalEarnedMicros: 0, busy: false };
  }

  startPolling(): void {
    console.log(`[Worker] Starting — ${this.address} region=${REGION}`);
    this.poll().catch(console.error);
    setInterval(() => this.poll().catch(console.error), POLL_INTERVAL_MS);
  }

  getStatus(): WorkerStatus {
    return { ...this.status, busy: this.busy };
  }

  private async poll(): Promise<void> {
    if (this.busy) return;
    let tasks: WorkerTask[] = [];
    try {
      tasks = await this.fetchTasks();
    } catch (err) {
      console.error(`[Worker] fetch tasks failed:`, err instanceof Error ? err.message : err);
      return;
    }
    if (tasks.length === 0) return;

    this.busy = true;
    this.status.lastPollAt = Date.now();
    console.log(`[Worker] Executing ${tasks.length} task(s)`);
    try {
      const results = await this.executeBatch(tasks);
      await this.submitResults(results);
    } finally {
      this.busy = false;
    }
  }

  private async fetchTasks(): Promise<WorkerTask[]> {
    const url = `${this.apiBase}/v1/worker/tasks?address=${this.address}&region=${REGION}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "BlockRun-Worker/1.0" },
    });
    if (!res.ok) throw new Error(`tasks endpoint ${res.status}`);
    return res.json() as Promise<WorkerTask[]>;
  }

  private async executeBatch(tasks: WorkerTask[]): Promise<WorkerResult[]> {
    const results: WorkerResult[] = [];
    for (let i = 0; i < tasks.length; i += MAX_CONCURRENT) {
      const chunk = tasks.slice(i, i + MAX_CONCURRENT);
      const done = await Promise.all(chunk.map((t) => this.executeAndSign(t)));
      results.push(...done);
    }
    return results;
  }

  private async executeAndSign(task: WorkerTask): Promise<WorkerResult> {
    const check = await executeHttpCheck(task);
    const timestamp = Date.now();
    const message = buildSignableMessage({
      taskId: task.id,
      workerAddress: this.address,
      timestamp,
      success: check.success,
    });
    const account = privateKeyToAccount(this.privateKey);
    const signature = await account.signMessage({ message });
    return { taskId: task.id, workerAddress: this.address, timestamp, ...check, signature };
  }

  private async submitResults(results: WorkerResult[]): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/v1/worker/results`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "BlockRun-Worker/1.0" },
        body: JSON.stringify(results),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.error(`[Worker] submit failed ${res.status}`);
        return;
      }
      const data = (await res.json()) as { accepted: number; earned: string };
      this.status.completedTasks += data.accepted;
      console.log(`[Worker] ✓ ${data.accepted} result(s) accepted, earned $${data.earned} USDC`);
    } catch (err) {
      console.error(`[Worker] submit error:`, err instanceof Error ? err.message : err);
    }
  }
}
```

**Steps:**

1. Create `src/worker/index.ts` — paste above
2. `npx tsc --noEmit`
3. `git add src/worker/index.ts && git commit -m "feat(worker): add WorkerNode class"`

---

## Task 4: ClawRouter — Wire Worker Mode

**File:** `src/index.ts` — modify `startProxyInBackground()`.

Find this block (~line 423):

```typescript
setActiveProxy(proxy);
activeProxyHandle = proxy;
```

Add immediately after:

```typescript
const workerMode = process.env.CLAWROUTER_WORKER === "1" || process.argv.includes("--worker");

if (workerMode) {
  const { WorkerNode } = await import("./worker/index.js");
  const worker = new WorkerNode(walletKey, address);
  worker.startPolling();
  api.logger.info(`[Worker] Mode active — polling every 30s, wallet: ${address}`);
}
```

**Steps:**

1. Edit `src/index.ts`
2. `npx tsc --noEmit`
3. `git add src/index.ts && git commit -m "feat(worker): activate WorkerNode on CLAWROUTER_WORKER=1"`

---

## Task 5: BlockRun — DB Schema

Run this migration against your DB (Postgres-compatible):

```sql
CREATE TABLE worker_credits (
  address         TEXT PRIMARY KEY,
  pending_micros  BIGINT NOT NULL DEFAULT 0,
  total_earned    BIGINT NOT NULL DEFAULT 0,
  total_paid      BIGINT NOT NULL DEFAULT 0,
  last_payout_at  TIMESTAMPTZ,
  last_payout_tx  TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE worker_results (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          TEXT NOT NULL,
  worker_address   TEXT NOT NULL,
  timestamp        BIGINT NOT NULL,
  success          BOOLEAN NOT NULL,
  response_time_ms INTEGER,
  status_code      INTEGER,
  reward_micros    INTEGER NOT NULL,
  paid             BOOLEAN NOT NULL DEFAULT FALSE,
  payout_id        UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON worker_results (worker_address, paid);
CREATE INDEX ON worker_results (created_at);

CREATE TABLE worker_payouts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_address TEXT NOT NULL,
  amount_micros  BIGINT NOT NULL,
  result_count   INTEGER NOT NULL,
  results_hash   TEXT NOT NULL,
  tx_hash        TEXT,
  log_tx_hash    TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE wallet_reputation (
  address        TEXT PRIMARY KEY,
  total_paid_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  tier           TEXT NOT NULL DEFAULT 'bronze',
  multiplier     NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  refreshed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Steps:**

1. Run migration against dev DB
2. Verify all 4 tables exist
3. `git commit -m "feat(worker): add DB migration"`

---

## Task 6: BlockRun — Task Registry

**File:** `src/lib/worker-tasks.ts`

```typescript
export interface WorkerTask {
  id: string;
  type: "http_check";
  url: string;
  expectedStatus: number;
  timeoutMs: number;
  rewardMicros: number;
  region?: string;
}

export const PILOT_TASKS: WorkerTask[] = [
  {
    id: "task_br_health",
    type: "http_check",
    url: "https://blockrun.ai/api/health",
    expectedStatus: 200,
    timeoutMs: 10_000,
    rewardMicros: 100,
  },
  {
    id: "task_br_models",
    type: "http_check",
    url: "https://blockrun.ai/api/v1/models",
    expectedStatus: 200,
    timeoutMs: 10_000,
    rewardMicros: 100,
  },
  {
    id: "task_base_rpc",
    type: "http_check",
    url: "https://mainnet.base.org",
    expectedStatus: 200,
    timeoutMs: 10_000,
    rewardMicros: 150,
  },
];

// Track recent assignments: taskId → [{ workerAddress, assignedAt }]
// Each task assigned to up to 3 workers per cycle. First to submit wins.
const assignments = new Map<string, Array<{ workerAddress: string; assignedAt: number }>>();
const CYCLE_MS = 30_000;
const MAX_PER_TASK = 3;

export function getTasksForWorker(workerAddress: string, _region?: string): WorkerTask[] {
  const now = Date.now();
  const addr = workerAddress.toLowerCase();

  return PILOT_TASKS.filter((task) => {
    const list = assignments.get(task.id) ?? [];
    const fresh = list.filter((a) => now - a.assignedAt < CYCLE_MS);
    assignments.set(task.id, fresh);

    if (fresh.some((a) => a.workerAddress === addr)) return false;
    if (fresh.length >= MAX_PER_TASK) return false;
    return true;
  });
}

export function markAssigned(taskIds: string[], workerAddress: string): void {
  const addr = workerAddress.toLowerCase();
  const now = Date.now();
  for (const id of taskIds) {
    const list = assignments.get(id) ?? [];
    list.push({ workerAddress: addr, assignedAt: now });
    assignments.set(id, list);
  }
}

export function getTaskById(taskId: string): WorkerTask | undefined {
  return PILOT_TASKS.find((t) => t.id === taskId);
}
```

**Steps:**

1. Create `src/lib/worker-tasks.ts`
2. `npx tsc --noEmit`
3. `git commit -m "feat(worker): task registry with 3-worker redundancy"`

---

## Task 7: BlockRun — Credit Ledger

**File:** `src/lib/worker-credits.ts`

```typescript
import { db } from "@/lib/db"; // your DB client — swap for actual import
import { getReputationMultiplier } from "./worker-reputation";

const PAYOUT_THRESHOLD_MICROS = 10_000; // $0.01

export async function creditWorker(
  workerAddress: string,
  baseRewardMicros: number,
): Promise<{ pendingMicros: number; thresholdReached: boolean }> {
  const multiplier = await getReputationMultiplier(workerAddress);
  const earned = Math.floor(baseRewardMicros * multiplier);

  // Atomic upsert — safe for concurrent Cloud Run instances
  const result = await db.query<{ pending_micros: number }>(
    `
    INSERT INTO worker_credits (address, pending_micros, total_earned, updated_at)
    VALUES ($1, $2, $2, NOW())
    ON CONFLICT (address) DO UPDATE SET
      pending_micros = worker_credits.pending_micros + $2,
      total_earned   = worker_credits.total_earned + $2,
      updated_at     = NOW()
    RETURNING pending_micros
  `,
    [workerAddress.toLowerCase(), earned],
  );

  const pendingMicros = result.rows[0].pending_micros;
  return {
    pendingMicros,
    thresholdReached: pendingMicros >= PAYOUT_THRESHOLD_MICROS,
  };
}

export async function resetPendingCredits(
  workerAddress: string,
  payoutId: string,
  amountMicros: number,
  txHash: string,
): Promise<void> {
  await db.query(
    `
    UPDATE worker_credits SET
      pending_micros = pending_micros - $2,
      total_paid     = total_paid + $2,
      last_payout_at = NOW(),
      last_payout_tx = $3,
      updated_at     = NOW()
    WHERE address = $1
  `,
    [workerAddress.toLowerCase(), amountMicros, txHash],
  );
}

export async function getPendingMicros(workerAddress: string): Promise<number> {
  const result = await db.query<{ pending_micros: number }>(
    `SELECT pending_micros FROM worker_credits WHERE address = $1`,
    [workerAddress.toLowerCase()],
  );
  return result.rows[0]?.pending_micros ?? 0;
}
```

**Steps:**

1. Create `src/lib/worker-credits.ts`
2. Wire your actual DB client at `@/lib/db` (swap the import)
3. `npx tsc --noEmit`
4. `git commit -m "feat(worker): credit ledger with atomic upsert"`

---

## Task 8: BlockRun — Reputation Module

**File:** `src/lib/worker-reputation.ts`

```typescript
import { db } from "@/lib/db";

const TIERS = [
  { tier: "platinum", minPaid: 200, multiplier: 2.0 },
  { tier: "gold", minPaid: 50, multiplier: 1.5 },
  { tier: "silver", minPaid: 10, multiplier: 1.2 },
  { tier: "bronze", minPaid: 0, multiplier: 1.0 },
] as const;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // refresh daily

export async function getReputationMultiplier(workerAddress: string): Promise<number> {
  const rep = await getReputation(workerAddress);
  return rep.multiplier;
}

export async function getReputation(workerAddress: string): Promise<{
  tier: string;
  totalPaidUsd: number;
  multiplier: number;
}> {
  const addr = workerAddress.toLowerCase();

  const cached = await db.query<{
    tier: string;
    total_paid_usd: number;
    multiplier: number;
    refreshed_at: Date;
  }>(
    `SELECT tier, total_paid_usd, multiplier, refreshed_at
     FROM wallet_reputation WHERE address = $1`,
    [addr],
  );

  if (cached.rows.length > 0) {
    const row = cached.rows[0];
    const age = Date.now() - new Date(row.refreshed_at).getTime();
    if (age < CACHE_TTL_MS) {
      return {
        tier: row.tier,
        totalPaidUsd: Number(row.total_paid_usd),
        multiplier: Number(row.multiplier),
      };
    }
  }

  // Cache miss or stale — recompute from GCS logs
  // NOTE: In production this should be a background job, not per-request
  const totalPaidUsd = await computeTotalPaidFromGCS(addr);
  const tierEntry = TIERS.find((t) => totalPaidUsd >= t.minPaid) ?? TIERS[TIERS.length - 1];

  await db.query(
    `
    INSERT INTO wallet_reputation (address, total_paid_usd, tier, multiplier, refreshed_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (address) DO UPDATE SET
      total_paid_usd = $2, tier = $3, multiplier = $4, refreshed_at = NOW()
  `,
    [addr, totalPaidUsd, tierEntry.tier, tierEntry.multiplier],
  );

  return { tier: tierEntry.tier, totalPaidUsd, multiplier: tierEntry.multiplier };
}

// Aggregate total USDC paid by this wallet from GCS LLM call logs
// This reads BlockRun's own data — no third-party reputation service needed
async function computeTotalPaidFromGCS(walletAddress: string): Promise<number> {
  // TODO (V2): read gs://blockrun-prod-2026-logs/llm-calls/YYYY-MM-DD.jsonl
  // Filter by wallet, sum cost field
  // Pilot: return 0 (all workers start at Bronze)
  return 0;
}
```

**Steps:**

1. Create `src/lib/worker-reputation.ts`
2. `computeTotalPaidFromGCS` is a stub for pilot — implement GCS aggregation in V2
3. `git commit -m "feat(worker): reputation module with daily cache"`

---

## Task 9: BlockRun — Payout Module

**File:** `src/lib/worker-payouts.ts`

```typescript
import { createHash } from "crypto";
import { createWalletClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount, signTypedData } from "viem/accounts";
import { getCurrentNetworkConfig } from "./network-config";
import { settlePaymentWithRetry } from "./x402";
import { db } from "@/lib/db";
import { resetPendingCredits } from "./worker-credits";

const PAYOUT_THRESHOLD_MICROS = 10_000;

export async function tryPayout(
  workerAddress: string,
  pendingMicros: number,
  resultIds: string[],
): Promise<{ paid: boolean; txHash?: string; logTxHash?: string }> {
  if (pendingMicros < PAYOUT_THRESHOLD_MICROS) return { paid: false };

  const payoutKey = process.env.WORKER_PAYOUT_WALLET_KEY;
  if (!payoutKey?.startsWith("0x")) throw new Error("WORKER_PAYOUT_WALLET_KEY not set");

  const networkConfig = getCurrentNetworkConfig();
  const payoutAccount = privateKeyToAccount(payoutKey as `0x${string}`);

  // 1. Insert payout record (pending)
  const resultsHash = createHash("sha256").update(resultIds.sort().join(",")).digest("hex");
  const payoutResult = await db.query<{ id: string }>(
    `
    INSERT INTO worker_payouts (worker_address, amount_micros, result_count, results_hash, status)
    VALUES ($1, $2, $3, $4, 'pending')
    RETURNING id
  `,
    [workerAddress.toLowerCase(), pendingMicros, resultIds.length, resultsHash],
  );
  const payoutId = payoutResult.rows[0].id;

  // 2. Sign TransferWithAuthorization: BlockRun treasury → worker
  const validAfter = BigInt(0);
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = `0x${Buffer.from(nonceBytes).toString("hex")}` as `0x${string}`;

  const signature = await signTypedData({
    privateKey: payoutKey as `0x${string}`,
    domain: {
      name: networkConfig.usdcDomainName,
      version: "2",
      chainId: networkConfig.chainId,
      verifyingContract: networkConfig.usdc,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: payoutAccount.address,
      to: workerAddress as `0x${string}`,
      value: BigInt(pendingMicros),
      validAfter,
      validBefore,
      nonce,
    },
  });

  // 3. Build x402 payment payload (same format as incoming payments)
  const paymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network: networkConfig.network,
    payload: {
      signature,
      authorization: {
        from: payoutAccount.address,
        to: workerAddress,
        value: String(pendingMicros),
        validAfter: String(validAfter),
        validBefore: String(validBefore),
        nonce,
      },
    },
  };
  const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

  const requirements = {
    scheme: "exact",
    network: networkConfig.network,
    maxAmountRequired: String(pendingMicros),
    resource: `worker-payout:${workerAddress}`,
    description: "Worker node payout",
    mimeType: "application/json",
    payTo: workerAddress,
    maxTimeoutSeconds: 3600,
    asset: networkConfig.usdc,
    outputSchema: null,
    extra: null,
  };

  // 4. Settle USDC transfer via CDP facilitator
  const settled = await settlePaymentWithRetry(paymentHeader, requirements as never);
  if (!settled.success) throw new Error(`Settlement failed: ${settled.error}`);

  const txHash = settled.txHash!;

  // 5. Write calldata log tx to Base (audit trail — failure does NOT block payout)
  const logTxHash = await writeCalldataLog({
    workerAddress,
    amountMicros: pendingMicros,
    resultCount: resultIds.length,
    resultsHash,
    payoutId,
    payoutTxHash: txHash,
    payoutKey,
    networkConfig,
  });

  // 6. Update DB: mark payout confirmed, reset credits, mark results paid
  await Promise.all([
    db.query(
      `UPDATE worker_payouts SET status='confirmed', tx_hash=$1, log_tx_hash=$2 WHERE id=$3`,
      [txHash, logTxHash, payoutId],
    ),
    resetPendingCredits(workerAddress, payoutId, pendingMicros, txHash),
    db.query(`UPDATE worker_results SET paid=TRUE, payout_id=$1 WHERE id = ANY($2::uuid[])`, [
      payoutId,
      resultIds,
    ]),
  ]);

  return { paid: true, txHash, logTxHash };
}

async function writeCalldataLog(params: {
  workerAddress: string;
  amountMicros: number;
  resultCount: number;
  resultsHash: string;
  payoutId: string;
  payoutTxHash: string;
  payoutKey: string;
  networkConfig: ReturnType<typeof getCurrentNetworkConfig>;
}): Promise<string | undefined> {
  const logAddress = process.env.BLOCKRUN_LOG_ADDRESS as `0x${string}` | undefined;
  if (!logAddress) return undefined;

  try {
    const chain = params.networkConfig.network === "eip155:8453" ? base : baseSepolia;
    const account = privateKeyToAccount(params.payoutKey as `0x${string}`);

    const walletClient = createWalletClient({ account, chain, transport: http() });

    const data = Buffer.from(
      JSON.stringify({
        v: 1,
        type: "worker_payout",
        worker: params.workerAddress,
        amountMicros: params.amountMicros,
        resultCount: params.resultCount,
        resultsHash: params.resultsHash,
        payoutId: params.payoutId,
        payoutTxHash: params.payoutTxHash,
        ts: Date.now(),
      }),
    ).toString("hex");

    return await walletClient.sendTransaction({
      to: logAddress,
      value: BigInt(0),
      data: `0x${data}` as `0x${string}`,
    });
  } catch (err) {
    console.error("[Worker Payout] calldata log tx failed:", err);
    return undefined;
  }
}
```

**Steps:**

1. Create `src/lib/worker-payouts.ts`
2. Check `network-config.ts` — add `chainId: 8453 / 84532` if missing
3. `npx tsc --noEmit`
4. `git commit -m "feat(worker): payout module with x402 + calldata audit log"`

---

## Task 10: BlockRun — GET /api/v1/worker/tasks

**File:** `src/app/api/v1/worker/tasks/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getTasksForWorker, markAssigned } from "@/lib/worker-tasks";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");
  const region = searchParams.get("region") ?? undefined;

  if (!address?.startsWith("0x")) {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }

  const tasks = getTasksForWorker(address, region);
  markAssigned(
    tasks.map((t) => t.id),
    address,
  );

  return NextResponse.json(tasks);
}
```

**Steps:**

1. `mkdir -p src/app/api/v1/worker/tasks && touch route.ts`
2. Test: `curl "http://localhost:3000/api/v1/worker/tasks?address=0x000..."`
3. Expect: JSON array with up to 3 pilot tasks
4. `git commit -m "feat(worker): GET /api/v1/worker/tasks"`

---

## Task 11: BlockRun — POST /api/v1/worker/results

**File:** `src/app/api/v1/worker/results/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { recoverMessageAddress } from "viem";
import { getTaskById } from "@/lib/worker-tasks";
import { creditWorker } from "@/lib/worker-credits";
import { tryPayout } from "@/lib/worker-payouts";
import { db } from "@/lib/db";

export const runtime = "nodejs";

interface WorkerResult {
  taskId: string;
  workerAddress: string;
  timestamp: number;
  success: boolean;
  responseTimeMs: number;
  statusCode?: number;
  error?: string;
  signature: string;
}

export async function POST(request: NextRequest) {
  let results: WorkerResult[];
  try {
    results = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(results) || results.length === 0 || results.length > 50) {
    return NextResponse.json({ error: "results must be array of 1–50" }, { status: 400 });
  }

  let accepted = 0;
  let totalEarnedMicros = 0;
  const errors: string[] = [];
  const acceptedResultIds: string[] = [];

  for (const result of results) {
    try {
      const task = getTaskById(result.taskId);
      if (!task) {
        errors.push(`${result.taskId}: unknown task`);
        continue;
      }

      // Verify EIP-191 signature
      const message = JSON.stringify({
        taskId: result.taskId,
        workerAddress: result.workerAddress,
        timestamp: result.timestamp,
        success: result.success,
      });
      const recovered = await recoverMessageAddress({
        message,
        signature: result.signature as `0x${string}`,
      });
      if (recovered.toLowerCase() !== result.workerAddress.toLowerCase()) {
        errors.push(`${result.taskId}: invalid signature`);
        continue;
      }

      // Freshness check (5 min max)
      if (Date.now() - result.timestamp > 5 * 60 * 1000) {
        errors.push(`${result.taskId}: result too old`);
        continue;
      }

      // Write result to DB
      const insertResult = await db.query<{ id: string }>(
        `
        INSERT INTO worker_results
          (task_id, worker_address, timestamp, success, response_time_ms, status_code, reward_micros)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `,
        [
          result.taskId,
          result.workerAddress.toLowerCase(),
          result.timestamp,
          result.success,
          result.responseTimeMs,
          result.statusCode ?? null,
          task.rewardMicros,
        ],
      );
      acceptedResultIds.push(insertResult.rows[0].id);

      // Credit worker (with reputation multiplier)
      const { pendingMicros, thresholdReached } = await creditWorker(
        result.workerAddress,
        task.rewardMicros,
      );

      // Trigger payout if threshold reached (fire and forget)
      if (thresholdReached) {
        tryPayout(result.workerAddress, pendingMicros, acceptedResultIds).catch((err) =>
          console.error(`[Worker Payout] failed for ${result.workerAddress}:`, err),
        );
      }

      accepted++;
      totalEarnedMicros += task.rewardMicros;
    } catch (err) {
      errors.push(`${result.taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return NextResponse.json({
    accepted,
    earned: (totalEarnedMicros / 1_000_000).toFixed(6),
    errors: errors.length > 0 ? errors : undefined,
  });
}
```

**Steps:**

1. `mkdir -p src/app/api/v1/worker/results && touch route.ts`
2. `npx tsc --noEmit`
3. `git commit -m "feat(worker): POST /api/v1/worker/results with sig verify, DB write, payout trigger"`

---

## End-to-End Test

```bash
# 1. Start BlockRun locally
cd /Users/vickyfu/Documents/blockrun-web/blockrun
pnpm dev

# 2. Verify tasks endpoint
curl "http://localhost:3000/api/v1/worker/tasks?address=0x0000000000000000000000000000000000000001"
# → JSON array with 3 tasks

# 3. Start ClawRouter in worker mode (pointed at localhost)
cd /Users/vickyfu/Documents/blockrun-web/ClawRouter
CLAWROUTER_WORKER=1 BLOCKRUN_API_BASE=http://localhost:3000/api npx openclaw gateway start

# 4. Watch for logs:
# [Worker] Starting — 0x... region=unknown
# [Worker] Executing 3 task(s)
# [Worker] ✓ 3 result(s) accepted, earned $0.000300 USDC

# 5. Check DB: worker_results and worker_credits tables populated
# 6. At $0.01 threshold (~100 checks): worker_payouts row created, USDC transferred
# 7. Check Base explorer: calldata log tx visible on BLOCKRUN_LOG_ADDRESS
```
