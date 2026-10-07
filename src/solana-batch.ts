/**
 * Solana x402 batch settlement (opt-in).
 *
 * sol.blockrun.ai offers two schemes on Solana mainnet: `exact` (one on-chain
 * USDC transfer per call) and `batch-settlement` (one deposit opens a payment
 * channel, then each call is paid with a signed voucher and the gateway claims
 * vouchers in batches). This module wires the official SDK's `BatchSvmScheme`
 * next to the `exact` scheme, off by default.
 *
 * Safety model. BlockRun's channels are server signed: the channel's on-chain
 * voucher signer is the gateway's operator key, so the operator can claim up to
 * the whole deposit without another signature from this wallet. The SDK refuses
 * that mode unless the operator is trusted explicitly, so:
 *
 *   - nothing happens unless CLAWROUTER_SOLANA_BATCH is on;
 *   - the trusted operator list is empty by default, and an empty list keeps
 *     every call on `exact` (fail closed);
 *   - the escrow cap (`maxDeposit`) equals the configured deposit, so a trusted
 *     operator can never hold more than one deposit;
 *   - every confirmed cumulative this wallet signed is persisted (atomic JSON
 *     writes), and a claim check compares the channel account's on-chain
 *     `settled` watermark with it. Claimed above signed turns batch off for
 *     the process and says so loudly;
 *   - any batch failure pays that request with `exact` instead (see
 *     payment-preauth.ts).
 *
 * No process.env access here (config.ts reads the environment) and no static
 * @solana/kit or @x402/svm import, so loading this module on Base costs nothing.
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import bs58 from "bs58";
import type { x402Client } from "@x402/fetch";
import type { BatchClientSigner, BatchSvmClientConfig } from "@x402/svm/batch-settlement/client";

// The SDK exports the config but not the storage types it names.
type BatchClientChannelStorage = NonNullable<BatchSvmClientConfig["channelStorage"]>;
export type BatchClientChannelRecord = NonNullable<
  Awaited<ReturnType<BatchClientChannelStorage["get"]>>
>;

export const BATCH_SCHEME = "batch-settlement";

/** Owner program of every batch-settlement channel account. */
export const BATCH_CHANNEL_PROGRAM = "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX";

/** Size of a channel account, in bytes. */
export const BATCH_CHANNEL_ACCOUNT_SIZE = 256;

/** Default channel deposit: 1 USDC (6 decimals). */
export const DEFAULT_BATCH_DEPOSIT_MICROS = 1_000_000n;

/** How often a running proxy re-checks what the gateway has claimed. */
export const CLAIM_CHECK_INTERVAL_MS = 10 * 60_000;

export const DEFAULT_CHANNEL_STORE = path.join(
  homedir(),
  ".openclaw",
  "blockrun",
  "solana-batch-channels.json",
);

const SOLANA_DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

// ─── Config ────────────────────────────────────────────────────────────────

export type SolanaBatchConfig = {
  /**
   * - `off`: not requested (the default)
   * - `on`: requested, valid, and at least one trusted operator
   * - `no-operator`: requested with no trusted operator; stays on `exact`
   * - `invalid`: requested with a value that does not parse; stays on `exact`
   */
  status: "off" | "on" | "no-operator" | "invalid";
  depositMicros: bigint;
  allowedOperators: string[];
  /** Why the status is not `on` or `off`, for the startup log and doctor. */
  message?: string;
};

export type SolanaBatchEnv = {
  CLAWROUTER_SOLANA_BATCH?: string;
  CLAWROUTER_SOLANA_BATCH_DEPOSIT_USDC?: string;
  CLAWROUTER_SOLANA_BATCH_OPERATORS?: string;
};

const TRUTHY = new Set(["1", "true", "on", "yes"]);

/** "1" → 1_000_000n, "0.25" → 250_000n. Undefined for anything else. */
export function parseUsdcToMicros(value: string): bigint | undefined {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) return undefined;
  const micros = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  return micros > 0n ? micros : undefined;
}

