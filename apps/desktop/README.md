# ClawRouter Desktop

ClawRouter Desktop is the macOS control plane for OpenClaw, Codex, Hermes,
DeepSeek Harness (DSH), and Pi. It starts a loopback-only ClawRouter proxy,
shows the shared Base and Solana wallets, exposes the model catalog with price
and context metadata, and connects or restores each supported agent from one
place.

The renderer never receives filesystem or process access. A sandboxed Electron
preload exposes a narrow, validated IPC API to the main process.

## Development

```bash
nvm use 24
npm install
npm test
npm run typecheck
npm run build
npm start
```

Run these commands from `apps/desktop`. Node 22.19 or newer is required to
build the app; Node 24 is used in CI.

`npm run dist` installs the pinned dependency graph in `runtime/`, then stages
the current repository's built ClawRouter package over the pinned copy before
packaging. This keeps the Desktop release and the repository commit on exactly
the same wallet, routing, and model implementation. Release builds also include
the Codex Responses bridge, DSH, and Pi. Electron 44 embeds Node 24, so end
users do not need a separate Node installation. Hermes remains installed in
Hermes' own Python environment.

Generated directories (`node_modules`, `dist`, `dist-electron`, `release`, and
`runtime/node_modules`) are deliberately excluded from Git.

## Wallets and funding

Desktop uses the same BlockRun Core wallets as the CLI and other BlockRun
products:

- Base: `~/.blockrun/.session`
- Solana: `~/.blockrun/.solana-session`

An explicit `BLOCKRUN_WALLET_KEY` or `SOLANA_WALLET_KEY` remains the highest
priority override. Existing legacy ClawRouter wallets continue to work as a
fallback. The app reads balances directly from Base and Solana RPC endpoints;
private keys never enter the renderer.

The **Add funds** action asks the BlockRun endpoint for a short-lived,
wallet-bound Coinbase Onramp URL. Only HTTPS links hosted by
`pay.coinbase.com` may be opened by the renderer.

## One-click contract

Every adapter follows the same transaction:

1. Snapshot the exact current configuration and permissions.
2. Ensure the local proxy (and the Codex bridge when needed) is healthy.
3. Apply only that agent's ClawRouter integration.
4. Verify the resulting files and endpoint.
5. Roll back the current attempt on any failure.

"Restore previous config" restores the original bytes and mode captured before
the first Desktop-managed install. Cached runtime packages may remain on disk;
they are inert and do not change the agent's configuration.

## Local endpoints

- ClawRouter OpenAI-compatible API: `http://127.0.0.1:8402/v1`
- Codex Responses bridge: `http://127.0.0.1:8403/v1`
- Control-plane model metadata: `http://127.0.0.1:8402/admin/models`

Both services bind to loopback. The supervisor verifies the response shape
before trusting an already occupied port and never kills an unknown owner.

## DSH status

DSH is still a developer preview and does not publish official GitHub release
binaries. Installing its npm dependency graph at click time is too slow for a
credible one-click experience, so release builds pre-package its pinned
runtime. The adapter writes the current `settings.yaml` provider shape and the versioned
`.credentials.yaml` (`version: 1`, `refs:`) used by the official harness.
