/**
 * /policy command tests — input is fail-closed, writes are verified, and a
 * policy set through the command actually stops the signer.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { x402Client } from "@x402/fetch";
import { createPolicyCommand, runPolicyCommand } from "./policy.js";
import {
  CAIP2_BASE,
  CAIP2_SOLANA_MAINNET,
  InMemorySpendControlStorage,
  SpendControl,
  registerSpendPolicyHook,
} from "../spend-control.js";

const payee = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const other = `0x${"b".repeat(40)}`;
const line = (res: { text?: string }, n = 0) => (res.text ?? "").split("\n")[n];
const firstLine = (res: { text?: string }) => line(res);

/** A store shared across command invocations, the way spending.json is on disk. */
function memory() {
  const storage = new InMemorySpendControlStorage();
  const openControl = () => new SpendControl({ storage });
  const live = openControl();
  const run = (argv: string[]) => runPolicyCommand(argv, { openControl, liveControl: () => live });
  return { storage, openControl, live, run };
}

describe("runPolicyCommand (in-memory store)", () => {
  it("a payee blocked through the command stops the signer", async () => {
    const { run, openControl } = memory();
    expect(run(["set", "blockedPayees", payee]).isError).toBeFalsy();

    let signerCalls = 0;
    const client = new x402Client();
    registerSpendPolicyHook(client, openControl());
    client.register(CAIP2_BASE, {
      scheme: "exact",
      async createPaymentPayload() {
        signerCalls += 1;
        return { x402Version: 2, payload: {} };
      },
    });
    await expect(
      client.createPaymentPayload({
        x402Version: 2,
        resource: { url: "https://example.invalid/pay" },
        accepts: [
          {
            scheme: "exact",
            network: CAIP2_BASE,
            amount: "1000",
            asset: "USDC",
            payTo: payee,
            maxTimeoutSeconds: 60,
            extra: {},
          },
        ],
      }),
    ).rejects.toThrow(/blocked by policy/);
    expect(signerCalls).toBe(0);
  });

  it("a gateway write reaches the live signer with no reopen, and says it was applied", () => {
    const { run, live, storage } = memory();
    const res = run(["set", "blockedPayees", payee]);
    expect(res.isError).toBeFalsy();
    expect(firstLine(res)).toBe(`blockedPayees: ${JSON.stringify([payee.toLowerCase()])}`);
    expect(res.text).toContain("Applied to the running proxy");
    expect(res.text).not.toMatch(/restart/i);
    // The very instance the proxy signs with refuses now — nothing was re-read from disk.
    expect(live.check(1, { payTo: payee, network: CAIP2_BASE }).allowed).toBe(false);
    expect(storage.load()?.limits.blockedPayees).toEqual([payee.toLowerCase()]);
  });

  it("a CLI write, with no live proxy in this process, leads with the restart requirement", () => {
    const { openControl } = memory();
    const res = runPolicyCommand(["set", "blockedPayees", payee], { openControl });
    expect(res.isError).toBeFalsy();
    expect(firstLine(res)).toMatch(/^NOT applied to a running proxy/);
    expect(line(res, 1)).toBe(`blockedPayees: ${JSON.stringify([payee.toLowerCase()])}`);
    // An unset-guard write still says what it permits, on the line after the restart requirement.
    const cleared = runPolicyCommand(["clear", "blockedPayees"], { openControl });
    expect(firstLine(cleared)).toMatch(/^NOT applied/);
    expect(line(cleared, 1)).toBe("blockedPayees is now unset — no payee is blocked.");
  });

  it("lowercases EVM entries and dedupes on add", () => {
    const { run, openControl } = memory();
    run(["set", "blockedPayees", payee]);
    expect(run(["add", "blockedPayees", payee.toLowerCase(), other]).isError).toBeFalsy();
    expect(openControl().getLimits().blockedPayees).toEqual([payee.toLowerCase(), other]);
  });

  it("refuses to remove the last allow-list entry, because that would turn the guard off", () => {
    const { run, openControl } = memory();
    run(["set", "allowedNetworks", CAIP2_BASE, CAIP2_SOLANA_MAINNET]);
    expect(run(["remove", "allowedNetworks", CAIP2_BASE]).isError).toBeFalsy();
    expect(openControl().getLimits().allowedNetworks).toEqual([CAIP2_SOLANA_MAINNET]);

    const res = run(["remove", "allowedNetworks", CAIP2_SOLANA_MAINNET]);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/every network is permitted/);
    expect(res.text).toMatch(/policy clear allowedNetworks/);
    expect(openControl().getLimits().allowedNetworks).toEqual([CAIP2_SOLANA_MAINNET]);
    // The other entry-list behaves the same; check() would otherwise allow every payee.
    expect(openControl().check(1, { payTo: other, network: CAIP2_BASE }).allowed).toBe(false);
  });

  it("remove that empties blockedPayees clears it and says so in the first line", () => {
    const { run, openControl } = memory();
    run(["set", "blockedPayees", payee]);
    const res = run(["remove", "blockedPayees", payee]);
    expect(res.isError).toBeFalsy();
    expect(firstLine(res)).toBe("blockedPayees is now unset — no payee is blocked.");
    expect(openControl().getLimits().blockedPayees).toBeUndefined();
  });

  it("clearing an allow-list or a cap leads with what is now permitted", () => {
    const { run } = memory();
    run(["set", "allowedPayees", payee]);
    expect(firstLine(run(["clear", "allowedPayees"]))).toBe(
      "allowedPayees is now unset — every payee is permitted.",
    );
    run(["limit", "daily", "5"]);
    expect(firstLine(run(["limit", "daily", "clear"]))).toBe(
      "daily is now unset — spend in the daily window is uncapped.",
    );
  });

  it("show renders unset keys as unset, not as a list that was never configured", () => {
    const { run } = memory();
    const text = run([]).text;
    expect(text).toContain("allowedPayees: (unset — every payee is permitted)");
    expect(text).toContain("blockedPayees: (unset — no payee is blocked)");
    expect(text).toContain("daily: (unset — spend in the daily window is uncapped)");
    expect(text).not.toContain("(none)");
  });

  it("remove of an absent entry is refused and the list is untouched", () => {
    const { run, openControl } = memory();
    run(["set", "blockedPayees", payee]);
    const res = run(["remove", "blockedPayees", payee, other]);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(new RegExp(`not in blockedPayees: ${other}`));
    expect(openControl().getLimits().blockedPayees).toEqual([payee.toLowerCase()]);
  });

  it("limit set and clear round-trip through the store", () => {
    const { run, openControl } = memory();
    expect(run(["limit", "daily", "5.50"]).isError).toBeFalsy();
    expect(openControl().getLimits().daily).toBe(5.5);
    expect(run(["limit", "daily", "clear"]).isError).toBeFalsy();
    expect(openControl().getLimits().daily).toBeUndefined();
  });

  it.each([
    [["set", "allowedNetworks", "base"], /not a network the proxy can pay on.*eip155:8453/],
    [["set", "allowedNetworks", "eip155:1"], /well formed but cannot appear in a payment quote/],
    [["set", "blockedPayees", "0xdead"], /exactly 40 hex/],
    [["set", "allowedAssets", `0X${"c".repeat(40)}`], /exactly 40 hex/],
    [["limit", "daily", "5abc"], /Rejected amount "5abc"/],
    [["limit", "daily", "0"], /Rejected amount "0"/],
    [["limit", "weekly", "5"], /Unknown window "weekly"/],
    [["set", "payees", payee], /Unknown list "payees"/],
    [["set", "blockedPayees"], /needs at least one value/],
    [["clear", "blockedPayees", payee], /takes no values/],
    [["frobnicate"], /Unknown subcommand/],
  ])("rejects %j before the store is opened", (argv, message) => {
    const { run, storage } = memory();
    const res = run(argv);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(message);
    expect(storage.load()).toBeNull();
  });

  it("reports a write that did not land instead of claiming success", () => {
    class DroppingStorage extends InMemorySpendControlStorage {
      // FileSpendControlStorage.save() swallows write failures; model that.
      override save(): void {}
    }
    const storage = new DroppingStorage();
    const res = runPolicyCommand(["limit", "hourly", "1"], {
      openControl: () => new SpendControl({ storage }),
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Write did not land/);
  });

  it("plugin handler splits ctx.args and shares the same implementation", async () => {
    const { openControl } = memory();
    const cmd = createPolicyCommand({ openControl });
    const ctx = { channel: "test", isAuthorizedSender: true, commandBody: "", config: {} };
    const res = await cmd.handler({ ...ctx, args: "  limit   perRequest 0.25 " });
    expect(res.isError).toBeFalsy();
    expect(openControl().getLimits().perRequest).toBe(0.25);
    expect((await cmd.handler({ ...ctx, args: "limit perRequest 5abc" })).isError).toBe(true);
  });
});

