import { describe, expect, it } from "vitest";
import { fulfillPaidProof, ReplayRejectedError, SpentProofLedger } from "./spent-proof.js";

const TX = "tx-sig-1";
const CHALLENGE = "fixture-challenge-id";
const NETWORK = "solana:mainnet-beta";

describe("seller spent proof", () => {
  it("rejects a second use of the same tx signature and challenge and does not call the model", async () => {
    const ledger = new SpentProofLedger();
    let calls = 0;
    const upstream = async () => {
      calls += 1;
      return "completion";
    };
    const first = await fulfillPaidProof({
      ledger,
      networkId: NETWORK,
      txSignature: TX,
      challengeId: CHALLENGE,
      upstream,
    });
    expect(first).toBe("completion");
    const err = await fulfillPaidProof({
      ledger,
      networkId: NETWORK,
      txSignature: TX,
      challengeId: CHALLENGE,
      upstream,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplayRejectedError);
    expect((err as ReplayRejectedError).status).toBe(409);
    expect(calls).toBe(1);
  });

  it("gives concurrent duplicates one winner", async () => {
    const ledger = new SpentProofLedger();
    let calls = 0;
    const upstream = async () => {
      calls += 1;
      return "completion";
    };
    const run = () =>
      fulfillPaidProof({
        ledger,
        networkId: NETWORK,
        txSignature: TX,
        challengeId: CHALLENGE,
        upstream,
      });
    const settled = await Promise.allSettled([run(), run()]);
    const won = settled.filter((r) => r.status === "fulfilled");
    const lost = settled.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(ReplayRejectedError);
    expect((lost[0] as PromiseRejectedResult).reason.status).toBe(409);
    expect(calls).toBe(1);
  });

  it("rejects one transaction reused for a different challenge on the same network", async () => {
    const ledger = new SpentProofLedger();
    let calls = 0;
    const upstream = async () => {
      calls += 1;
      return "completion";
    };
    await fulfillPaidProof({
      ledger,
      networkId: NETWORK,
      txSignature: TX,
      challengeId: CHALLENGE,
      upstream,
    });
    const err = await fulfillPaidProof({
      ledger,
      networkId: NETWORK,
      txSignature: TX,
      challengeId: "another-challenge",
      upstream,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplayRejectedError);
    expect(err).toMatchObject({
      networkId: NETWORK,
      txSignature: TX,
      challengeId: "another-challenge",
    });
    expect(calls).toBe(1);
  });

  it("rejects a challenge replayed with a different transaction on the same network", async () => {
    const ledger = new SpentProofLedger();
    let calls = 0;
    const upstream = async () => {
      calls += 1;
      return "completion";
    };
    await fulfillPaidProof({
      ledger,
      networkId: NETWORK,
      txSignature: TX,
      challengeId: CHALLENGE,
      upstream,
    });
    const err = await fulfillPaidProof({
      ledger,
      networkId: NETWORK,
      txSignature: "tx-sig-2",
      challengeId: CHALLENGE,
      upstream,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplayRejectedError);
    expect(calls).toBe(1);
  });

  it("scopes transaction and challenge identity by network", async () => {
    const ledger = new SpentProofLedger();
    const upstream = async () => "completion";
    await fulfillPaidProof({
      ledger,
      networkId: NETWORK,
      txSignature: TX,
      challengeId: CHALLENGE,
      upstream,
    });
    await expect(
      fulfillPaidProof({
        ledger,
        networkId: "solana:devnet",
        txSignature: TX,
        challengeId: CHALLENGE,
        upstream,
      }),
    ).resolves.toBe("completion");
  });
});
