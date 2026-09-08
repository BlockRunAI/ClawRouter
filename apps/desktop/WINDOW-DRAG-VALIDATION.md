# 0.1.2 window drag validation

Tested on Apple Silicon macOS on 2026-09-07.

- Baseline installed 0.1.1: dragging the Overview title selects text instead of
  moving the window. Its renderer contains no app-region declarations.
- Four source contract tests pass: stylesheet import, draggable title/brand,
  no-drag interactive controls, and fixed-strip layout/edge exclusions.
- Built 0.1.2 DMG launches its real packaged application. The rendered document
  URL identifies the mounted 0.1.2 bundle, not the installed 0.1.1 copy.
- Repeating the same title drag moves the window without selecting title text.
  Brand-area dragging also works. After scrolling the model catalog, the top
  strip still moves the window; the cursor remains anchored to the grabbed
  point in the window-relative screenshots.
- Theme toggles to dark and back to light. Models navigation and scrolling work.
  The Add funds dialog opens and closes. No purchase or agent configuration
  mutation was performed for these tests.
- 678 existing application-archive files are unchanged. Only package metadata,
  the renderer HTML stylesheet link, and the new drag stylesheet differ from
  0.1.1. The packaged CSS exactly matches the regression-tested source.
- Strict deep signature validation passes before packaging and on the app
  mounted from the finished DMG. DMG checksum and ZIP integrity validation
  pass. The compressed HFS+ DMG is 278,519,577 bytes (previous
  0.1.1 DMG: 503,244,240 bytes).

This validates window interactions and package launch, not a full regression of
all agent integrations or payments. It is a locally built ad-hoc preview, not
proof of warning-free first launch on a fresh Mac. Browser-downloaded builds
may still need explicit first-launch approval. No quarantine metadata or
Gatekeeper protections were disabled.