export function formatMicrosAsUsd(micros: bigint): string {
  const whole = micros / 1_000_000n;
  const frac = (micros % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

/** A Solana address is base58 for exactly 32 bytes. */
export function isSolanaAddress(value: string): boolean {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

export function parseSolanaBatchConfig(env: SolanaBatchEnv): SolanaBatchConfig {
  const requested = TRUTHY.has((env.CLAWROUTER_SOLANA_BATCH ?? "").trim().toLowerCase());
  const off: SolanaBatchConfig = {
    status: "off",
    depositMicros: DEFAULT_BATCH_DEPOSIT_MICROS,
    allowedOperators: [],
  };
  if (!requested) return off;

  const rawDeposit = env.CLAWROUTER_SOLANA_BATCH_DEPOSIT_USDC?.trim();
  const depositMicros = rawDeposit ? parseUsdcToMicros(rawDeposit) : DEFAULT_BATCH_DEPOSIT_MICROS;
  if (depositMicros === undefined) {
    return {
      ...off,
      status: "invalid",
      message: `CLAWROUTER_SOLANA_BATCH_DEPOSIT_USDC="${rawDeposit}" is not a positive USDC amount (up to 6 decimals)`,
    };
  }

  const operators = [
    ...new Set(
      (env.CLAWROUTER_SOLANA_BATCH_OPERATORS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const bad = operators.filter((op) => !isSolanaAddress(op));
  if (bad.length > 0) {
    return {
      ...off,
      depositMicros,
      status: "invalid",
      message: `CLAWROUTER_SOLANA_BATCH_OPERATORS has invalid Solana address(es): ${bad.join(", ")}`,
    };
  }
  if (operators.length === 0) {
    return {
      ...off,
      depositMicros,
      status: "no-operator",
      message:
        "CLAWROUTER_SOLANA_BATCH is on but CLAWROUTER_SOLANA_BATCH_OPERATORS is empty; paying with exact",
    };
  }
  return { status: "on", depositMicros, allowedOperators: operators };
}

// ─── Durable channel storage ───────────────────────────────────────────────

/**
 * The SDK's channel storage, kept in one JSON file. Every write goes to a temp
 * file first and is renamed into place, so a crash never leaves torn JSON, and
 * writes are serialized so two concurrent payments cannot drop each other's
 * update. A file that exists but does not parse is NOT treated as empty: that
 * would forget the signed cumulative, so reads throw and the payment falls back
 * to `exact` until an operator looks at the file.
 */
export class FileChannelStorage implements BatchClientChannelStorage {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string = DEFAULT_CHANNEL_STORE) {}

  private read(): Record<string, BatchClientChannelRecord> {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`Solana batch channel store ${this.file} is unreadable: ${String(err)}`, {
        cause: err,
      });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Solana batch channel store ${this.file} is not a JSON object`);
    }
    return parsed as Record<string, BatchClientChannelRecord>;
  }

  private write(data: Record<string, BatchClientChannelRecord>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }

  private serialize<T>(op: () => T): Promise<T> {
    const next = this.queue.then(op);
    this.queue = next.catch(() => undefined);
    return next;
  }

  get(key: string): Promise<BatchClientChannelRecord | undefined> {
    return this.serialize(() => this.read()[key]);
  }

  set(key: string, record: BatchClientChannelRecord): Promise<void> {
    return this.serialize(() => {
      const data = this.read();
      data[key] = record;
      this.write(data);
    });
  }

  delete(key: string): Promise<void> {
    return this.serialize(() => {
      const data = this.read();
      if (!(key in data)) return;
      delete data[key];
      this.write(data);
    });
  }

  entries(): Promise<Array<[string, BatchClientChannelRecord]>> {
    return this.serialize(() => Object.entries(this.read()));
  }
}

// ─── Claim check ───────────────────────────────────────────────────────────

export type ChannelAccount = {
  discriminator: number;
  version: number;
  bump: number;
  status: number;
  salt: bigint;
  deposit: bigint;
  /** What the operator has claimed so far (atomic USDC). */
  settled: bigint;
  payoutWatermark: bigint;
};

/** Decode a channel account: u8 disc, version, bump, status, then u64 LE salt, deposit, settled, payout watermark. */
export function decodeChannelAccount(data: Uint8Array): ChannelAccount {
  if (data.length !== BATCH_CHANNEL_ACCOUNT_SIZE) {
    throw new Error(
      `channel account is ${data.length} bytes, expected ${BATCH_CHANNEL_ACCOUNT_SIZE}`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    discriminator: view.getUint8(0),
    version: view.getUint8(1),
    bump: view.getUint8(2),
    status: view.getUint8(3),
    salt: view.getBigUint64(4, true),
    deposit: view.getBigUint64(12, true),
    settled: view.getBigUint64(20, true),
    payoutWatermark: view.getBigUint64(28, true),
  };
}

/**
 * The highest cumulative this wallet has signed for a channel: the confirmed
 * amount, or a pending allocation not yet reconciled, whichever is higher.
 * Counting pending keeps an in-flight voucher from reading as an overclaim.
 */
export function signedCumulative(record: BatchClientChannelRecord): bigint {
  const pending = record.pending === undefined ? [] : [record.pending].flat();
  let max = BigInt(record.chargedCumulativeAmount);
  for (const p of pending) {
    const amount = BigInt(p.chargedCumulativeAmount);
    if (amount > max) max = amount;
  }
  return max;
}

export type ClaimFinding = {
  channelId: string;
  /** ok: claimed ≤ signed. overclaimed: claimed > signed. */
  status: "ok" | "overclaimed" | "closed" | "unexpected-owner" | "error";
  signed?: bigint;
  claimed?: bigint;
  deposit?: bigint;
  detail?: string;
};

export type FetchedAccount = { owner: string; data: Uint8Array } | null;
export type AccountFetcher = (address: string) => Promise<FetchedAccount>;

/** Compare one channel's on-chain claim with what was signed locally. Pure. */
export function assessClaim(
  channelId: string,
  account: FetchedAccount,
  signed: bigint,
): ClaimFinding {
  if (!account) return { channelId, status: "closed", signed };
  if (account.owner !== BATCH_CHANNEL_PROGRAM) {
    return { channelId, status: "unexpected-owner", signed, detail: `owner ${account.owner}` };
  }
  const decoded = decodeChannelAccount(account.data);
  return {
    channelId,
    status: decoded.settled > signed ? "overclaimed" : "ok",
    signed,
    claimed: decoded.settled,
    deposit: decoded.deposit,
  };
}

/** Check every stored channel. Never throws: a failure is a finding. */
export async function checkChannelClaims(
  records: Array<[string, BatchClientChannelRecord]>,
  fetchAccount: AccountFetcher,
): Promise<ClaimFinding[]> {
  const findings: ClaimFinding[] = [];
  for (const [, record] of records) {
    const channelId = String(record?.channelId ?? "");
    if (!channelId) continue;
    try {
      findings.push(
        assessClaim(channelId, await fetchAccount(channelId), signedCumulative(record)),
      );
    } catch (err) {
      findings.push({
        channelId,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return findings;
}

/** Account fetcher over Solana JSON-RPC (lazy @solana/kit import). */
export function createRpcAccountFetcher(rpcUrl: string = SOLANA_DEFAULT_RPC): AccountFetcher {
  return async (channelId) => {
    const { address, createSolanaRpc } = await import("@solana/kit");
    const rpc = createSolanaRpc(rpcUrl);
    const { value } = await rpc
      .getAccountInfo(address(channelId), { encoding: "base64" })
      .send({ abortSignal: AbortSignal.timeout(10_000) });
    if (!value) return null;
    return { owner: value.owner, data: Buffer.from(value.data[0], "base64") };
  };
}

export function describeFinding(f: ClaimFinding): string {
  const usd = (v?: bigint) => (v === undefined ? "?" : `$${formatMicrosAsUsd(v)}`);
  switch (f.status) {
    case "ok":
      return `${f.channelId}: claimed ${usd(f.claimed)} of ${usd(f.signed)} signed (deposit ${usd(f.deposit)})`;
    case "overclaimed":
      return `${f.channelId}: CLAIMED ${usd(f.claimed)} ABOVE ${usd(f.signed)} SIGNED (deposit ${usd(f.deposit)})`;
    case "closed":
      return `${f.channelId}: no account on chain (closed or not opened)`;
    case "unexpected-owner":
      return `${f.channelId}: not a batch channel account (${f.detail})`;
    case "error":
      return `${f.channelId}: check failed (${f.detail})`;
  }
}

// ─── Runtime guard ─────────────────────────────────────────────────────────

/**
 * Process-wide switch for batch settlement. While active, its `policy` moves
 * batch-settlement accepts ahead of the others (the SDK's own policy only
 * reorders among batch accepts, and the default selector takes the first, so
 * an offer listing `exact` first would otherwise never use batch). Once a
 * claim check has found an overclaim it drops every batch-settlement accept,
 * so the rest of the process pays with `exact`.
 */
export class SolanaBatchGuard {
  disabledReason: string | undefined;
  lastFindings: ClaimFinding[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly storage: Pick<FileChannelStorage, "entries">,
    private readonly fetchAccount: AccountFetcher,
  ) {}

  get active(): boolean {
    return this.disabledReason === undefined;
  }

  readonly policy = <T extends { scheme: string }>(_version: number, accepts: T[]): T[] => {
    const batch = accepts.filter((a) => a.scheme === BATCH_SCHEME);
    const rest = accepts.filter((a) => a.scheme !== BATCH_SCHEME);
    return this.active ? [...batch, ...rest] : rest;
  };

  disable(reason: string): void {
    if (this.disabledReason !== undefined) return;
    this.disabledReason = reason;
    console.error(
      `[ClawRouter] ⚠️  SOLANA BATCH SETTLEMENT DISABLED: ${reason}. ` +
        `Every Solana payment now uses exact. Check the channel on a Solana explorer before re-enabling.`,
    );
  }

  async check(): Promise<ClaimFinding[]> {
    let records: Array<[string, BatchClientChannelRecord]>;
    try {
      records = await this.storage.entries();
    } catch (err) {
      // Without the signed cumulative there is nothing to compare a claim to.
      this.disable(err instanceof Error ? err.message : String(err));
      return this.lastFindings;
    }
    this.lastFindings = await checkChannelClaims(records, this.fetchAccount);
    const over = this.lastFindings.filter((f) => f.status === "overclaimed");
    if (over.length > 0) {
      this.disable(
        `operator claimed more than this wallet signed: ${over.map(describeFinding).join("; ")}`,
      );
    }
    for (const f of this.lastFindings) {
      if (f.status === "error" || f.status === "unexpected-owner") {
        console.warn(`[ClawRouter] Solana batch claim check: ${describeFinding(f)}`);
      }
    }
    return this.lastFindings;
  }

  start(intervalMs: number = CLAIM_CHECK_INTERVAL_MS): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * Register `BatchSvmScheme` for `solana:*` next to the already-registered
 * `exact` scheme. Call only when `config.status === "on"`.
 */
export async function registerSolanaBatchScheme(
  x402: x402Client,
  signer: BatchClientSigner,
  config: SolanaBatchConfig,
  opts: { rpcUrl?: string; storeFile?: string; fetchAccount?: AccountFetcher } = {},
): Promise<SolanaBatchGuard> {
  if (config.status !== "on") {
    throw new Error(`Solana batch settlement is not enabled (status: ${config.status})`);
  }
  const { BatchSvmScheme } = await import("@x402/svm/batch-settlement/client");
  const storage = new FileChannelStorage(opts.storeFile);
  const batch = new BatchSvmScheme(signer, {
    depositAmount: config.depositMicros.toString(),
    channelStorage: storage,
    ...(opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : {}),
    serverSignedChannelsPolicy: {
      allowedOperators: config.allowedOperators,
      // The operator can claim the whole escrow, so the escrow is one deposit.
      maxDeposit: `$${formatMicrosAsUsd(config.depositMicros)}`,
    },
  });
  const guard = new SolanaBatchGuard(
    storage,
    opts.fetchAccount ?? createRpcAccountFetcher(opts.rpcUrl),
  );
  x402.register("solana:*", batch);
  // The SDK's policy drops server-signed accepts from untrusted operators; the
  // guard's then prefers what batch remains, or drops it once disabled.
  x402.registerPolicy(batch.paymentPolicy);
  x402.registerPolicy(guard.policy);
  return guard;
}

/** The same 402 offer without its batch-settlement accepts, or undefined if nothing is left. */
export function withoutBatchAccepts<T extends { accepts: Array<{ scheme: string }> }>(
  paymentRequired: T,
): T | undefined {
  const accepts = paymentRequired.accepts.filter((a) => a.scheme !== BATCH_SCHEME);
  if (accepts.length === 0 || accepts.length === paymentRequired.accepts.length) return undefined;
  return { ...paymentRequired, accepts };
}

export type SolanaBatchReport = {
  status: SolanaBatchConfig["status"];
  message?: string;
  store: string;
  channels: string[];
  overclaimed: boolean;
};

/** Read-only summary for `doctor`: config state plus a claim check of every stored channel. */
export async function inspectSolanaBatch(
  config: SolanaBatchConfig,
  opts: { rpcUrl?: string; storeFile?: string; fetchAccount?: AccountFetcher } = {},
): Promise<SolanaBatchReport> {
  const storage = new FileChannelStorage(opts.storeFile);
  const report: SolanaBatchReport = {
    status: config.status,
    ...(config.message ? { message: config.message } : {}),
    store: storage.file,
    channels: [],
    overclaimed: false,
  };
  let records: Array<[string, BatchClientChannelRecord]>;
  try {
    records = await storage.entries();
  } catch (err) {
    report.channels.push(err instanceof Error ? err.message : String(err));
    return report;
  }
  const findings = await checkChannelClaims(
    records,
    opts.fetchAccount ?? createRpcAccountFetcher(opts.rpcUrl),
  );
  report.channels = findings.map(describeFinding);
  report.overclaimed = findings.some((f) => f.status === "overclaimed");
  return report;
}
