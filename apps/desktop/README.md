# ClawRouter Desktop

ClawRouter Desktop is a local control plane for OpenClaw, Codex, Hermes,
DeepSeek Harness (DSH), and Pi. The renderer never receives filesystem or
process access; a sandboxed Electron preload exposes a narrow IPC API to the
main process.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
npm start
```

`npm run dist` builds and packages the app with the pinned Codex bridge, DSH,
and Pi runtimes. ClawRouter itself is installed from the current npm release on
first use so the Desktop cannot ship an obsolete routing/plugin lifecycle.
Electron 44 embeds Node 24, so end users do not need a separate Node
installation. Hermes remains installed in Hermes' own Python environment.

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

Both services bind to loopback. Port 8402 must prove possession of a private
Desktop token before it is reused. For newly spawned services, the supervisor
also verifies that the listening process belongs to the child process tree; it
never kills or trusts an unknown owner.

## DSH status

DSH is still a developer preview and does not publish official GitHub release
binaries. Installing its npm dependency graph at click time is too slow for a
credible one-click experience, so release builds pre-package its pinned runtime.
The adapter writes the current `settings.yaml` provider shape and the versioned
`.credentials.yaml` (`version: 1`, `refs:`) used by the official harness.
