# 0.1.1 signing hotfix validation

Validated on a local Apple Silicon Mac on 2026-09-07.

- Original public DMG: valid disk-image checksum, but strict app signature
  verification failed with “code has no resources but signature indicates they
  must be present.” Its signature identified Electron, without a bound plist or
  sealed resource manifest.
- Repacked application: `ai.blockrun.clawrouter.desktop`, ad-hoc hardened-runtime
  signature, bound Info.plist, sealed resources. Nested-first signing completed.
- `codesign --verify --deep --strict --verbose=2`: passed, both before packaging
  and against the application mounted from the finished DMG.
- `hdiutil verify`: passed for the completed DMG.
- All 679 non-package-metadata files in the application ASAR are byte-identical
  to the original release. Main/preload hashes are recorded in asset provenance.
- Actual application launch from the new DMG: passed. The rendered document URL
  points into the new mounted application, not the previously installed copy.
  The overview, existing connection statuses, and wallet balances loaded.
- Gatekeeper assessment: rejected, as expected for an ad-hoc application without
  Apple Developer ID/notarization. No Gatekeeper settings were changed and no
  quarantine attribute was removed. This is not proof of unattended installation
  on a fresh Mac; first-launch approval and managed-device restrictions remain.
- Agent connect/disconnect, payments, and runtime updates are outside this
  signing-only hotfix's validation. They are not claimed as newly tested here.

The original installed application was not overwritten. No wallet secrets,
user configuration files, or local screenshots are included in this release.
