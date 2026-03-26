# Worker Network Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let ClawRouter users opt in as worker nodes that execute HTTP health checks and earn USDC micropayments via x402.

**Architecture:** ClawRouter polls BlockRun for tasks every 30s, executes HTTP checks, signs results with its existing wallet key, and submits to BlockRun. BlockRun verifies the signature, accumulates credits per worker, and pays out via x402 (TransferWithAuthorization with `payTo = worker address`) when credits hit a $0.01 threshold.

**Tech Stack:** viem (signing), x402 (payment), existing CDP facilitator (settlement), in-memory task queue (pilot)

---

## Design Decisions (from architecture discussion)

### Verification: Trust-based (no consensus needed)

Workers are existing paying ClawRouter users. The actual work (one HTTP fetch) is cheaper than writing cheating code. Reward is $0.0001 — no rational incentive to fabricate. Simple signature proves identity; that's enough.

### Payment: x402 with reversed payTo

x402 is EIP-3009 TransferWithAuthorization. For worker payouts, BlockRun signs as the payer:

- `from: WORKER_PAYOUT_WALLET` (BlockRun treasury)
- `to: workerAddress`
- `value: accumulatedMicros`

BlockRun calls the existing CDP facilitator `/settle` endpoint. No new payment infrastructure needed.

### Payout batching (gas efficiency)

Do NOT pay $0.0001 per check immediately. Accumulate per worker, pay when ≥ $0.01 (100 checks). Base L2 gas ≈ $0.0001/tx → gas overhead = 1%. Acceptable.

### Task assignment

With 1000 workers and N tasks, each task is assigned to at most 1 worker per 30s cycle. Simple approach: return tasks that haven't been assigned to THIS worker in the last 5 minutes. Workers in different regions naturally get different results.

---

## Cost Model

### Pilot (3 tasks, 30s interval)

```
Checks/day:     3 tasks × 2,880 cycles = 8,640 checks
Worker cost:    8,640 × $0.0001        = $0.864/day  ≈ $26/month
Gas (batched):  ~87 payouts × $0.0001  = $0.009/day  ≈ $0.27/month
Total:          ~$26/month from treasury
```

### Scale (1,000 tasks, buyers paying)

```
Worker cost:    1,000 × 2,880 × $0.0001 = $288/day
Buyer price:    $0.00011/check (10% margin)
Revenue:        1,000 × 2,880 × $0.00011 = $316.8/day
Net margin:     ~$28.8/day on worker network
```

### Worker earnings

```
1,000 workers, 1,000 tasks (equal distribution):
  Each worker: 1 task/cycle avg
  Daily:       2,880 × $0.0001 = $0.288/day
  Monthly:     ~$8.64/month passive income

Pilot (1,000 workers, 3 tasks):
  Each worker: 0.003 tasks/cycle avg
  Daily:       ~$0.001/day per worker
  → Pilot is about proving the system, not earnings
```

---

## Files

### ClawRouter (new files)

| File                   | Action                                                    |
| ---------------------- | --------------------------------------------------------- |
| `src/worker/types.ts`  | CREATE                                                    |
| `src/worker/checks.ts` | CREATE                                                    |
| `src/worker/index.ts`  | CREATE                                                    |
| `src/index.ts`         | MODIFY — add worker startup in `startProxyInBackground()` |

### BlockRun (new files)

| File                                     | Action |
| ---------------------------------------- | ------ |
| `src/lib/worker-tasks.ts`                | CREATE |
| `src/lib/worker-payouts.ts`              | CREATE |
| `src/app/api/v1/worker/tasks/route.ts`   | CREATE |
| `src/app/api/v1/worker/results/route.ts` | CREATE |

### BlockRun: add health endpoint (needed for self-verification)

| File                          | Action                           |
| ----------------------------- | -------------------------------- |
| `src/app/api/health/route.ts` | CHECK if exists — if not, CREATE |

---

## Task 1: ClawRouter — Worker Types

**Files:**

- Create: `src/worker/types.ts`

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

