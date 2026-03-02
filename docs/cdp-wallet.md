# CDP Wallet Support

ClawRouter supports **Coinbase Developer Platform (CDP) MPC wallets** as an alternative to raw private keys for x402 payments.

## Why CDP?

| Feature | Raw Private Key | CDP MPC Wallet |
|---------|----------------|----------------|
| Key storage | Single file on disk | Distributed MPC — no single key |
| Recovery | Manual backup required | Coinbase-managed recovery |
| Setup | Auto-generated | Requires CDP API key |
| Best for | Individual use, quick start | Teams, production agents |

## Setup

### 1. Create a CDP API Key

1. Go to [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com)
2. Create a new API key
3. Download the API key name and private key

### 2. Configure ClawRouter

**Option A — Environment variables (recommended for production):**

```bash
export BLOCKRUN_CDP_API_KEY_NAME="organizations/xxx/apiKeys/yyy"
export BLOCKRUN_CDP_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----\n..."

# Optional: reuse an existing wallet
export BLOCKRUN_CDP_WALLET_ID="your-wallet-id"
```

**Option B — Interactive wizard:**

```
/auth blockrun
# Select: "Coinbase CDP Wallet (MPC — recommended)"
# Enter your CDP API key name and private key when prompted
```

### 3. Fund Your Wallet

On first run, ClawRouter creates a new MPC wallet and prints its address. Fund it with USDC on Base:

- Coinbase app → Send USDC → Base network → your address
- Or bridge USDC from any chain to Base

## How It Works

```
Request → ClawRouter → CDP signs EIP-712 → x402 USDC payment → BlockRun API → Response
```

1. ClawRouter detects CDP credentials at startup
2. Loads or creates an MPC wallet via Coinbase API
3. Wallet signs `TransferWithAuthorization` typed data for each payment
4. Signing happens via Coinbase MPC — private key never fully reconstructed
5. USDC payment authorized on Base L2

## Wallet File

CDP wallet metadata is saved to:
```
~/.openclaw/blockrun/cdp/wallet.json
```

This file contains the wallet ID, address, and encrypted seed. **Back this up** along with your CDP API credentials.

## Fallback Behavior

If CDP credentials are set but wallet initialization fails, ClawRouter automatically falls back to the raw private key wallet and logs a warning.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BLOCKRUN_CDP_API_KEY_NAME` | Yes | CDP API key name from portal.cdp.coinbase.com |
| `BLOCKRUN_CDP_PRIVATE_KEY` | Yes | CDP API private key |
| `BLOCKRUN_CDP_WALLET_ID` | No | Reuse an existing CDP wallet by ID |
