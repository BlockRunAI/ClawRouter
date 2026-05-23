---
name: phone
description: Verify phone numbers (carrier + SIM-swap fraud signals) and place AI-powered outbound voice calls via BlockRun's gateway (Twilio + Bland.ai). Trigger when the user asks to look up a number, check fraud risk, buy/rent a phone number, or place an AI voice call. Payment is automatic via x402 from the wallet.
triggers:
  - "blockrun phone"
  - "blockrun voice"
  - "voice call"
  - "outbound call"
  - "ai phone call"
  - "ai voice call"
  - "phone number lookup"
  - "phone number verification"
  - "carrier lookup"
  - "sim swap"
  - "sim-swap detection"
  - "phone fraud check"
  - "buy phone number"
  - "rent phone number"
  - "twilio number"
  - "bland.ai"
  - "blockrun bland"
metadata: { "openclaw": { "emoji": "📞", "requires": { "config": ["models.providers.blockrun"] } } }
---

# Phone & Voice

Phone-number intelligence (Twilio Lookup) and AI-powered outbound voice calls (Bland.ai) through ClawRouter's local proxy. Payment is automatic via x402 from the user's BlockRun wallet.

**Shortcuts:**

- Slash: `/cr-call +1<E.164> "<task>" [--voice nat] [--max-duration 5] [--from +1<owned-number>] [--language en-US]`
- CLI: `clawrouter phone numbers list/buy/renew/release`, `clawrouter phone lookup <+E.164>`, `clawrouter phone fraud <+E.164>`
- Partner tools (LLM-callable): `blockrun_phone_lookup`, `blockrun_phone_lookup_fraud`, `blockrun_phone_numbers_buy/renew/list/release`, `blockrun_voice_call`, `blockrun_voice_status`

> **⚠️ Real-world side effects.** `blockrun_voice_call` places a real outbound phone call to a real number. Only invoke when the user has explicitly asked for a call to be placed. Server enforces an emergency-number blocklist.

---

## Phone Number Intelligence (Twilio)

### Carrier + Line Type Lookup — `$0.01`

POST to `http://localhost:8402/v1/phone/lookup`:

```json
{ "phoneNumber": "+14155552671" }
```

Returns carrier name, line type (`mobile` / `landline` / `voip`), country, mobile country/network codes. Use to verify whether a number is reachable, detect VoIP/spam patterns, or route SMS appropriately.

### Fraud Risk Check — `$0.05`

POST to `http://localhost:8402/v1/phone/lookup/fraud`:

```json
{ "phoneNumber": "+14155552671" }
```

Adds SIM-swap recency and call-forwarding signals on top of carrier+line type. **Run this before sending sensitive SMS codes or initiating account-recovery flows** — a number flagged for recent SIM swap is high-risk for account takeover.

---

## Wallet-Owned Phone Numbers

Numbers are leased for 30 days, bound to the wallet's payer address. Use one as the `from` parameter of `voice_call` to present a stable caller ID.

### Buy — `$5.00 / 30 days`

POST to `http://localhost:8402/v1/phone/numbers/buy`:

```json
{ "country": "US", "areaCode": "415" }
```

`country` is `"US"` or `"CA"`. `areaCode` is optional (3-digit, best-effort match). Returns `{ phone_number, expires_at, chain }`.

### Renew — `$5.00 / +30 days`

POST to `http://localhost:8402/v1/phone/numbers/renew`:

```json
{ "phoneNumber": "+14155551234" }
```

Run before the existing lease expires. Numbers not renewed are released back to the pool.

### List — `$0.001`

POST to `http://localhost:8402/v1/phone/numbers/list` with an empty body. Returns an array of `{ phone_number, expires_at, country, chain }`. The CLI surfaces this as a human table with renew-soon warnings:

```
$ clawrouter phone numbers list

Active numbers (2):
  +14155551234   US   expires 2026-06-12 (in 27d)
  +12135555678   US   expires 2026-05-18 (in 2d) ⚠ renew soon
```

### Release — free

POST to `http://localhost:8402/v1/phone/numbers/release`:

```json
{ "phoneNumber": "+14155551234" }
```

No refund. Use only when the user has explicitly asked to give up the number.

---

## AI Voice Call (Bland.ai)

### Place a Call — `$0.54 flat (up to 30 min)`

POST to `http://localhost:8402/v1/voice/call`:

```json
{
  "to": "+14155552671",
  "task": "Call and confirm the 3pm Thursday meeting; reschedule if they can't make it.",
  "voice": "nat",
  "max_duration": 5,
  "from": "+14155551234",
  "language": "en-US"
}
```

**Required:** `to` (E.164), `task` (free-form natural language — what the AI should say or accomplish).

**Optional:**

| Field          | Default     | Notes                                                                                                                                            |
| -------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `voice`        | `nat`       | Presets: `nat`, `josh`, `maya`, `june`, `paige`, `derek`, `florian`. Or a custom Bland voice ID.                                                 |
| `max_duration` | `5`         | Maximum minutes (1–30). Price is flat $0.54 regardless of actual duration.                                                                       |
| `from`         | auto-picked | Must be a wallet-owned number from `phone_numbers_list`. If omitted, server auto-picks from wallet's active numbers — see auto-pick rules below. |
| `language`     | `en-US`     | Any spoken-language ISO code, e.g. `es-ES`, `zh-CN`, `de-DE`.                                                                                    |

**`from` auto-pick rules** (server-side, after payment verification):

| Wallet active numbers | Behavior                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| 0                     | `403 no_active_number` — response includes `buy_endpoint` + marketplace URL so caller can provision first |
| Exactly 1             | Auto-used as caller ID                                                                                    |
| 2+                    | `400 ambiguous_from` — response lists all active numbers; retry with `from` set explicitly                |

If an explicit `from` is supplied but the wallet doesn't own it, the response is `403` with a clear ownership-mismatch message (no charge taken when validation fails).

**Response is fire-and-forget:**

```json
{
  "call_id": "call_abc123",
  "poll_url": "/v1/voice/call/call_abc123",
  "status": "queued"
}
```

The call runs in the cloud for up to `max_duration` minutes. The HTTP response returns immediately — **do not wait for the call to finish**. Poll `voice_status` every 10–30s to retrieve transcript and recording when the call completes.

### Poll Status — free

GET `http://localhost:8402/v1/voice/call/{call_id}`. Returns:

```json
{
  "call_id": "call_abc123",
  "status": "completed",
  "duration_seconds": 47,
  "transcript": [
    { "role": "assistant", "text": "Hi, this is calling to confirm tomorrow's 3pm meeting..." },
    { "role": "user", "text": "Yes, that still works." }
  ],
  "recording_url": "https://..."
}
```

`status` progresses through `queued` → `in_progress` → `completed` or `failed`. The transcript array and recording URL only appear on `completed`. On `failed`, an `error` field describes why.

---

## Example Agentic Flows

**Verify before texting:**

> User: "Send a verification code to +1 415 555 0123"
> Agent: First call `blockrun_phone_lookup_fraud({ phoneNumber: "+14155550123" })`. If `sim_swap.last_sim_swap` is within the past 7 days, refuse and ask the user to confirm out-of-band. Otherwise proceed.

**Appointment confirmation:**

> User: "Call my client at +1 415 555 0123 and confirm tomorrow's 3pm meeting"
> Agent: `blockrun_voice_call({ to: "+14155550123", task: "Call to confirm the 3pm Thursday meeting; if they can't make it, offer to reschedule for Friday morning.", max_duration: 5 })`. Returns `call_id`. Tell the user: "Calling now — I'll have the transcript in a few minutes." Then `blockrun_voice_status({ callId })` every 30s until `completed`, then summarize the transcript.

**Acquire dedicated caller ID:**

> User: "Buy me a San Francisco number for the next 30 days"
> Agent: `blockrun_phone_numbers_buy({ country: "US", areaCode: "415" })`. Confirm the assigned number to the user and warn them: "Lease expires in 30 days, costs $5 to renew."

---

## Notes

- Payment is automatic via x402 — deducted from the user's BlockRun wallet on every call
- If a call fails with a 402, tell the user to fund their wallet at [blockrun.ai](https://blockrun.ai)
- Phone numbers are real, regulated resources — numbers bought are reachable from any phone within ~60 seconds of purchase
- Bland.ai's emergency-number blocklist is enforced server-side; ClawRouter does not duplicate it but trusts upstream
- Recordings and transcripts are retained by Bland.ai; ClawRouter does not download them locally (returns the upstream URL)
- For programmatic polling, see the `voice_status` tool — for one-off CLI checks, hit `curl http://localhost:8402/v1/voice/call/{call_id}` directly