**Step 1:** Create `src/worker/` directory and `types.ts` with content above.

**Step 2:** Commit

```bash
git add src/worker/types.ts
git commit -m "feat(worker): add worker network types"
```

---

## Task 2: ClawRouter — HTTP Check Executor

**Files:**

- Create: `src/worker/checks.ts`

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
    const response = await fetch(task.url, {
      method: "GET",
      signal: AbortSignal.timeout(task.timeoutMs),
      redirect: "follow",
      headers: { "User-Agent": "BlockRun-Worker/1.0" },
    });
    return {
      success: response.status === task.expectedStatus,
      responseTimeMs: Date.now() - start,
      statusCode: response.status,
    };
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      success: false,
      responseTimeMs: Date.now() - start,
      error: isTimeout
        ? `Timeout after ${task.timeoutMs}ms`
        : String(err instanceof Error ? err.message : err),
    };
  }
}

// Both sides must produce identical JSON for signature verification
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

**Step 1:** Create `src/worker/checks.ts` with content above.

**Step 2:** Commit

```bash
git add src/worker/checks.ts
git commit -m "feat(worker): add HTTP check executor"
```

---

## Task 3: ClawRouter — WorkerNode Class

**Files:**

- Create: `src/worker/index.ts`

Key imports needed: `privateKeyToAccount` from `viem/accounts` (already a dependency).

```typescript
import { privateKeyToAccount } from "viem/accounts";
import type { WorkerTask, WorkerResult, WorkerStatus } from "./types.js";
import { executeHttpCheck, buildSignableMessage } from "./checks.js";

const BLOCKRUN_API = "https://blockrun.ai/api";
const POLL_INTERVAL_MS = 30_000;
const MAX_CONCURRENT_CHECKS = 10;
const REGION = process.env.WORKER_REGION || "unknown";

export class WorkerNode {
  private address: string;
  private privateKey: `0x${string}`;
  private apiBase: string;
  private status: WorkerStatus;
  private pollTimer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(walletKey: string, walletAddress: string, apiBase = BLOCKRUN_API) {
    this.privateKey = walletKey as `0x${string}`;
    this.address = walletAddress;
    this.apiBase = apiBase;
    this.status = {
      address: walletAddress,
      completedTasks: 0,
      totalEarnedMicros: 0,
      busy: false,
    };
  }

  startPolling(): void {
    console.log(`[Worker] Starting — address: ${this.address}, region: ${REGION}`);
    // Run immediately, then on interval
    this.poll().catch(console.error);
    this.pollTimer = setInterval(() => {
      this.poll().catch(console.error);
    }, POLL_INTERVAL_MS);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  getStatus(): WorkerStatus {
    return { ...this.status, busy: this.busy };
  }

  private async poll(): Promise<void> {
    if (this.busy) return; // skip cycle if still executing

    let tasks: WorkerTask[] = [];
    try {
      tasks = await this.fetchTasks();
    } catch (err) {
      console.error(`[Worker] Failed to fetch tasks:`, err instanceof Error ? err.message : err);
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
    if (!res.ok) {
      throw new Error(`Tasks endpoint returned ${res.status}`);
    }
    return res.json() as Promise<WorkerTask[]>;
  }

  private async executeBatch(tasks: WorkerTask[]): Promise<WorkerResult[]> {
    // Cap concurrency at MAX_CONCURRENT_CHECKS
    const chunks: WorkerTask[][] = [];
    for (let i = 0; i < tasks.length; i += MAX_CONCURRENT_CHECKS) {
      chunks.push(tasks.slice(i, i + MAX_CONCURRENT_CHECKS));
    }

    const results: WorkerResult[] = [];
    for (const chunk of chunks) {
      const chunkResults = await Promise.all(chunk.map((task) => this.executeAndSign(task)));
      results.push(...chunkResults);
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

    return {
      taskId: task.id,
      workerAddress: this.address,
      timestamp,
      ...check,
      signature,
    };
  }

  private async submitResults(results: WorkerResult[]): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/v1/worker/results`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "BlockRun-Worker/1.0",
        },
        body: JSON.stringify(results),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        console.error(`[Worker] Results submission failed: ${res.status}`);
        return;
      }

      const data = (await res.json()) as { accepted: number; earned: string };
      this.status.completedTasks += data.accepted;
      console.log(`[Worker] Submitted ${data.accepted} result(s), earned: $${data.earned} USDC`);
    } catch (err) {
      console.error(`[Worker] Failed to submit results:`, err instanceof Error ? err.message : err);
    }
  }
}
```

**Step 1:** Create `src/worker/index.ts` with content above.

**Step 2:** Verify TypeScript compiles

```bash
cd /Users/vickyfu/Documents/blockrun-web/ClawRouter
npx tsc --noEmit
```

Expected: no errors in worker files.

**Step 3:** Commit

```bash
git add src/worker/index.ts
git commit -m "feat(worker): add WorkerNode class with polling and signing"
```

---

## Task 4: ClawRouter — Wire Worker Mode in index.ts

**Files:**

- Modify: `src/index.ts` — inside `startProxyInBackground()`, after `setActiveProxy(proxy)`

Find this line in `startProxyInBackground()` (~line 423):

```typescript
setActiveProxy(proxy);
activeProxyHandle = proxy;
```

Add immediately after:

```typescript
// Worker mode: opt-in via CLAWROUTER_WORKER=1 or --worker flag
const workerMode = process.env.CLAWROUTER_WORKER === "1" || process.argv.includes("--worker");

