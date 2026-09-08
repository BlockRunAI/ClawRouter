# PR 367 local integration check

Date: 2026-09-08. Local only; no push, merge to main, or release.

## Inputs and conflict resolution

- PR 367: `e39eb8e34aba6655ea550c94254c1459e60bcf91`.
- Preview drag/signing branch: `2fef479981949bd345acdce8bc278137760b9418`.
- Local merge: `5778190`, branch `codex/test-desktop-pr367-integration`.
- Five conflicts: Desktop package scripts, three runtime manifest/lock files,
  and runtime-version test. Preserved the PR-side runtime version and packaging
  guard; did not downgrade to the preview's older runtime.
- Adapted the imported drag tests from node:test to the existing Vitest runner.
  Before adaptation, npm test failed to discover that suite despite node:test
  reporting its four checks as passed.

## Passed

- TypeScript check.
- Vitest: 50 passed, 1 skipped (9 passed files, 1 skipped).
- Renderer and Electron main/preload compilation.
- Drag CSS import, drag regions, interactive no-drag exclusions, fixed handle
  source-contract tests are included in the 50 passing tests.
- Built renderer launched in Electron 44 with isolated userData, no production
  preload, and demo API data. Overview/Wallet navigation and theme toggle worked.

## Not ready for release

- Pending-restart Codex fixture still returns `Connected` (App.tsx healthLabel).
- API-key Overview fixture still claims `settling on Base`.
- Wallet fixture with configured/active address mismatch shows both the old-wallet
  warning and `Active — all agents pay from this wallet`.
- The PR's narrow-layout defect is unchanged: hero-top retains fixed minimum
  columns while the media query targets hero. Previous 920px browser check showed
  the routing diagram beyond its containing card. The integration does not change
  these rules.
- `npm run verify:runtime` fails: app requests 0.12.278, lock stages 0.12.267.
  This mismatch predates integration and must be reconciled before packaging.

## Limits

- Reused installed dependencies of the same Desktop package versions; this was
  not a fresh dependency installation.
- Native drag attempts did not produce a conclusive window-move event; do not
  treat CSS tests as proof that physical dragging passes in the integrated app.
- No real Agent connect/disconnect, real wallet mutation, purchase, or inference.
- No DMG packaging, signing verification, or installation test in this run.
- Installed /Applications/ClawRouter.app was not replaced. Temporary native
  test process was stopped after testing.
