/**
 * When two wallets disagree, say which one is paying (#315).
 *
 * `resolveExistingWalletKey` prefers BlockRun Core over ClawRouter's legacy
 * `wallet.key`, and `migrateLegacyWalletToCore` copies legacy into Core only
 * when Core is ABSENT — so in the common case both hold the same key and the
 * precedence is invisible. It becomes visible when Core was written
 * independently by another BlockRun product while ClawRouter already had its own
 * funded wallet: payment moves on upgrade, requests fail on an empty balance,
 * and the funded wallet sits idle.
 *
 * The precedence is deliberate and stays — preferring legacy would make Desktop
 * display and fund one address while the proxy spends from another, and refusing
 * outright would turn a working install into a hard failure. What these pin is
 * that the switch is no longer silent, and that the ordinary same-key install
 * stays quiet.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const CORE_KEY = "0x" + "11".repeat(32);
const LEGACY_KEY = "0x" + "22".repeat(32);

describe("Core vs legacy wallet divergence", () => {
  let homeDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("node:os");
    delete process.env.BLOCKRUN_WALLET_KEY;
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  async function withWallets(core: string | undefined, legacy: string | undefined) {
    homeDir = mkdtempSync(join(tmpdir(), "clawrouter-wallet-divergence-"));
    delete process.env.BLOCKRUN_WALLET_KEY;

    if (core !== undefined) {
      mkdirSync(join(homeDir, ".blockrun"), { recursive: true });
      writeFileSync(join(homeDir, ".blockrun", ".session"), core + "\n", { mode: 0o600 });
    }
    if (legacy !== undefined) {
      mkdirSync(join(homeDir, ".openclaw", "blockrun"), { recursive: true });
      writeFileSync(join(homeDir, ".openclaw", "blockrun", "wallet.key"), legacy + "\n", {
        mode: 0o600,
      });
    }

    vi.doMock("node:os", async () => ({
      ...(await vi.importActual<typeof import("node:os")>("node:os")),
      homedir: () => homeDir,
    }));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const auth = await import("./auth.js");
    return { auth, warn };
  }

  const warned = (warn: ReturnType<typeof vi.spyOn>) =>
    warn.mock.calls.map((c) => String(c[0])).join("\n");

  it("still pays from Core, and names both addresses", async () => {
    const { auth, warn } = await withWallets(CORE_KEY, LEGACY_KEY);

    const resolved = await auth.resolveExistingWalletKey();
    expect(resolved?.source).toBe("core");
    expect(resolved?.key).toBe(CORE_KEY);

    const text = warned(warn);
    // Both addresses, so the operator can tell which one holds their USDC.
    expect(text).toMatch(/0x/);
    expect(text).toMatch(/wallet\.key/);
    // And the one-line way to keep paying from the funded one.
    expect(text).toMatch(/BLOCKRUN_WALLET_KEY/);
  });

  it("says nothing when both files hold the same key", async () => {
    // The ordinary shape: ClawRouter migrated its own wallet into Core.
    const { auth, warn } = await withWallets(CORE_KEY, CORE_KEY);

    expect((await auth.resolveExistingWalletKey())?.source).toBe("core");
    expect(warned(warn)).toBe("");
  });

  it("says nothing when there is no legacy wallet at all", async () => {
    const { auth, warn } = await withWallets(CORE_KEY, undefined);

    expect((await auth.resolveExistingWalletKey())?.source).toBe("core");
    expect(warned(warn)).toBe("");
  });

  it("warns once, not on every resolution", async () => {
    const { auth, warn } = await withWallets(CORE_KEY, LEGACY_KEY);

    await auth.resolveExistingWalletKey();
    const after = warn.mock.calls.length;
    await auth.resolveExistingWalletKey();
    expect(warn.mock.calls.length).toBe(after);
  });

  it("reports a chain another product chose over this install's own", async () => {
    homeDir = mkdtempSync(join(tmpdir(), "clawrouter-chain-divergence-"));
    mkdirSync(join(homeDir, ".blockrun"), { recursive: true });
    mkdirSync(join(homeDir, ".openclaw", "blockrun"), { recursive: true });
    writeFileSync(join(homeDir, ".blockrun", ".chain"), "solana\n");
    writeFileSync(join(homeDir, ".openclaw", "blockrun", "payment-chain"), "base\n");

    vi.doMock("node:os", async () => ({
      ...(await vi.importActual<typeof import("node:os")>("node:os")),
      homedir: () => homeDir,
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const auth = await import("./auth.js");

    // Core still wins — a different chain is a different signer and gateway,
    // and Desktop reads the Core files directly.
    expect(await auth.loadPaymentChain()).toBe("solana");
    expect(warned(warn)).toMatch(/wallet base/);
  });
});