if (workerMode) {
  const { WorkerNode } = await import("./worker/index.js");
  const worker = new WorkerNode(walletKey, address);
  worker.startPolling();
  api.logger.info(`[Worker] Mode active — polling for tasks every 30s`);
  api.logger.info(`[Worker] Wallet: ${address}`);
}
```

**Step 1:** Apply the edit above to `src/index.ts`.

**Step 2:** Verify TypeScript compiles

```bash
npx tsc --noEmit
```

**Step 3:** Commit

```bash
git add src/index.ts
git commit -m "feat(worker): activate WorkerNode when CLAWROUTER_WORKER=1"
```

---

## Task 5: BlockRun — Worker Task Registry

**Files:**

- Create: `src/lib/worker-tasks.ts`

```typescript
import type { WorkerTask } from "./worker-types";

// Re-export types so routes can import from one place
export type { WorkerTask };

export interface WorkerTask {
  id: string;
  type: "http_check";
  url: string;
  expectedStatus: number;
  timeoutMs: number;
  rewardMicros: number;
  region?: string;
}

// Pilot seed tasks — BlockRun-owned endpoints, verifiable and real
export const PILOT_TASKS: WorkerTask[] = [
  {
    id: "task_br_health",
    type: "http_check",
    url: "https://blockrun.ai/api/health",
    expectedStatus: 200,
    timeoutMs: 10_000,
    rewardMicros: 100, // $0.0001
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
    rewardMicros: 150, // slightly higher for third-party
  },
];

// Track last assignment: taskId → { workerAddress, assignedAt }
const lastAssignments = new Map<string, { workerAddress: string; assignedAt: number }>();

// How long before a task can be reassigned to the same worker
const REASSIGN_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Return tasks that haven't been assigned to this worker recently.
 * This ensures different workers get different tasks, providing geographic diversity.
 */
export function getTasksForWorker(workerAddress: string, _region?: string): WorkerTask[] {
  const now = Date.now();
  const address = workerAddress.toLowerCase();

  return PILOT_TASKS.filter((task) => {
    const last = lastAssignments.get(task.id);
    if (!last) return true; // never assigned
    // Reassign if cooldown expired OR it was assigned to a different worker
    if (now - last.assignedAt > REASSIGN_COOLDOWN_MS) return true;
    if (last.workerAddress !== address) return true;
    return false;
  });
}

/**
 * Mark tasks as assigned to a worker (called when GET /tasks responds).
 */
