# Using Subscriptions with ClawRouter Failover

This guide explains how to use your existing LLM subscriptions (Claude Pro/Max, ChatGPT Plus, etc.) as primary providers, with ClawRouter x402 micropayments as automatic failover.

## Why Not Built Into ClawRouter?

After careful consideration, we decided **not** to integrate subscription support directly into ClawRouter for several important reasons:

### 1. Terms of Service Compliance
- Most subscription ToS (Claude Code, ChatGPT Plus) are designed for personal use
- Using them through a proxy/API service may violate provider agreements
- We want to keep ClawRouter compliant and low-risk for all users

### 2. Security & Privacy
- Integrating subscriptions would require ClawRouter to access your credentials/sessions
- Spawning external processes (like Claude CLI) introduces security concerns
- Better to keep authentication at the OpenClaw layer where you control it

### 3. Maintenance & Flexibility
- Each subscription provider has different APIs, CLIs, and authentication methods
- OpenClaw already has a robust provider system that handles this
- Duplicating this in ClawRouter would increase complexity without added value

### 4. Better Architecture
- OpenClaw's native failover mechanism is more flexible and powerful
- Works with **any** provider (not just Claude)
- Zero code changes needed in ClawRouter
- You maintain full control over your credentials

## How It Works

OpenClaw has a built-in **model fallback chain** that automatically tries alternative providers when the primary fails:

```
User Request
    ↓
Primary Provider (e.g., Claude subscription via OpenClaw)
    ↓ (rate limited / quota exceeded / auth failed)
OpenClaw detects failure
    ↓
Fallback Chain (try each in order)
    ↓
ClawRouter (blockrun/auto)
    ↓
Smart routing picks cheapest model
    ↓
x402 micropayment to BlockRun API
    ↓
Response returned to user
```

**Key benefits:**
- ✅ Automatic failover (no manual intervention)
- ✅ Works with any subscription provider OpenClaw supports
- ✅ Respects provider ToS (you configure authentication directly)
- ✅ ClawRouter stays focused on cost optimization

## Setup Guide

### Prerequisites

1. **OpenClaw Gateway installed** with ClawRouter plugin
   ```bash
   npm install -g openclaw
   openclaw plugins install @blockrun/clawrouter
   ```

