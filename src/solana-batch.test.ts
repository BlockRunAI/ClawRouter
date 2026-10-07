/**
 * Solana batch settlement: config parsing, the durable channel store, the
 * channel account decode and the claim comparison. No network: the account
 * fetcher is injected everywhere.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BATCH_CHANNEL_ACCOUNT_SIZE,
  BATCH_CHANNEL_PROGRAM,
  DEFAULT_BATCH_DEPOSIT_MICROS,
  FileChannelStorage,
  SolanaBatchGuard,
  assessClaim,
  checkChannelClaims,
  decodeChannelAccount,
  formatMicrosAsUsd,
  inspectSolanaBatch,
  parseSolanaBatchConfig,
  parseUsdcToMicros,
  signedCumulative,
  withoutBatchAccepts,
  type BatchClientChannelRecord,
  type FetchedAccount,
} from "./solana-batch.js";

const OPERATOR = "5YKPQUFjw5WQqhSUkEGKNNfYYVqnRRNbpYyL71qQ1vm3";
const CHANNEL = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function record(charged: string, pending?: string | string[]): BatchClientChannelRecord {
  const rec = {
    channelConfig: {},
    channelId: CHANNEL,
    chargedCumulativeAmount: charged,
    deposit: "1000000",
  } as unknown as BatchClientChannelRecord;
  if (pending !== undefined) {
    const item = (amount: string, i: number) => ({
      amount: "1",
      chargedCumulativeAmount: amount,
      deposit: "1000000",
      operationKey: `op${i}`,
      payment: {},
    });
    (rec as { pending?: unknown }).pending = Array.isArray(pending)
      ? pending.map(item)
      : item(pending, 0);
  }
  return rec;
}

/** A 256-byte channel account with the given deposit and settled watermark. */
function channelAccount(deposit: bigint, settled: bigint): Uint8Array {
  const data = new Uint8Array(BATCH_CHANNEL_ACCOUNT_SIZE);
  const view = new DataView(data.buffer);
  view.setUint8(0, 7); // discriminator
  view.setUint8(1, 1); // version
  view.setUint8(2, 254); // bump
  view.setUint8(3, 1); // status
  view.setBigUint64(4, 42n, true); // salt
  view.setBigUint64(12, deposit, true);
  view.setBigUint64(20, settled, true);
  view.setBigUint64(28, 5n, true); // payout watermark
  return data;
}

const owned = (deposit: bigint, settled: bigint): FetchedAccount => ({
  owner: BATCH_CHANNEL_PROGRAM,
  data: channelAccount(deposit, settled),
});

describe("parseSolanaBatchConfig", () => {
  it("is off when nothing is set", () => {
    expect(parseSolanaBatchConfig({})).toEqual({
      status: "off",
      depositMicros: DEFAULT_BATCH_DEPOSIT_MICROS,
      allowedOperators: [],
    });
  });

  it.each(["0", "false", "off", "", "maybe"])("stays off for CLAWROUTER_SOLANA_BATCH=%j", (v) => {
    expect(parseSolanaBatchConfig({ CLAWROUTER_SOLANA_BATCH: v }).status).toBe("off");
  });

  it("fails closed with no trusted operator", () => {
    const config = parseSolanaBatchConfig({ CLAWROUTER_SOLANA_BATCH: "1" });
    expect(config.status).toBe("no-operator");
    expect(config.allowedOperators).toEqual([]);
    expect(config.message).toMatch(/OPERATORS is empty/);
  });

  it.each(["1", "true", "ON", " yes "])("turns on for %j with an operator", (v) => {
    const config = parseSolanaBatchConfig({
      CLAWROUTER_SOLANA_BATCH: v,
      CLAWROUTER_SOLANA_BATCH_OPERATORS: OPERATOR,
    });
    expect(config).toEqual({
      status: "on",
      depositMicros: 1_000_000n,
      allowedOperators: [OPERATOR],
    });
  });

  it("takes a custom deposit and a deduplicated operator list", () => {
    const config = parseSolanaBatchConfig({
      CLAWROUTER_SOLANA_BATCH: "1",
      CLAWROUTER_SOLANA_BATCH_DEPOSIT_USDC: "0.25",
      CLAWROUTER_SOLANA_BATCH_OPERATORS: ` ${OPERATOR}, ${BATCH_CHANNEL_PROGRAM} ,${OPERATOR},`,
    });
    expect(config.status).toBe("on");
    expect(config.depositMicros).toBe(250_000n);
    expect(config.allowedOperators).toEqual([OPERATOR, BATCH_CHANNEL_PROGRAM]);
  });

  it.each(["0", "-1", "1.0000001", "abc", "1e3", "0x10"])(
    "rejects deposit %j and stays on exact",
    (deposit) => {
      const config = parseSolanaBatchConfig({
        CLAWROUTER_SOLANA_BATCH: "1",
        CLAWROUTER_SOLANA_BATCH_DEPOSIT_USDC: deposit,
        CLAWROUTER_SOLANA_BATCH_OPERATORS: OPERATOR,
      });
      expect(config.status).toBe("invalid");
      expect(config.allowedOperators).toEqual([]);
      expect(config.message).toMatch(/DEPOSIT_USDC/);
    },
  );

  it("rejects an operator that is not a Solana address", () => {
    const config = parseSolanaBatchConfig({
      CLAWROUTER_SOLANA_BATCH: "1",
      CLAWROUTER_SOLANA_BATCH_OPERATORS: `${OPERATOR},0xdeadbeef`,
    });
    expect(config.status).toBe("invalid");
    expect(config.allowedOperators).toEqual([]);
    expect(config.message).toContain("0xdeadbeef");
  });
});

