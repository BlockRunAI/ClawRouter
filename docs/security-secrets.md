# Security: Secrets, Wallet Material, and Local State

This document defines secure defaults for ClawRouter operators and contributors.

## 1) Never persist seed material in plaintext

High-risk secrets must not be written to disk unencrypted:

- wallet mnemonic / seed phrase
- private keys
- exported wallet seeds
- long-lived API tokens

If persistence is required, use OS-backed secure storage (Keychain / Secret Service / KMS).

---

## 2) Token handling

- Read tokens from env at runtime
- Avoid printing tokens in logs
- Redact sensitive values in diagnostics and errors
- Prefer short-lived credentials when possible

---

## 3) File permissions are defense-in-depth, not primary protection

`chmod 600` is useful but **not sufficient** for critical key material.

Treat local files as potentially recoverable through:

- backups
- endpoint compromise
- misconfigured sync

---

## 4) Contributor checklist for security-sensitive PRs

Before merge:

- [ ] Secret-bearing files are avoided or encrypted
- [ ] Logs do not leak secrets
- [ ] New env vars are documented with risk level
- [ ] Fallback paths do not silently downgrade security
- [ ] Migration/cleanup steps exist for legacy insecure state

---

## 5) Incident response

If potential secret leakage is discovered:

1. Rotate impacted credentials immediately
2. Revoke/replace wallet material if applicable
3. Add temporary guardrails to block re-introduction
4. Publish a patch + security note