describe("runPolicyCommand (spending.json on disk)", () => {
  let tmpHome: string | undefined;
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = undefined;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    vi.restoreAllMocks();
  });

  /** Fresh module graph bound to a temp HOME, with spending.json pre-seeded. */
  async function seeded(limits: unknown) {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawrouter-policy-"));
    process.env.HOME = tmpHome;
    const file = path.join(tmpHome, ".openclaw", "blockrun", "spending.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ limits, history: [] }));
    vi.resetModules();
    const mod = await import("./policy.js");
    const run = (argv: string[]) => mod.runPolicyCommand(argv);
    return { file, before: fs.readFileSync(file), run };
  }

  it("rejects a network nickname and leaves the file byte-identical", async () => {
    const { file, before, run } = await seeded({ allowedNetworks: [CAIP2_BASE] });
    const res = run(["add", "allowedNetworks", "base"]);
    expect(res.isError).toBe(true);
    expect(res.text).toContain(CAIP2_SOLANA_MAINNET);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("rejects a malformed amount and leaves the file byte-identical", async () => {
    const { file, before, run } = await seeded({ daily: 1 });
    expect(run(["limit", "daily", "5abc"]).isError).toBe(true);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("refuses to touch a malformed policy file, on show and on every write", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // SpendControl logs the refusal
    const { file, before, run } = await seeded({ blockedPayees: [42] });
    for (const argv of [[], ["set", "blockedPayees", payee], ["limit", "daily", "1"]]) {
      const res = run(argv);
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/blockedPayees is malformed/);
    }
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("writes through the default on-disk store and reads it back", async () => {
    const { file, run } = await seeded({});
    expect(run(["set", "blockedPayees", payee]).isError).toBeFalsy();
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk.limits.blockedPayees).toEqual([payee.toLowerCase()]);
    expect(run([]).text).toContain(`blockedPayees: ${payee.toLowerCase()}`);
  });
});
