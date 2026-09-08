# ClawRouter Desktop 0.1.3 Preview

A refreshed Desktop control panel with clearer wallet, model, and usage views.

- Refreshed sidebar, model capability labels, Settings, and Buy/Deposit views.
- Live daily usage chart instead of placeholder bars.
- Correct pending-restart Agent and wallet status; distinguish API-key payment.
- Account credit links open through the approved system-browser path.
- Fixed narrow-window hero overflow and operation errors that left controls busy.
- Aligned the bundled ClawRouter runtime to 0.12.278.
- Includes the existing window-drag styles from Desktop 0.1.2.

## Download

macOS Apple Silicon: download the DMG, open it, and drag ClawRouter to Applications.
The ZIP contains the same app. Intel Mac and Windows packages are not included in
this release; do not use the arm64 Mac package on those platforms.

## macOS preview notice

This build is ad-hoc signed, **not Apple Developer ID signed or notarized**.
macOS may block the first launch because it cannot verify the developer. If you
trust this official download, use System Settings → Privacy & Security → Open
Anyway after the blocked launch. Do not disable Gatekeeper or clear quarantine.

## Validation scope

67 automated tests passed; 1 skipped. TypeScript, renderer/main/preload builds,
and the runtime version guard passed. Functional fixtures cover pending-restart
Agents, wallet activation, API-key payment, and approved account URLs. The
920px UI check confirms the routing graphic stays inside its card.

Per the requested scope, this release does not repeat full startup, physical
window-drag, or fresh-install acceptance testing. These results are not a claim
that every Agent harness or final installation path was re-tested.
