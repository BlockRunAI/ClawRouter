# Security Policy

ClawRouter holds a wallet and signs real USDC payments, or spends a prepaid
BlockRun account, so we take reports seriously. Thank you for helping keep its
users safe.

## Reporting a vulnerability

Please report privately through GitHub:
**[Report a vulnerability](https://github.com/BlockRunAI/ClawRouter/security/advisories/new)**
(Security tab → "Report a vulnerability").

If you cannot use GitHub, email **hello@blockrun.ai** with the subject
"Security report". Do not open a public issue, pull request or discussion for
a vulnerability.

A useful report includes:

- the affected version or commit
- steps to reproduce, or a proof of concept
- the impact you see (what an attacker can read, spend or change)

## What to expect

- **Acknowledgement within 48 hours.**
- An assessment and a fix plan within 7 days of confirming the issue.
- Fixes are developed in a private advisory fork and shipped in a patch
  release. The advisory is published after the fixed version is on npm.

## Supported versions

Only the latest release on npm (`@blockrun/clawrouter@latest`) receives
security fixes. Please upgrade before reporting.

## Recognition

We do not run a paid bug bounty. Reporters are credited by name in the
published GitHub advisory and in the release notes, unless they ask to stay
anonymous.

## Scope

In scope: this repository: the ClawRouter CLI, the local proxy (port 8402 by
default), the OpenClaw plugin, and how they handle wallet keys, API keys,
payments and spend limits.

Out of scope: vulnerabilities in third-party models, gateways or chains
ClawRouter talks to (report those to their owners); social engineering; and
denial of service that needs local access to the user's machine.
