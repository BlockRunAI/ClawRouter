# Spending Policies with LetAgentPay

ClawRouter answers *how* an agent pays — wallet signature for auth, USDC micropayments via x402, no API keys, no accounts. It does not answer *should this agent pay this amount right now*.

With a funded wallet and a runaway loop, an agent can drain its balance across hundreds of routed LLM calls in seconds. That's where a policy layer in front of the wallet helps.

[LetAgentPay](https://letagentpay.com) is a vendor-neutral spending policy engine — open-source ([repo](https://github.com/letagentpay/letagentpay), MIT, self-host or cloud) that runs 8 deterministic checks on a proposed spend before it leaves the agent.

This guide shows the integration pattern. Disclosure: I work on LetAgentPay. The doc lives in this repo because ClawRouter users have asked about budget caps and this gap is real.

## The pattern

A thin wrapper around your existing ClawRouter usage: ask the policy engine → call ClawRouter → confirm actual cost.

```typescript
import { LetAgentPay } from "letagentpay";
import { ClawRouter } from "@blockrun/clawrouter";

const policy = new LetAgentPay({ token: process.env.LETAGENTPAY_TOKEN! });
const router = new ClawRouter(/* your ClawRouter config */);

async function policedChat(opts: {
  messages: { role: string; content: string }[];
  estimatedCostUsd: number;
  description?: string;
}) {
  // 1. Pre-flight: ask the policy engine before the spend
  const purchase = await policy.requestPurchase({
    amount: opts.estimatedCostUsd,
    category: "llm_inference",
    merchantName: "ClawRouter",
    description: opts.description ?? "Routed LLM call",
  });

  if (purchase.status === "rejected") {
    throw new Error(`Policy denied: ${purchase.policyCheck?.failedCheck}`);
  }
  if (purchase.status === "pending") {
    throw new Error(`Policy escalated to human review: ${purchase.requestId}`);
  }

  // 2. Auto-approved — proceed with ClawRouter
  const result = await router.chat({ messages: opts.messages });

  // 3. Confirm actual x402-settled cost
  await policy.confirmPurchase(purchase.requestId, {
    success: true,
    actualAmount: result.costUsd,
  });

  return result;
}
```

## A starter policy

```json
{
  "version": "1.0",
  "daily_limit": 20.00,
  "per_request_limit": 1.00,
  "allowed_categories": ["llm_inference"],
  "schedule": {
    "timezone": "UTC",
    "default": { "allow": "00:00-23:59" }
  }
}
```

What this catches:

| Concern | Control |
| --- | --- |
| One runaway call draining the wallet | `per_request_limit` |
| A loop running all night | `daily_limit` + `schedule` |
| Agent spending outside intended scope | `allowed_categories` |
| Total wallet protection | `weekly_limit` / `monthly_limit` / account budget |

## Notes

- **Estimate conservatively.** ClawRouter picks the model after the call lands. Estimate worst-case (max model × max tokens), then `confirmPurchase` reports the real x402-settled amount. The held amount releases on confirm.
- **Failed routes.** If ClawRouter rejects the request, call `confirmPurchase` with `success: false` to release the hold.
- **Self-host.** LetAgentPay runs as a self-hostable service or as managed cloud. Same SDK either way.

## See also

- [LetAgentPay docs](https://letagentpay.com/docs) — full setup, policy reference, dashboard
- [ASPS spec](https://letagentpay.com/asps/spec) — open spec for agent spending policies, vendor-neutral