describe("USDC amounts", () => {
  it("parses decimal USDC to micros", () => {
    expect(parseUsdcToMicros("1")).toBe(1_000_000n);
    expect(parseUsdcToMicros("0.01")).toBe(10_000n);
    expect(parseUsdcToMicros("2.000001")).toBe(2_000_001n);
    expect(parseUsdcToMicros("0.000000")).toBeUndefined();
  });

  it("formats micros as a dollar amount", () => {
    expect(formatMicrosAsUsd(1_000_000n)).toBe("1.000000");
    expect(formatMicrosAsUsd(250_000n)).toBe("0.250000");
  });
});

describe("FileChannelStorage", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clawrouter-batch-"));
    file = join(dir, "nested", "channels.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads nothing before the first write", async () => {
    const storage = new FileChannelStorage(file);
    expect(await storage.get("k")).toBeUndefined();
    expect(await storage.entries()).toEqual([]);
  });

  it("survives a restart: a new instance reads what the last one wrote", async () => {
    await new FileChannelStorage(file).set("k", record("1500"));
    const restarted = new FileChannelStorage(file);
    expect((await restarted.get("k"))?.chargedCumulativeAmount).toBe("1500");
  });

  it("writes atomically, privately, and leaves no temp file", async () => {
    const storage = new FileChannelStorage(file);
    await storage.set("k", record("1"));
    expect(readdirSync(join(dir, "nested"))).toEqual(["channels.json"]);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("deletes a record", async () => {
    const storage = new FileChannelStorage(file);
    await storage.set("a", record("1"));
    await storage.set("b", record("2"));
    await storage.delete("a");
    expect((await storage.entries()).map(([k]) => k)).toEqual(["b"]);
  });

  it("keeps both of two concurrent writes", async () => {
    const storage = new FileChannelStorage(file);
    await Promise.all([storage.set("a", record("1")), storage.set("b", record("2"))]);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort()).toEqual(["a", "b"]);
  });

  it("refuses a torn file instead of forgetting the signed cumulative", async () => {
    const storage = new FileChannelStorage(file);
    await storage.set("k", record("1"));
    writeFileSync(file, '{"k":{"channelId":"');
    await expect(storage.get("k")).rejects.toThrow(/unreadable/);
    await expect(storage.set("k", record("2"))).rejects.toThrow(/unreadable/);
    expect(readFileSync(file, "utf8")).toBe('{"k":{"channelId":"'); // not overwritten
  });
});

describe("decodeChannelAccount", () => {
  it("reads the u8 header and the u64 LE fields at their offsets", () => {
    expect(decodeChannelAccount(channelAccount(1_000_000n, 3_000n))).toEqual({
      discriminator: 7,
      version: 1,
      bump: 254,
      status: 1,
      salt: 42n,
      deposit: 1_000_000n,
      settled: 3_000n,
      payoutWatermark: 5n,
    });
  });

  it("decodes from a view into a larger buffer", () => {
    const big = new Uint8Array(BATCH_CHANNEL_ACCOUNT_SIZE + 8);
    big.set(channelAccount(9n, 4n), 8);
    expect(decodeChannelAccount(big.subarray(8)).settled).toBe(4n);
  });

  it("rejects an account of the wrong size", () => {
    expect(() => decodeChannelAccount(new Uint8Array(255))).toThrow(/255 bytes/);
  });
});