export function markTasksAssigned(taskIds: string[], workerAddress: string): void {
  const now = Date.now();
  const address = workerAddress.toLowerCase();
  for (const id of taskIds) {
    lastAssignments.set(id, { workerAddress: address, assignedAt: now });
  }
}

/**
 * Look up a task by ID.
 */
export function getTaskById(taskId: string): WorkerTask | undefined {
  return PILOT_TASKS.find((t) => t.id === taskId);
}
```

**Step 1:** Create `src/lib/worker-tasks.ts` with content above.

**Step 2:** Commit

```bash
cd /Users/vickyfu/Documents/blockrun-web/blockrun
git add src/lib/worker-tasks.ts
git commit -m "feat(worker): add task registry with pilot seed tasks"
```

---

## Task 6: BlockRun — Worker Payout Module

**Files:**

- Create: `src/lib/worker-payouts.ts`

This module accumulates credits per worker and triggers x402-style USDC payouts when threshold is reached. Uses the same EIP-3009 signing infrastructure as the rest of BlockRun.

```typescript
import { signTypedData, privateKeyToAccount } from "viem/accounts";
import { getCurrentNetworkConfig } from "./network-config";
import { settlePaymentWithRetry } from "./x402";

// Minimum payout threshold — accumulate before paying to save gas
const PAYOUT_THRESHOLD_MICROS = 10_000; // $0.01

// In-memory credit ledger: workerAddress → accumulatedMicros
const credits = new Map<string, number>();

/**
 * Add earned micros for a worker. Triggers payout if threshold reached.
 * Returns the amount paid out (0 if threshold not yet reached).
 */
export async function creditWorker(
  workerAddress: string,
  earnedMicros: number,
): Promise<{ paid: number; txHash?: string }> {
  const address = workerAddress.toLowerCase();
  const current = credits.get(address) ?? 0;
  const newTotal = current + earnedMicros;
  credits.set(address, newTotal);

  if (newTotal < PAYOUT_THRESHOLD_MICROS) {
    return { paid: 0 };
  }

  // Threshold reached — trigger payout
  credits.set(address, 0); // reset before async to avoid double-pay

  try {
    const result = await sendUsdcToWorker(workerAddress as `0x${string}`, newTotal);
    console.log(
      `[Worker Payout] Sent ${newTotal} micros ($${(newTotal / 1_000_000).toFixed(6)}) to ${workerAddress}`,
    );
    return { paid: newTotal, txHash: result.txHash };
  } catch (err) {
    // Restore credits on failure — worker doesn't lose their earnings
    credits.set(address, newTotal);
    console.error(`[Worker Payout] Failed to pay ${workerAddress}:`, err);
    throw err;
  }
}

/**
 * Get pending (not yet paid) credits for a worker.
 */
export function getPendingCredits(workerAddress: string): number {
  return credits.get(workerAddress.toLowerCase()) ?? 0;
}

/**
 * Send USDC from BlockRun payout wallet to worker.
 * Uses same EIP-3009 TransferWithAuthorization as x402, but BlockRun is the payer.
 */
