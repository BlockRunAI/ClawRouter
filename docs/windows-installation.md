# Windows Installation Guide

## Current Status

**⚠️ Windows installation is temporarily unavailable** due to an OpenClaw CLI bug.

### The Issue

When attempting to install ClawRouter on Windows, users encounter this error:

```
Error: spawn EINVAL
at ChildProcess.spawn (node:internal/child_process:420:11)
```

This is an **OpenClaw framework bug**, not a ClawRouter issue. The OpenClaw CLI cannot spawn child processes correctly on Windows. ClawRouter itself is fully compatible with Windows - our code works perfectly once installed.

## Recommended Approach

**Wait for OpenClaw to fix Windows support.** ClawRouter works perfectly on:
- ✅ **Linux** (Ubuntu, Debian, RHEL, Alpine, etc.)
- ✅ **macOS** (Intel and Apple Silicon)

## Manual Installation (Advanced Users)

If you need Windows support immediately, you can install ClawRouter manually:

### Prerequisites

```powershell
# Install Node.js 20+ and npm
# Download from: https://nodejs.org/

# Install OpenClaw globally
npm install -g openclaw@latest
```

### Step 1: Install Plugin Manually

```powershell
# Navigate to OpenClaw plugins directory
cd $env:USERPROFILE\.openclaw\plugins

# Create directory if it doesn't exist
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.openclaw\plugins"

# Install ClawRouter directly
npm install @blockrun/clawrouter@latest
```

### Step 2: Configure OpenClaw

Edit `%USERPROFILE%\.openclaw\openclaw.json` and add the BlockRun provider:

```json
{
  "models": {
    "providers": {
      "blockrun": {
        "baseUrl": "https://api.blockrun.ai",
        "api": "blockrun",
        "models": [
          {
            "id": "auto",
            "name": "Smart Router",
            "api": "blockrun",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 3, "output": 15 }
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "blockrun/auto"
      }
    }
  }
}
```

### Step 3: Start Gateway

```powershell
openclaw gateway restart
```

### Step 4: Fund Your Wallet

The wallet address will be displayed in the gateway logs or use the `/wallet` command in OpenClaw.

Fund it with $5 USDC on Base network:
- Coinbase: Buy USDC, send to Base
- Bridge: Move USDC from any chain to Base
- CEX: Withdraw USDC to Base network

## Testing Infrastructure

ClawRouter has full Windows testing infrastructure ready:
- **GitHub Actions workflow**: [.github/workflows/test-windows.yml](../.github/workflows/test-windows.yml)
- **Windows test script**: [test/test-model-selection.ps1](../test/test-model-selection.ps1)
- **Docker support**: [test/Dockerfile.windows](../test/Dockerfile.windows)

Once OpenClaw fixes their Windows CLI bug, our tests will automatically verify Windows compatibility.

## Troubleshooting

### "Plugin not found" Error

The plugin was installed manually, so OpenClaw might not detect it. Restart the gateway:

```powershell
openclaw gateway stop
openclaw gateway start
```

### Wallet Not Generated

ClawRouter auto-generates a wallet at `%USERPROFILE%\.openclaw\blockrun\wallet.key`. If it wasn't created:

```powershell
# Create directory
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.openclaw\blockrun"

# Generate wallet using ClawRouter directly (requires Node.js code)
```

Alternatively, use your own wallet:

```powershell
$env:BLOCKRUN_WALLET_KEY="0x..."
```

### Proxy Not Starting

Check if the proxy is running:

```powershell
curl http://localhost:8402/health
```

If not running, check gateway logs for errors.

## Updates

**How to get updates once OpenClaw fixes Windows support:**

```powershell
# Once official support is available:
openclaw plugins update @blockrun/clawrouter

# Or reinstall:
openclaw plugins uninstall @blockrun/clawrouter
openclaw plugins install @blockrun/clawrouter@latest
```

## Support

- **GitHub Issues**: [BlockRunAI/ClawRouter](https://github.com/BlockRunAI/ClawRouter/issues)
- **Telegram**: [t.me/blockrunAI](https://t.me/blockrunAI)
- **X/Twitter**: [@BlockRunAI](https://x.com/BlockRunAI)

---

**Status updated**: February 11, 2026

ClawRouter is ready for Windows. We're waiting on OpenClaw to fix their CLI bug.
