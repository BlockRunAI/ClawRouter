---
name: release
description: Use this skill for EVERY ClawRouter release. Enforces the full checklist — version sync, CHANGELOG, build, tests, npm publish, git tag, GitHub release. No step can be skipped.
triggers:
  - "release clawrouter"
  - "ship clawrouter"
  - "publish clawrouter"
  - "version bump clawrouter"
  - "tag clawrouter release"
  - "npm publish clawrouter"
  - "clawrouter release"
---

# ClawRouter Release Checklist

**This skill is mandatory for every release. Execute every step in order. Do not skip.**

## Step 1: Confirm the New Version

Read the current version:

```bash
cat package.json | grep '"version"'
```

Ask: "What version are we releasing?" Confirm it follows semver and is higher than current.

---

## Step 2: Update `package.json` Version

Edit `package.json` — bump `"version"` to the new version.

---

## Step 3: Write CHANGELOG Entry

Open `CHANGELOG.md`. Add a new section at the top (after the header) in this format:

```markdown
## v{VERSION} — {DATE}

- **Feature/Fix name** — description
- **Feature/Fix name** — description
```

Rules:

- Date format: `Mar 8, 2026`
- One bullet per logical change
- Every bullet must be present — no "see git log"
- Include **all** changes since the previous release

---

## Step 4: Confirm No Manual Server Sync Required

**No file edit needed here.** Earlier releases (pre-v0.12.x) required manually
updating a `CURRENT_CLAWROUTER_VERSION` constant in blockrun's
`src/app/api/v1/chat/completions/route.ts`. That constant has been replaced:
the server now `fetch`-es `https://registry.npmjs.org/@blockrun/clawrouter/latest`
at process startup and uses the returned `version` to drive the
`update_available` hint embedded in 429 responses to outdated clients.

```typescript
// blockrun/src/app/api/v1/chat/completions/route.ts
let latestClawRouterVersion: string | null = process.env.CLAWROUTER_CURRENT_VERSION || null;
fetch("https://registry.npmjs.org/@blockrun/clawrouter/latest", {
  signal: AbortSignal.timeout(5000),
})
  .then((r) => r.json())
  .then((data) => {
    if (data.version) latestClawRouterVersion = data.version;
  })
  .catch(() => {
    /* keep env var fallback */
  });
```

Implications:

- The `npm publish` in Step 11 IS the entire "sync blockrun" action. After that
  step lands, the next blockrun server restart will fetch and surface the new
  version. No manual constant edit. No separate PR in the blockrun repo.
- `CLAWROUTER_CURRENT_VERSION` env var is the cold-start fallback (used only
  when the registry fetch fails). It exists for resilience, not as the
  primary mechanism — don't touch it on every release.
- Verification of the user-facing update nudge happens in Step 12 via
  `npm view @blockrun/clawrouter version` (the same registry endpoint
  blockrun's server hits).

Skip to Step 5.

---

## Step 5: Build

```bash
npm run build
```

Fix any TypeScript or build errors before proceeding.

---

## Step 6: Run Tests

```bash
npm test
npm run typecheck
npm run lint
```

All must pass. Fix failures before proceeding.

---

## Step 7: Commit Everything

Stage and commit:

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump version to {VERSION}"
```

No companion commit in the blockrun repo is needed — the server picks up
new versions automatically via the npm registry fetch documented in Step 4.

---

## Step 8: Push to GitHub

```bash
git push origin main
```

---

## Step 9: Create Git Tag

```bash
git tag v{VERSION}
git push origin v{VERSION}
```

---

## Step 10: Create GitHub Release

```bash
gh release create v{VERSION} \
  --title "v{VERSION}" \
  --notes "$(sed -n '/^## v{VERSION}/,/^## v[0-9]/p' CHANGELOG.md | head -n -1)"
```

Verify the release on GitHub: https://github.com/BlockRunAI/ClawRouter/releases

The release notes **must** match the CHANGELOG entry exactly.

---

## Step 11: Publish to npm

```bash
npm publish --access public
```

Verify: https://npmjs.com/package/@blockrun/clawrouter

Expected output: `+ @blockrun/clawrouter@{VERSION}`

---

## Step 12: Final Verification

Run this checklist to confirm everything is in sync:

```bash
# 1. package.json version
node -p 'require("./package.json").version'

# 2. CHANGELOG has the entry
head -10 CHANGELOG.md

# 3. npm package is live (this is also what blockrun's server fetches —
#    matching version here means the user-facing update nudge will fire correctly)
npm view @blockrun/clawrouter version

# 4. GitHub tag exists
git tag --list 'v{VERSION}'

# 5. GitHub release exists
gh release view v{VERSION}
```

All 5 must match the new version. If any mismatch, fix before declaring the release done.

---

## Common Mistakes (Never Repeat These)

| Mistake                                                      | Prevention                            |
| ------------------------------------------------------------ | ------------------------------------- |
| Hand-editing `CURRENT_CLAWROUTER_VERSION` (no longer exists) | Step 4 — server now auto-fetches      |
| CHANGELOG entry missing or incomplete                        | Step 3 — write it before building     |
| npm publish before tests pass                                | Steps 5-6 must precede Step 11        |
| GitHub release notes empty                                   | Step 10 — extract from CHANGELOG      |
| Git tag not pushed                                           | Step 9 — push tag separately          |
| docs not reflecting new features                             | Update docs in same PR as the feature |
