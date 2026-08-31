import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE_KEY = `0x${"11".repeat(32)}`;
const CORE_SOLANA_KEY =
  "1GMkH3brNXiNNs1tiFZHu4yZSRrzJwxi5wB9bHFtMinfCXNnR1adh8Vo8NTheK4evneedH4qmvjeqcBBNAefgS";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

describe("BlockRun Core wallet resolution", () => {
  let home: string;

  beforeEach(async () => {
    vi.resetModules();
    home = await mkdtemp(join(tmpdir(), "clawrouter-core-wallet-"));
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => home };
    });
    delete process.env.SOLANA_WALLET_KEY;
  });

  afterEach(async () => {
    delete process.env.SOLANA_WALLET_KEY;
    vi.doUnmock("node:os");
    await rm(home, { recursive: true, force: true });
  });

  async function writeWallets(solanaKey = CORE_SOLANA_KEY): Promise<void> {
    await mkdir(join(home, ".blockrun"), { recursive: true });
    await mkdir(join(home, ".openclaw", "blockrun"), { recursive: true });
    await writeFile(join(home, ".blockrun", ".session"), `${BASE_KEY}\n`);
    await writeFile(join(home, ".blockrun", ".solana-session"), `${solanaKey}\n`);
    await writeFile(join(home, ".openclaw", "blockrun", "mnemonic"), `${MNEMONIC}\n`);
  }

  it("uses the Core Solana session instead of a legacy mnemonic", async () => {
    await writeWallets();
    const { resolveOrGenerateWalletKey } = await import("./auth.js");
    const wallet = await resolveOrGenerateWalletKey();
    expect(wallet.source).toBe("core");
    expect(wallet.solanaSource).toBe("core");
    expect([...wallet.solanaPrivateKeyBytes!]).toEqual([...Array(32).keys()]);
  });

  it("lets an explicit SOLANA_WALLET_KEY override the Core session", async () => {
    await writeWallets();
    process.env.SOLANA_WALLET_KEY = JSON.stringify(
      [...Array(64).keys()].map((value) => 255 - value),
    );
    const { resolveOrGenerateWalletKey } = await import("./auth.js");
    const wallet = await resolveOrGenerateWalletKey();
    expect(wallet.solanaSource).toBe("env");
    expect(wallet.solanaPrivateKeyBytes?.[0]).toBe(255);
    expect(wallet.solanaPrivateKeyBytes?.[31]).toBe(224);
  });

  it("refuses to silently fall back when the Core Solana wallet is corrupt", async () => {
    await writeWallets("not-a-valid-key");
    const { resolveOrGenerateWalletKey } = await import("./auth.js");
    await expect(resolveOrGenerateWalletKey()).rejects.toThrow(/Refusing to fall back/i);
  });
});
