# ClawRouter Desktop 0.1.1 preview — macOS signing hotfix

This Apple Silicon preview fixes the invalid assembled-app signature in the
previous `desktop-v0.1.0-preview.1` download. The application and its nested
Mach-O executables are re-signed with an ad-hoc signature and a sealed resource
manifest. The application version is now 0.1.1.

This is a **signing-only repack**, not a runtime or feature update. It preserves
the original application logic and bundled `@blockrun/clawrouter@0.12.266`.
It does not include later unreleased Desktop changes.

## Download and install

- Apple Silicon Mac: download `ClawRouter-0.1.1-arm64.dmg`, open it, and drag
  ClawRouter into Applications. A ZIP is available as an alternative.
- Quit the old application before replacing it. Existing wallet and agent
  configuration files are not part of the installer and are not removed.
- This preview is **not Apple Developer ID signed or notarized**. macOS may
  block the first launch. Only if you trust this official download, use the
  macOS Privacy & Security “Open Anyway” approval flow. Managed Macs may not
  permit it. This release does not bypass Gatekeeper or clear quarantine.
- Apple-trusted, warning-free installation still requires a future Developer ID
  signed and notarized release. No Windows or Intel Mac build is included here.

## Reproduction

The source DMG is the original public 0.1.0 release asset, SHA-256:

`0b687450d3d621fad0da0cb292dfe528aa963199cfeb9842a1a0f97beed9c954`

Mount that image read-only, then run on macOS:

```sh
node apps/desktop/scripts/repack-signing-hotfix.mjs \
  /path/to/ClawRouter-0.1.0-arm64.dmg \
  /path/to/mounted/ClawRouter.app \
  /path/to/desktop/package.json
```

The last path supplies installed build dependencies, including
`@electron/osx-sign@1.3.3` and `@electron/asar`. The script checks the original
DMG hash, preserves the main/preload code hashes, updates the ASAR integrity
header and version, signs nested code before the outer app, and requires strict
deep signature verification and DMG integrity verification before producing
checksums and build provenance. Signing traversal visits physical files without
following pnpm symlink graphs. The script does not change installed applications
or user configurations.

Release assets include `SHA256SUMS.txt` and `BUILD-PROVENANCE.json`.
