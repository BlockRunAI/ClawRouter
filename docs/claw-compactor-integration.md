# ClawRouter × Claw Compactor Integration Guide

This guide explains how to combine:

- **ClawRouter** (model routing + payment)
- **Claw Compactor** (context compression)

Together, they reduce cost from two directions:

1. **Fewer tokens sent** (Compactor)
2. **Lower $/token paid** (Router)

---

## Why combine them?

ClawRouter alone optimizes model choice.
Claw Compactor alone optimizes context size.

Using both usually gives better savings than either one alone.

---

## Recommended order in request pipeline

```text
OpenClaw request
  -> Claw Compactor (compress context)
  -> ClawRouter (route to lowest-cost capable model)
  -> Provider
```

Compaction should happen **before routing**, so router sees the real token footprint.

---

## Practical setup

1. Install and enable ClawRouter plugin
2. Install Claw Compactor in your workspace
3. Enable Compactor auto mode (or hook mode)
4. Keep ClawRouter on `auto` profile

---

## Validation checklist

Use the same workload and compare:

- Baseline: no compaction + fixed expensive model
- Router only
- Compactor only
- Router + Compactor

Track:

- input/output tokens
- effective $/request
- p95 latency
- task quality / regression rate

---

## Safety notes

- Keep compression deterministic and reversible where possible
- Do not compress secrets into logs or headers
- Audit tool-output compression for semantic loss before production rollout

---

## What ClawRouter already includes

ClawRouter contains built-in context compression layers inspired by Claw Compactor (dictionary, observation compression, dynamic codebook).

Use external Claw Compactor when you need:

- workspace-level file compression workflows
- custom memory/markdown compression policies
- explicit per-run savings reporting in chat

---

## Attribution

Parts of ClawRouter compression architecture are inspired by Claw Compactor design patterns.
