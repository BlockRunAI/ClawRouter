# @twzrd/clawrouter-mpp

MPP (Machine Payments Protocol) payment rails for [ClawRouter](https://github.com/BlockRunAI/ClawRouter):
pay an MPP seller over **Tempo** or **Solana** instead of x402, under ClawRouter's own spend limits.

```ts
import { startProxy, SpendControl, FileSpendControlStorage } from "@blockrun/clawrouter";
import { createMppFetch, createSolanaMppFetch } from "@twzrd/clawrouter-mpp";

const spend = new SpendControl({ storage: new FileSpendControlStorage() });

// Tempo (needs `mppx`)
const payFetch = createMppFetch(account, fetch, { spend });
// or Solana (needs `@solana/pay-kit`)
// const payFetch = await createSolanaMppFetch({ signer, rpcUrl, network: "devnet", spend });

await startProxy({ spendControl: spend, payFetch /* ... */ });
```

Requires a ClawRouter release that includes the `payFetch` seam (`>=0.12.307`; upstream PR pending).

## What it guarantees

- **Spend limits apply.** The amount, network, asset and payee are checked, and budget reserved, *before*
  anything is signed. Payee lists on Solana are checked at the challenge event and fail closed.
  The proxy refuses to start a rail that does not set `enforcesSpend` while amount limits are configured.
- **A signed payment is never paid twice.** If a call fails after a credential or transaction was signed, it
  ends in `MppPaidNoCompletionError`: the proxy answers 502 `payment_settled_no_completion` and does not
  retry or fall back. The spend ledger keeps the spend with a note, and the error carries a payment
  reference (`mpp-<16 hex>`, a hash of the signed payload) for disputes.
- **Optional peers.** `mppx` and `@solana/pay-kit` are loaded on the first paid call; a missing one produces an
  install instruction, not a crash at import.

"Signed" is not "settled": on Solana the seller submits the transaction. Not covered: failures that happen
mid-stream, and seller-side refunds.

## Develop

```
npm install   # from the ClawRouter repo root
npm run typecheck && npm test && npm run build   # in packages/clawrouter-mpp
```

Tests resolve `@blockrun/clawrouter` to the repo source until the seam is released.
