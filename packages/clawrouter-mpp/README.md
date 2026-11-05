# @twzrd1111/clawrouter-mpp

MPP (Machine Payments Protocol) payment rails for [ClawRouter](https://github.com/BlockRunAI/ClawRouter):
pay an MPP seller over **Tempo** or **Solana** instead of x402, under ClawRouter's own spend limits.

```ts
import { startProxy, SpendControl, FileSpendControlStorage } from "@twzrd1111/clawrouter";
import { createMppFetch, createSolanaMppFetch } from "@twzrd1111/clawrouter-mpp";

const spend = new SpendControl({ storage: new FileSpendControlStorage() });

// Tempo (needs `mppx`)
const payFetch = createMppFetch(account, fetch, { spend });
// or Solana (needs `@solana/mpp@~0.7.0` and `mppx@~0.17.0`)
// const payFetch = await createSolanaMppFetch({ signer, rpcUrl, network: "devnet", spend });

await startProxy({ spendControl: spend, payFetch /* ... */ });
```

This candidate requires `@twzrd1111/clawrouter >=0.12.307`, including deferred streaming headers.
The fork is the release target. Upstream PRs #545 and #546 are independent of this release.

For Tempo install the optional peer `mppx@~0.17.0`. For Solana install `@solana/mpp@~0.7.0`,
`mppx@~0.17.0`, and `@solana/kit@~6.10.0`. Solana now uses the official charge method
directly, replacing the pay-kit client wrapper. That wrapper's progress events omit the
challenge ID; the direct method lets policy checks and credits use the full challenge
before signing. `@solana/pay-kit` is used only by development tests as a fixture seller.

## What it guarantees

- **Spend limits apply.** The amount, network, asset and payee are checked, and budget reserved, _before_
  anything is signed. Solana checks the complete challenge before transaction construction
  and pins the configured network even when no spend control is supplied.
  The proxy refuses to start a rail that does not set `enforcesSpend` while amount limits are configured.
- **A signed payment is never paid twice.** If a call fails after a credential or transaction was signed, it
  ends in `MppPaidNoCompletionError`: the proxy answers 502 `payment_settled_no_completion` and does not
  retry or fall back. The spend ledger keeps the spend with a note, and the error carries a payment
  reference (`mpp-<16 hex>`, a hash of the signed payload) for disputes.
- **Streaming receipts.** Both factories set `deferStreamingHeaders`. The proxy holds final
  headers while paying, sends informational HTTP 102 responses, and forwards the seller's
  exact `Payment-Receipt` on the final streaming response. It does not fabricate a missing receipt.
  Both also set `supportsNativeStreaming`: streaming chat requests retain `stream: true`
  upstream and request usage chunks. Native SSE flows incrementally, including structured
  tool calls, with reasoning filtered and token/cost accounting retained.
  Ambiguous text-encoded calls wait for the choice to finish so recovery matches the existing
  whole-message parser; structured tool deltas and ordinary text flow incrementally.
  JSON-only replies use the existing simulated stream. In-flight coalesced callers receive live chunks from
  one paid attempt; completed cache replays do not claim a new receipt.
  HTTP 102 does not extend OpenClaw's deadline. Real content/tool deltas reset client activity
  timers as the model streams. Payment/header wait and stalled output still have deadlines.
- **Optional peers.** Importing this package does not load payment SDKs. Tempo loads `mppx` on
  first use; the asynchronous Solana factory loads `@solana/mpp`. Missing peers produce an
  install instruction.

"Signed" is not "settled": on Solana the seller submits the transaction. Seller-side refunds
remain outside this package.

## Replay protection at a seller

```ts
import { SpentProofLedger, fulfillPaidProof, ReplayRejectedError } from "@twzrd1111/clawrouter-mpp";

const proofs = new SpentProofLedger(); // share across requests in this process

// First authenticate the challenge and independently verify its payment on chain.
// Pass a canonical network ID plus verified transaction and challenge IDs,
// never untrusted body fields. Example IDs: "solana:mainnet-beta", "eip155:4217".
const completion = await fulfillPaidProof({
  ledger: proofs,
  networkId: verifiedNetworkId,
  txSignature: verifiedSignature,
  challengeId: verifiedChallengeId,
  upstream: () => runModel(),
});
```

A reused transaction or challenge on the same network throws `ReplayRejectedError` with
`status: 409` and `code: "proof_replayed"` before invoking `upstream`. Network scope allows
the same signature text or challenge ID to exist independently on another chain. The
synchronous claim gives concurrent duplicates one winner. The claim remains spent if the
model fails. This helper does not verify a payment itself,
and installing a buyer rail cannot add replay protection to a remote seller.

## Credits for signed calls with no completion

```ts
import { MppPaidNoCompletionError, readCredits } from "@twzrd1111/clawrouter-mpp";

try {
  await payFetch(url, init);
} catch (error) {
  if (error instanceof MppPaidNoCompletionError) {
    console.log(readCredits()); // immutable snapshots; do not log credentials
  }
  throw error;
}
```

Both rails record `{ payer, amount, challengeId, reason }` on a signed call's HTTP error or
transport failure. Payer comes from the supplied account/signer, never the seller's recipient.
Amount is the original integer base-unit string. Repeating a payer/challenge records one row.

When the proxy detects a provider error hidden inside HTTP 200, it calls the rail's
`onNoCompletion(response, reason)` hook. For a signed response this records the credit and
throws the same terminal error before any fallback model is paid. Unsigned responses retain
the ordinary provider fallback behavior. A custom host using these rails can invoke that
hook after its own completion validation; the response must be the one returned by the rail.

For a broken or unfinished native body the proxy invokes that same hook, records one credit,
and ends the existing SSE response with `payment_settled_no_completion`. Its HTTP 200 and
receipt have already been sent, so this is an in-stream error rather than a new HTTP 502.
The proxy never retries a model or pays a fallback after committing that stream. Disconnects
and request deadlines cancel the upstream reader and clean up coalesced callers.

`CreditLedger` and `creditPaidNoCompletion(ledger, error, fields)` are also public for callers
with their own ledger; `readCredits(ledger)` reads that ledger. Retrying the credit operation
returns the same immutable row and invokes no signer. It does not retry a model request.

Both ledgers are in memory, scoped to one process, and reset on restart. Credits record
signed attempts, not confirmed settlement or redeemable balances. There is no refund, chain
write, cross-process exclusion, persistence, or automatic reconciliation in these helpers.

## Develop

```
npm install   # from the ClawRouter repo root
# Before the candidate core is published, install rails development dependencies:
npm install --legacy-peer-deps   # in packages/clawrouter-mpp
npm run typecheck && npm test && npm run build   # in packages/clawrouter-mpp
```

Tests resolve `@twzrd1111/clawrouter` to the repo source until the seam is released.