async function sendUsdcToWorker(
  workerAddress: `0x${string}`,
  amountMicros: number,
): Promise<{ txHash?: string }> {
  const payoutKey = process.env.WORKER_PAYOUT_WALLET_KEY;

  if (!payoutKey || !payoutKey.startsWith("0x")) {
    throw new Error("WORKER_PAYOUT_WALLET_KEY not configured");
  }

  const networkConfig = getCurrentNetworkConfig();
  const payoutAccount = privateKeyToAccount(payoutKey as `0x${string}`);

  const validAfter = BigInt(0);
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = `0x${Buffer.from(nonceBytes).toString("hex")}` as `0x${string}`;

  // Sign TransferWithAuthorization: BlockRun treasury → worker
  // Same scheme as ClawRouter's x402.ts but payTo = worker address
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
      to: workerAddress,
      value: BigInt(amountMicros),
      validAfter,
      validBefore,
      nonce,
    },
  });

  // Build payment requirements for CDP facilitator (same shape as incoming payments)
  const requirements = {
    scheme: "exact",
    network: networkConfig.network,
    maxAmountRequired: String(amountMicros),
    resource: `worker-payout:${workerAddress}`,
    description: "Worker node payout",
    mimeType: "application/json",
    payTo: workerAddress,
    maxTimeoutSeconds: 3600,
    asset: networkConfig.usdc,
    outputSchema: null,
    extra: null,
  };

  // Build payment header in x402 format
  const paymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network: networkConfig.network,
    payload: {
      signature,
      authorization: {
        from: payoutAccount.address,
        to: workerAddress,
        value: String(amountMicros),
        validAfter: String(validAfter),
        validBefore: String(validBefore),
        nonce,
      },
    },
  };
  const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

  const result = await settlePaymentWithRetry(paymentHeader, requirements as never);

  if (!result.success) {
    throw new Error(`Settlement failed: ${result.error}`);
  }

  return { txHash: result.txHash };
}
```

**Note on `networkConfig.chainId`:** Check `src/lib/network-config.ts` — if `chainId` is not in the `NetworkConfig` type, add it: mainnet = 8453, testnet = 84532.

**Step 1:** Check network-config.ts for `chainId` field. If missing, add it.

**Step 2:** Create `src/lib/worker-payouts.ts` with content above.

**Step 3:** Verify TypeScript

```bash
npx tsc --noEmit 2>&1 | grep worker
```

**Step 4:** Commit

```bash
git add src/lib/worker-payouts.ts src/lib/network-config.ts
git commit -m "feat(worker): add payout module with batched x402 USDC transfers"
```

---

## Task 7: BlockRun — GET /api/v1/worker/tasks

**Files:**

- Create: `src/app/api/v1/worker/tasks/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getTasksForWorker, markTasksAssigned } from "@/lib/worker-tasks";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");
  const region = searchParams.get("region") ?? undefined;

  if (!address || !address.startsWith("0x")) {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }

  const tasks = getTasksForWorker(address, region);
  markTasksAssigned(
    tasks.map((t) => t.id),
    address,
  );

  return NextResponse.json(tasks);
}
```

**Step 1:** Create directory `src/app/api/v1/worker/tasks/` and `route.ts` with content above.

**Step 2:** Test manually

```bash
curl "http://localhost:3000/api/v1/worker/tasks?address=0x1234567890123456789012345678901234567890"
```

Expected: JSON array with 3 pilot tasks.

**Step 3:** Commit

```bash
git add src/app/api/v1/worker/tasks/route.ts
git commit -m "feat(worker): add GET /api/v1/worker/tasks endpoint"
```

---

## Task 8: BlockRun — POST /api/v1/worker/results

**Files:**

- Create: `src/app/api/v1/worker/results/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { recoverMessageAddress } from "viem";
import { getTaskById } from "@/lib/worker-tasks";
import { creditWorker } from "@/lib/worker-payouts";
import { logWorkerResult } from "@/lib/gcs-logger";

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

  if (!Array.isArray(results) || results.length === 0) {
    return NextResponse.json({ error: "results must be non-empty array" }, { status: 400 });
  }

  // Cap batch size
  if (results.length > 50) {
    return NextResponse.json({ error: "max 50 results per batch" }, { status: 400 });
  }

  let accepted = 0;
  let totalEarnedMicros = 0;
  const errors: string[] = [];

  for (const result of results) {
    try {
      // 1. Look up task
      const task = getTaskById(result.taskId);
      if (!task) {
        errors.push(`${result.taskId}: unknown task`);
        continue;
      }

      // 2. Verify EIP-191 signature
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

      // 3. Sanity checks
      const age = Date.now() - result.timestamp;
      if (age > 5 * 60 * 1000) {
        errors.push(`${result.taskId}: result too old (${Math.round(age / 1000)}s)`);
        continue;
      }

      // 4. Log to GCS (fire and forget)
      logWorkerResult({
        taskId: result.taskId,
        workerAddress: result.workerAddress,
        timestamp: result.timestamp,
        success: result.success,
        responseTimeMs: result.responseTimeMs,
        statusCode: result.statusCode,
        rewardMicros: task.rewardMicros,
      }).catch(console.error);

      // 5. Credit worker — triggers payout if threshold reached
      await creditWorker(result.workerAddress, task.rewardMicros);

      accepted++;
      totalEarnedMicros += task.rewardMicros;
    } catch (err) {
      errors.push(`${result.taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return NextResponse.json({
    accepted,
    earned: (totalEarnedMicros / 1_000_000).toFixed(6), // in USDC
    errors: errors.length > 0 ? errors : undefined,
  });
}
```

**Step 1:** Create `src/app/api/v1/worker/results/route.ts` with content above.

**Step 2:** Add `logWorkerResult` to `src/lib/gcs-logger.ts`:

```typescript
export async function logWorkerResult(result: {
  taskId: string;
  workerAddress: string;
  timestamp: number;
  success: boolean;
  responseTimeMs: number;
  statusCode?: number;
  rewardMicros: number;
}): Promise<void> {
  const date = new Date(result.timestamp).toISOString().split("T")[0];
  const fileName = `worker-results/${date}/${result.taskId}-${result.timestamp}.json`;
  // Use same GCS write pattern as logLLMCall
  try {
    const file = bucket.file(fileName);
    await file.save(JSON.stringify(result), { contentType: "application/json" });
  } catch {
    // GCS failure should not block payment
  }
}
```

**Step 3:** Verify TypeScript

```bash
npx tsc --noEmit
```

**Step 4:** Commit

```bash
git add src/app/api/v1/worker/results/route.ts src/lib/gcs-logger.ts
git commit -m "feat(worker): add POST /api/v1/worker/results with sig verify and payout"
```

---

## Task 9: Environment Variables

**ClawRouter** (no new env vars needed for basic mode):

```bash
CLAWROUTER_WORKER=1        # opt-in to worker mode
WORKER_REGION=US-West      # optional geographic tag
```

**BlockRun** (add to `.env.local` and Cloud Run secrets):

```bash
WORKER_PAYOUT_WALLET_KEY=0x...   # treasury key for paying workers
```

**Step 1:** Add `WORKER_PAYOUT_WALLET_KEY` to BlockRun's `.env.local.example` (never commit real key).

**Step 2:** Document in BlockRun's README or deployment notes.

---

## Testing the Pilot End-to-End

**Step 1:** Start BlockRun dev server

```bash
cd /Users/vickyfu/Documents/blockrun-web/blockrun
npm run dev
```

**Step 2:** Verify tasks endpoint

```bash
curl "http://localhost:3000/api/v1/worker/tasks?address=0x0000000000000000000000000000000000000001"
# Expected: [{id: "task_br_health", ...}, ...]
```

**Step 3:** Start ClawRouter in worker mode (pointing at localhost)

```bash
cd /Users/vickyfu/Documents/blockrun-web/ClawRouter
CLAWROUTER_WORKER=1 BLOCKRUN_API_BASE=http://localhost:3000/api npx openclaw gateway start
```

**Note:** `BLOCKRUN_API_BASE` override needs to be wired into `WorkerNode` constructor — add support for this env var.

**Step 4:** Watch logs for

```
[Worker] Starting — address: 0x...
[Worker] Executing 3 task(s)
[Worker] Submitted 3 result(s), earned: $0.000300 USDC
```

**Step 5:** Check BlockRun logs for incoming results and payout trigger at $0.01 threshold.

---

## Open Questions / V2

- Worker registration portal (let users explicitly opt in via UI)
- Buyer dashboard (custom endpoint monitoring)
- Geographic routing (assign tasks by region)
- Slash mechanism if needed at scale (currently not needed)
- `/wallet worker-status` command in ClawRouter to show earnings
