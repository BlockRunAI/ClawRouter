# CHANGELOG

## [0.5.0] — 2026-11-07

**Echo Protocol purchase binding on Solana.**

- **PR #21** — Echo Protocol: per-call buyer entropy (`X-Buyer-Nonce`, 32 hex), seller reflects as `request.externalId: "twzrd:p:<nonce>"`, receipt verifier matches SPL Memo byte-for-byte. `echo: {}` offers binding then pays unbound; `echo: { requireBinding: true }` refuses unbound challenges. Echo is off-by-default.
- **PR #19** — Per-call deadline on `getTransaction` in the receipt verifier.
- **PR #18** — Fulfillment schema v3; wire chain verifier into Solana rail.

**Security (all prior):**
- SPL Memo v1 + v2 guard: malformed UTF-8, leading BOM, and multiple memos cannot silently match.
- 16-byte → 32-hex nonce format.
- Boundaries: buyer-side only; echo off by default; no proof-of-compute.

**No runtime changes** beyond PR #21. Durable SpentProofLedger deferred to a future release.

### Upgrade notes

See "Upgrading to 0.5.0 from 0.4.0" in the README for configuration details.

---

## [0.4.0] — 2026-10-24

**Receipt verification and fulfillment v3.**

- **PR #20** — Receipt verification release (packaging fix).
- **PR #19** — Per-call `getTransaction` deadline.
- **PR #18** — Fulfillment schema v3; chain verifier wiring into Solana rail.

---

## [0.3.x — 0.0.x]

Earlier releases under the Monorepo.
