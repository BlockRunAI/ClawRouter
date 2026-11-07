# @twzrd1111/clawrouter-mpp

MPP (Machine Payments Protocol) payment rails for [ClawRouter](https://github.com/BlockRunAI/ClawRouter):
pay an MPP seller over **Tempo** or **Solana** instead of x402, under ClawRouter's own spend limits.

## Upgrading to 0.5.0 from 0.4.0

This release adds opt-in Solana Echo purchase binding (#21). Omit `echo` to preserve existing
behavior. `echo: {}` offers binding and pays unbound when a seller omits or changes the reflected
ID; `echo: { requireBinding: true }` refuses those challenges before signing.

- Each call sends fresh 16-byte buyer entropy as `X-Buyer-Nonce: <32 hex>`. A cooperating seller
  reflects it as `request.externalId: "twzrd:p:<nonce>"`, which the existing SDK writes as a memo.
- With `receiptVerification` enabled, a finalized payment passing all chain checks can set
  `receipt_reference_purchase_bound: true` only when exactly one SPL Memo (v1 and v2 counted
  together) matches the retained buyer expectation byte for byte. Malformed UTF-8, a leading BOM,
  or multiple memos cannot silently match.
- Identical complete challenges share one credential and one spend record; binding remains per
  call. The local nonce is not part of the shared-signing cache key.
- Fulfillment schema stays `twzrd.mpp.fulfillment.v3`; core peer floor stays `>=0.12.309`.
  `response_bytes` and `body_sha256` are existing fields, first shipped in 0.3.0.

Seller reflection is a separate integration. This release does not deploy a seller, verify Tempo
receipts, prove model execution, or supply a durable replay index. The existing in-memory indexes
forget on restart; cross-worker uniqueness requires caller-supplied durable, atomic storage.
See the [seller wire contract](https://github.com/twzrd-sol/ClawRouter-1/blob/899295ef627032260dbff363bbb012d446c9ecc6/docs/echo-protocol.md).

## Upgrading to 0.4.0 from 0.3.0

This release includes the standalone Solana receipt verifier (#16), fulfillment wiring (#18),
and the per-RPC deadline (#19). Verification is opt-in and does not verify Tempo receipts.
Purchase binding remains `null/no_buyer_nonce`; Echo and a durable reference index are not supplied
by this release. The reference index is caller-supplied and its operations have no built-in timeout.

- Fulfillment rows now use `twzrd.mpp.fulfillment.v3`. v3 adds eight `receipt_reference_*`
  verification fields (below); every other field is unchanged. Readers must accept the new schema.
  The fields are null unless the Solana rail was given `receiptVerification`, so Tempo rows and
  unconfigured Solana rows carry them as null ("not evaluated", never "clean").
- `createSolanaMppFetch({ receiptVerification: { verify } })` retains the transaction the buyer
  signed and chain-verifies the seller's receipt reference before writing the row.
- Each `getTransaction` call made by the verifier has a deadline: `rpcTimeoutMs`, default 10000.
  When it passes, the row records `null/rpc_unavailable` and the `signal` passed to the fetcher
  aborts, so a hung RPC cannot hold the row. Pass that `signal` to `fetch()`.

## Upgrading from 0.2.0

- Fulfillment rows now use `twzrd.mpp.fulfillment.v2`. Readers must accept the new schema to retain
  `response_bytes` and `body_sha256`; these fields are null when the recorder does not read a complete
  body within its 1 MiB cap.
- Credit rows carry an optional `reference` matching the error and spend record. It is a local
  signed-payload hash, not a settlement signature.
- `payFetch.flush({ timeoutMs })` bounds waiting for both records and ledger persistence. A timeout
  leaves the paid response and background writes intact; an omitted timeout keeps the previous
  unbounded wait. Values above 2,147,483,647 ms are rejected.

```ts
import { startProxy, SpendControl, FileSpendControlStorage } from "@twzrd1111/clawrouter";
import { createMppFetch, createSolanaMppFetch } from "@twzrd1111/clawrouter-mpp";
import { createTwzrdMppIntegration, createLocalDecisionSigner } from "twzrd-x402-gate";

const spend = new SpendControl({ storage: new FileSpendControlStorage() });
const twzrdMpp = createTwzrdMppIntegration({
  signer: createLocalDecisionSigner(),
  policy: { maxAmountUsd: "1.00" },
});

// Tempo (needs `mppx`); alternatively use createSolanaMppFetch with the same hooks.
const payFetch = createMppFetch(account, fetch, { spend, integration: twzrdMpp });
const proxy = await startProxy({ spendControl: spend, payFetch /* ... */ });

// proxy.close() closes the listener, then drains the rail's pending ledger writes.
await proxy.close();
```

The supported setup uses the integration helper returned by `createTwzrdMppIntegration`.
The `twzrdMppIntegration` marker is a wiring check only; it is forgeable and does not authenticate
the origin of the hooks. Its gate receives the full MPP charge challenge before credential
creation and returns
`{ disposition: "allow" | "warn" | "block" }`; `block` and callback errors refuse payment before
signing, while `warn` proceeds. The MPP rail rejects integrations without the marker or required
hooks before loading payment SDKs.

The integration writes the pre-sign decision durably to `.twzrd/decisions.jsonl` before allowing
credential creation, then appends the projected MPP receipt to that same file. Fulfillment writes
run asynchronously so they do not hold the response stream. `payFetch.flush?.()` waits for pending
records and fsyncs the local ledger during orderly shutdown. `startProxy` calls the rail's flush hook
after closing its listener, and direct rail users must call `payFetch.flush()` themselves. It waits for
active SSE responses too, so drain or cancel them before flushing; an open stream can keep the flush
pending. `payFetch.flush({ timeoutMs })` bounds the entire wait for records and ledger persistence
(0 through 2,147,483,647 ms). At the deadline it still attempts the ledger flush in the background,
then rejects with an `AggregateError` holding an `MppFlushTimeoutError`. Its `pending` field counts
unfinished records; `ledgerPending` indicates whether ledger flushing is still in progress.
A late ledger failure is reported once: by a flush still waiting on that ledger, otherwise by the next explicit flush. (Ownership is tracked per ledger promise; an integration that returns a fresh wrapper promise for the same failure to each caller can still see it twice.) A timeout does not confirm durability.
It never cancels or reads a response body, so a late reader still gets the whole paid response,
and its record lands when that body is drained. Network contribution remains off unless separately enabled. It blocks unscored
networks by default, including Tempo mainnet and Moderato, until TWZRD has a reputation corpus for
them. The default provider also fails closed on outages; the ledger sink itself makes no network
call. An explicit `allowUnscoredNetwork: true` requires `policy.maxAmountUsd` and returns
`reputation_unchecked` as a warning; warnings proceed unless `treatWarnAsBlock` is set. The
fulfillment row omits prompts, responses, credentials, and raw receipt headers; its seller model
field is explicitly a seller claim. Network contribution remains a separate opt-in.

This integration requires `twzrd-x402-gate@0.17.0`, which is not published yet. npm's current
`0.16.2` does not include Tempo charge evaluation or the shared-ledger adapter.

Receipt-safe payment metadata is available through `readPaidCallEvidence(response)` for a paid
response from this rail. The
fulfillment hook records the decoded receipt reference, never the raw base64 receipt or payment
credential. Tempo session receipts emitted in an SSE `payment-receipt` event are captured when the
response stream completes; the stream bytes are forwarded unchanged, including the seller-reported
model label from its first JSON data event. A `valid_format` receipt means its structure, method, and
intent match the challenge; it is not an on-chain verification. `seller_reported_model_matches_request`
compares labels only and does not verify model identity. A failed local write does not change an
already-paid response; `payFetch.flush()` surfaces persistence failures to the shutdown caller.

Rows use schema `twzrd.mpp.fulfillment.v3`. `response_bytes` and `body_sha256` (lowercase hex
SHA-256) describe the complete response body as the recorder read it: a JSON body read through its
clone, or an SSE body tapped to its end. Both are `null` when the recorder did not read the body,
it exceeded 1 MiB, or the stream was cancelled or errored before its end; a partial body is never
hashed. The digest is of bytes the seller sent and is not a seller attestation.

### Receipt reference chain verification (Solana, opt-in)

```ts
import { createReceiptChainVerifier, createSolanaMppFetch } from "@twzrd1111/clawrouter-mpp";

const verify = createReceiptChainVerifier({
  cluster: "mainnet", // must match the rail's network; a mismatch throws at construction
  getTransaction, // your finalized getTransaction (base64, maxSupportedTransactionVersion 0)
  index, // a durable ReceiptReferenceIndex with an atomic bind
  rpcTimeoutMs: 10_000, // per getTransaction call (the default); pass the given signal to fetch()
});
const payFetch = await createSolanaMppFetch({
  signer,
  rpcUrl,
  network: "mainnet",
  spend,
  integration,
  receiptVerification: { verify, finalityWaitMs: 30_000 },
});
```

The rail keeps the base64 wire transaction from the SDK's `signed` event, the buyer clock when it
fired, and a buyer-generated purchase id (every send of one credential is one purchase). After a
paid response, the recorder passes the seller's `valid_format` receipt reference with those facts to
the verifier and writes its result into the row:

- `receipt_reference_chain_verified` (`true`, `false`, or `null`), `receipt_reference_finalized_slot`,
  `receipt_reference_mismatch` (why `false`), and `receipt_reference_unverified_reason` (why `null`;
  `verifier_error` when the verifier threw).
- `receipt_reference_purchase_bound` and its reason. With opt-in `echo: { requireBinding: true }`
  and a cooperating seller, one exactly matching buyer memo can establish binding after chain
  verification. Otherwise it remains unbound; see `docs/echo-protocol.md`. Chain verification alone
  does not mean the payment belongs to this purchase alone.
- `receipt_reference_local_acceptance` (`accepted`, `refused`, or `null`) and
  `receipt_reference_refusal_reason` (`reference_reused`, `stale_by_local_clock`): this sink's
  policy, which never changes a chain field.

Verification never delays or changes the response. It delays only the row and `flush()`.
`finalityWaitMs` (default 0) re-checks a reference that is not finalized yet every `finalityPollMs`
(default 2000); with the default, an unfinalized reference is recorded as `null/not_finalized`.
`finalityWaitMs` is not an RPC timeout: each `getTransaction` call has its own deadline,
`rpcTimeoutMs` on the verifier (default 10000). When it passes, the fetcher's `signal` aborts and
the reference is recorded as `null/rpc_unavailable`. A row therefore waits at most about
`finalityWaitMs + rpcTimeoutMs` on the chain. The reference index has no deadline, so a durable
index must bound its own calls; `flush({ timeoutMs })` bounds only how long the caller waits.
No RPC URL ships with the package. `InMemoryReceiptReferenceIndex` forgets on restart and is for
tests. See `docs/receipt-chain-verify.md` for each check.

This candidate requires `@twzrd1111/clawrouter >=0.12.309`, including deferred streaming headers.
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

`SpentProofLedger` keeps claims in memory, so a restart or a second process forgets spent
proofs, and a proof can be redeemed again while its challenge is still valid. A seller with
more than one process, or one that restarts, needs a durable, atomic uniqueness check shared by
every worker (for example a unique key on network plus transaction signature, as an
authoritative settlement table provides). Rejecting expired challenges narrows the window but
does not close it on its own.

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
Each row carries the payment `reference` from the error (or from `fields.reference`) when one
is known, so a credit can be joined to the error and the spend record. The reference is a hash
of the signed payload, not a chain signature; an unknown reference is left off the row.

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
