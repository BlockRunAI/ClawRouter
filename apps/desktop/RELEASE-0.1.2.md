# ClawRouter Desktop 0.1.2 preview — window dragging fix

Fixes macOS window dragging in the Desktop preview:

- Drag the page title/header or the upper-left ClawRouter brand area to move
  the window, instead of accidentally selecting text.
- A narrow, fixed top drag strip remains available while the page is scrolled.
  It avoids the native window controls and right-side scrollbar.
- Theme, GitHub, refresh, and other header controls remain clickable. Page
  content is not made draggable, preserving scrolling and text selection.

This is a focused UI hotfix on 0.1.1. It preserves the application main/preload
code and bundled `@blockrun/clawrouter@0.12.266`; unrelated unpublished Desktop
features and runtime changes are not included.

## Install (Apple Silicon Mac)

Download `ClawRouter-0.1.2-arm64.dmg`, quit the old app, open the image, and drag
ClawRouter into Applications. Alternatively, unpack the ZIP and move the app
into Applications. Existing wallets and agent configuration are retained.

This preview has a valid **ad-hoc signature**, but is **not Apple Developer ID
signed or notarized**. If macOS blocks first launch, and you trust this official
download, open System Settings → Privacy & Security → Open Anyway for ClawRouter,
then confirm. macOS normally remembers that approval for the app; a new build or
a different Mac may require another approval. Managed-device policies may
prevent overrides. Do not disable Gatekeeper or remove quarantine attributes.

## Build provenance

This release uses the checksum-pinned public 0.1.1 DMG as its baseline. The
source `src/window-drag.css` is both imported by normal source builds and added
as an external stylesheet to this hotfix renderer. Main/preload hashes remain
unchanged. `SHA256SUMS.txt` and `BUILD-PROVENANCE.json` accompany the assets.

To reproduce with installed Desktop build dependencies:

```sh
node --test apps/desktop/tests/window-drag.test.mjs
node apps/desktop/scripts/repack-signing-hotfix.mjs \
  /path/to/ClawRouter-0.1.1-arm64.dmg \
  /path/to/read-only-mounted/ClawRouter.app \
  /path/to/desktop/package.json --window-drag
```

The packager applies nested-first ad-hoc signing and verifies strict/deep app
signatures and DMG integrity before producing release checksums. The DMG uses
compressed HFS+ packaging; the application runtime is unchanged.