describe("claim comparison", () => {
  it("counts the highest of confirmed and pending as signed", () => {
    expect(signedCumulative(record("100"))).toBe(100n);
    expect(signedCumulative(record("100", "250"))).toBe(250n);
    expect(signedCumulative(record("300", ["120", "290"]))).toBe(300n);
  });

  it("is ok while claimed is at or below signed", () => {
    expect(assessClaim(CHANNEL, owned(1_000_000n, 0n), 500n).status).toBe("ok");
    const equal = assessClaim(CHANNEL, owned(1_000_000n, 500n), 500n);
    expect(equal).toMatchObject({ status: "ok", claimed: 500n, signed: 500n, deposit: 1_000_000n });
  });

  it("flags a claim above what was signed", () => {
    expect(assessClaim(CHANNEL, owned(1_000_000n, 501n), 500n).status).toBe("overclaimed");
  });

  it("reports a missing account and a foreign owner without alarming", () => {
    expect(assessClaim(CHANNEL, null, 1n).status).toBe("closed");
    const foreign = assessClaim(CHANNEL, { owner: OPERATOR, data: channelAccount(1n, 99n) }, 1n);
    expect(foreign.status).toBe("unexpected-owner");
  });

  it("turns a fetch failure into a finding and skips records without a channel id", async () => {
    const findings = await checkChannelClaims(
      [
        ["a", record("1")],
        ["b", { ...record("1"), channelId: "" }],
      ],
      async () => {
        throw new Error("rpc down");
      },
    );
    expect(findings).toEqual([{ channelId: CHANNEL, status: "error", detail: "rpc down" }]);
  });
});

describe("SolanaBatchGuard", () => {
  const accepts = [
    { scheme: "batch-settlement", network: "solana:x" },
    { scheme: "exact", network: "solana:x" },
  ];
  const storageOf = (records: Array<[string, BatchClientChannelRecord]>) => ({
    entries: async () => records,
  });

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps batch while every claim is covered", async () => {
    const guard = new SolanaBatchGuard(storageOf([["k", record("500")]]), async () =>
      owned(1_000_000n, 400n),
    );
    await guard.check();
    expect(guard.active).toBe(true);
    expect(guard.policy(2, accepts)).toEqual(accepts);
    // batch first even when the gateway lists exact first
    expect(guard.policy(2, [...accepts].reverse())).toEqual(accepts);
  });

  it("disables batch for the process on an overclaim, loudly", async () => {
    const guard = new SolanaBatchGuard(storageOf([["k", record("500")]]), async () =>
      owned(1_000_000n, 1_000_000n),
    );
    await guard.check();
    expect(guard.active).toBe(false);
    expect(guard.disabledReason).toMatch(/claimed more than this wallet signed/);
    expect(guard.policy(2, accepts)).toEqual([accepts[1]]);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/DISABLED/));
  });

  it("disables batch when the channel store cannot be read", async () => {
    const guard = new SolanaBatchGuard(
      {
        entries: async () => {
          throw new Error("store unreadable");
        },
      },
      async () => null,
    );
    await guard.check();
    expect(guard.active).toBe(false);
  });
});

describe("withoutBatchAccepts", () => {
  it("drops batch accepts and keeps the rest", () => {
    const offer = {
      x402Version: 2,
      accepts: [{ scheme: "batch-settlement" }, { scheme: "exact" }],
    };
    expect(withoutBatchAccepts(offer)).toEqual({ x402Version: 2, accepts: [{ scheme: "exact" }] });
  });

  it("is undefined when there is no batch accept, or nothing else to pay with", () => {
    expect(withoutBatchAccepts({ accepts: [{ scheme: "exact" }] })).toBeUndefined();
    expect(withoutBatchAccepts({ accepts: [{ scheme: "batch-settlement" }] })).toBeUndefined();
  });
});

describe("inspectSolanaBatch (doctor)", () => {
  it("reports each stored channel and an overclaim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawrouter-batch-"));
    try {
      const storeFile = join(dir, "channels.json");
      await new FileChannelStorage(storeFile).set("k", record("500"));
      const config = parseSolanaBatchConfig({
        CLAWROUTER_SOLANA_BATCH: "1",
        CLAWROUTER_SOLANA_BATCH_OPERATORS: OPERATOR,
      });
      const report = await inspectSolanaBatch(config, {
        storeFile,
        fetchAccount: async () => owned(1_000_000n, 600n),
      });
      expect(report.status).toBe("on");
      expect(report.overclaimed).toBe(true);
      expect(report.channels[0]).toContain("ABOVE");
      expect(JSON.stringify(report)).toBeTruthy(); // doctor serializes it
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