2. **Subscription configured in OpenClaw**
   - For Claude: Use `claude setup-token` or API key
   - For OpenAI: Set `OPENAI_API_KEY` environment variable
   - For others: See [OpenClaw provider docs](https://docs.openclaw.ai)

3. **ClawRouter wallet funded** (for failover)
   ```bash
   openclaw gateway logs | grep "Wallet:"
   # Send USDC to the displayed address on Base network
   ```

### Configuration Steps

#### Step 1: Set Primary Model (Your Subscription)

```bash
# Option A: Using Claude subscription
openclaw models set anthropic/claude-sonnet-4-5

# Option B: Using ChatGPT Plus (via OpenAI provider)
openclaw models set openai/gpt-4o

# Option C: Using any other provider
openclaw models set <provider>/<model>
```

#### Step 2: Add ClawRouter as Fallback

```bash
# Add blockrun/auto for smart routing (recommended)
openclaw models fallbacks add blockrun/auto

# Or specify a specific model
openclaw models fallbacks add blockrun/google/gemini-2.5-pro
```

#### Step 3: Verify Configuration

```bash
openclaw models show
```

Expected output:
```
Primary: anthropic/claude-sonnet-4-5
Fallbacks:
  1. blockrun/auto
```

#### Step 4: Test Failover (Optional)

To verify failover works:

1. **Temporarily exhaust your subscription quota** (or wait for rate limit)
2. **Make a request** - OpenClaw should automatically failover to ClawRouter
3. **Check logs:**
   ```bash
   openclaw gateway logs | grep -i "fallback\|blockrun"
   ```

### Advanced Configuration

#### Configure Multiple Fallbacks

```bash
openclaw models fallbacks add blockrun/google/gemini-2.5-flash  # Fast & cheap
openclaw models fallbacks add blockrun/deepseek/deepseek-chat   # Even cheaper
openclaw models fallbacks add blockrun/nvidia/gpt-oss-120b      # Free tier
```

#### Per-Agent Configuration

Edit `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "main": {
      "model": {
        "primary": "anthropic/claude-opus-4-5",
        "fallbacks": ["blockrun/auto"]
      }
    },
    "coding": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-5",
        "fallbacks": [
          "blockrun/google/gemini-2.5-pro",
          "blockrun/deepseek/deepseek-chat"
        ]
      }
    }
  }
}
```

#### Tier-Based Configuration (ClawRouter Smart Routing)

When using `blockrun/auto`, ClawRouter automatically classifies your request and picks the cheapest capable model:

- **SIMPLE** queries → Gemini 2.5 Flash, DeepSeek Chat (~$0.0001/req)
- **MEDIUM** queries → GPT-4o-mini, Gemini Flash (~$0.001/req)
- **COMPLEX** queries → Claude Sonnet, Gemini Pro (~$0.01/req)
- **REASONING** queries → DeepSeek R1, o3-mini (~$0.05/req)

Learn more: [ClawRouter Smart Routing](./smart-routing.md)

## Monitoring & Troubleshooting

### Check If Failover Is Working

```bash
# Watch real-time logs
openclaw gateway logs --follow | grep -i "fallback\|blockrun\|rate.limit\|quota"

# Check ClawRouter proxy logs
openclaw gateway logs | grep "ClawRouter"
```

**Success indicators:**
- ✅ "Rate limit reached" or "Quota exceeded" → primary failed
- ✅ "Trying fallback: blockrun/auto" → failover triggered
- ✅ "ClawRouter: Success with model" → failover succeeded

### Common Issues

#### Issue: Failover never triggers

**Symptoms:** Always uses primary, never switches to ClawRouter

**Solutions:**
1. Check fallbacks are configured:
   ```bash
   openclaw models show
   ```
2. Verify primary is actually failing (check provider dashboard for quota/rate limits)
3. Check OpenClaw logs for authentication errors

#### Issue: "Wallet empty" errors during failover

**Symptoms:** Failover triggers but ClawRouter returns balance errors

**Solutions:**
1. Check ClawRouter wallet balance:
   ```bash
   openclaw gateway logs | grep "Balance:"
   ```
2. Fund wallet on Base network (USDC)
3. Verify wallet key is configured correctly

#### Issue: Slow failover (high latency)

**Symptoms:** 5-10 second delay when switching to ClawRouter

**Cause:** OpenClaw tries multiple auth profiles before failover

**Solutions:**
1. Reduce auth profile retry attempts (see OpenClaw config)
2. Use `blockrun/auto` as primary for faster responses
3. Accept the latency as a tradeoff for cheaper requests

## Cost Analysis

### Example Scenario

**Usage pattern:**
- 100 requests/day
- 50% hit Claude subscription quota (rate limited)
- 50% use ClawRouter failover

**Without failover:**
- Pay Anthropic API: $50/month (100% API usage)

**With failover:**
- Claude subscription: $20/month (covers 50%)
- ClawRouter x402: ~$5/month (50 requests via smart routing)
- **Total: $25/month (50% savings)**

### When Does This Make Sense?

✅ **Good fit:**
- You already have a subscription for personal use
- You occasionally exceed quota/rate limits
- You want cost optimization without managing API keys

❌ **Not ideal:**
- You need 100% reliability (subscriptions have rate limits)
- You prefer a single provider (no failover complexity)
- Your usage is low (< 10 requests/day)

## FAQ

### Q: Will this violate my subscription ToS?

**A:** You configure the subscription directly in OpenClaw using your own credentials. ClawRouter only receives requests after your subscription fails. This is similar to using multiple API keys yourself.

However, each provider has different ToS. Check yours before proceeding:
- [Claude Code Terms](https://claude.ai/terms)
- [ChatGPT Terms](https://openai.com/policies/terms-of-use)

### Q: Can I use multiple subscriptions?

**A:** Yes! Configure multiple providers with failback chains:

```bash
openclaw models set anthropic/claude-opus-4-5
openclaw models fallbacks add openai/gpt-4o          # ChatGPT Plus
openclaw models fallbacks add blockrun/auto           # x402 as final fallback
```

### Q: Does this work with Claude Max API Proxy?

**A:** Yes! Configure the proxy as a custom provider in OpenClaw, then add `blockrun/auto` as fallback.

See: [Claude Max API Proxy Guide](https://github.com/anthropics/claude-code/blob/main/docs/providers/claude-max-api-proxy.md)

### Q: How is this different from PR #15?

**A:** PR #15 integrated Claude CLI directly into ClawRouter. Our approach:
- ✅ Works with any provider (not just Claude)
- ✅ Respects provider ToS (no proxy/wrapper)
- ✅ Uses OpenClaw's native failover (more reliable)
- ✅ Zero maintenance burden on ClawRouter

## Feedback & Support

We'd love to hear your experience with subscription failover:

- **GitHub Discussion:** [Share your setup](https://github.com/BlockRunAI/ClawRouter/discussions)
- **Issues:** [Report problems](https://github.com/BlockRunAI/ClawRouter/issues)
- **Telegram:** [Join community](https://t.me/blockrunAI)

## Related Documentation

- [OpenClaw Model Failover](https://docs.openclaw.ai/concepts/model-failover)
- [OpenClaw Provider Configuration](https://docs.openclaw.ai/gateway/configuration)
- [ClawRouter Smart Routing](./smart-routing.md)
- [ClawRouter x402 Micropayments](./x402-payments.md)
