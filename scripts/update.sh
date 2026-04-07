#!/bin/bash
set -e
set -o pipefail

# ─────────────────────────────────────────────────────────────
#  ClawRouter Update Script
#  Safe update: backs up wallet key BEFORE touching anything,
#  restores it if the update process somehow wiped it.
# ─────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$HOME/.openclaw/extensions/clawrouter"
CONFIG_PATH="$HOME/.openclaw/openclaw.json"
WALLET_FILE="$HOME/.openclaw/blockrun/wallet.key"
WALLET_BACKUP=""
PLUGIN_BACKUP=""
CONFIG_BACKUP=""

cleanup_backups() {
  if [ -n "$PLUGIN_BACKUP" ] && [ -d "$PLUGIN_BACKUP" ]; then
    rm -rf "$PLUGIN_BACKUP"
  fi
  if [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ]; then
    rm -f "$CONFIG_BACKUP"
  fi
}

restore_previous_install() {
  local exit_code=$?

  if [ "$exit_code" -ne 0 ]; then
    echo ""
    echo "✗ Update failed. Restoring previous ClawRouter install..."

    if [ -d "$PLUGIN_DIR" ] && [ "$PLUGIN_DIR" != "$PLUGIN_BACKUP" ]; then
      rm -rf "$PLUGIN_DIR"
    fi

    if [ -n "$PLUGIN_BACKUP" ] && [ -d "$PLUGIN_BACKUP" ]; then
      mv "$PLUGIN_BACKUP" "$PLUGIN_DIR"
      echo "  ✓ Restored previous plugin files"
    fi

    if [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ]; then
      cp "$CONFIG_BACKUP" "$CONFIG_PATH"
      echo "  ✓ Restored previous OpenClaw config"
    fi
  fi

  cleanup_backups
}

run_dependency_install() {
  local plugin_dir="$1"
  local log_file="$HOME/clawrouter-npm-install.log"

  echo "  (log: $log_file)"
  if (cd "$plugin_dir" && npm install --omit=dev >"$log_file" 2>&1); then
    tail -1 "$log_file"
  else
    echo ""
    echo "  ✗ npm install failed. Error log:"
    echo "  ─────────────────────────────────"
    tail -30 "$log_file" >&2 || true
    echo "  ─────────────────────────────────"
    echo ""
    echo "  Full log saved: $log_file"
    echo "  Send this file to @bc1max on Telegram for help."
    return 1
  fi
}

trap restore_previous_install EXIT

# Pre-flight: validate openclaw.json is parseable before touching anything
validate_config() {
  local config_path="$HOME/.openclaw/openclaw.json"
  if [ ! -f "$config_path" ]; then return 0; fi
  if ! node -e "JSON.parse(require('fs').readFileSync('$config_path','utf8'))" 2>/dev/null; then
    echo ""
    echo "✗ openclaw.json is corrupt (invalid JSON)."
    echo "  Fix it first: openclaw doctor --fix"
    echo "  Then re-run this script."
    echo ""
    exit 1
  fi
}

kill_port_processes() {
  local port="$1"
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti :"$port" 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser "$port"/tcp 2>/dev/null || true)"
  fi
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
}

# ── Step 1: Back up wallet key ─────────────────────────────────
echo "🦞 ClawRouter Update"
echo ""

# Pre-flight: fail fast if config is corrupt
validate_config

echo "→ Checking wallet..."

if [ -f "$WALLET_FILE" ]; then
  # Validate the key looks correct before backing up
  WALLET_KEY=$(cat "$WALLET_FILE" | tr -d '[:space:]')
  KEY_LEN=${#WALLET_KEY}

  if [[ "$WALLET_KEY" == 0x* ]] && [ "$KEY_LEN" -eq 66 ]; then
    # Derive wallet address via node (viem is available post-install)
    WALLET_ADDRESS=$(node -e "
      try {
        const { privateKeyToAccount } = require('$HOME/.openclaw/extensions/clawrouter/node_modules/viem/accounts/index.js');
        const acct = privateKeyToAccount('$WALLET_KEY');
        console.log(acct.address);
      } catch {
        // viem not available yet (fresh install path), skip address check
        console.log('(address check skipped)');
      }
    " 2>/dev/null || echo "(address check skipped)")

    WALLET_BACKUP="$HOME/.openclaw/blockrun/wallet.key.bak.$(date +%s)"
    cp "$WALLET_FILE" "$WALLET_BACKUP"
    chmod 600 "$WALLET_BACKUP"

    echo "  ✓ Wallet backed up to: $WALLET_BACKUP"
    echo "  ✓ Wallet address: $WALLET_ADDRESS"
  else
    echo "  ⚠ Wallet file exists but has invalid format (len=$KEY_LEN)"
    echo "  ⚠ Skipping backup — you should restore your wallet manually"
  fi
else
  echo "  ℹ No existing wallet found (first install or already lost)"
fi

echo ""

echo "→ Backing up existing install..."
if [ -d "$PLUGIN_DIR" ]; then
  PLUGIN_BACKUP="$HOME/.openclaw/extensions/clawrouter.backup.$(date +%s)"
  mv "$PLUGIN_DIR" "$PLUGIN_BACKUP"
  echo "  ✓ Plugin files staged at: $PLUGIN_BACKUP"
else
  echo "  ℹ No existing plugin files found"
fi

if [ -f "$CONFIG_PATH" ]; then
  CONFIG_BACKUP="$CONFIG_PATH.clawrouter-update.$(date +%s).bak"
  cp "$CONFIG_PATH" "$CONFIG_BACKUP"
  echo "  ✓ Config backed up to: $CONFIG_BACKUP"
fi

echo ""

# ── Step 1b: Remove Crossmint/lobster extension ───────────────
echo "→ Removing Crossmint/lobster extension..."
LOBSTER_DIR="$HOME/.openclaw/extensions/lobster.cash"
if [ -d "$LOBSTER_DIR" ]; then
  rm -rf "$LOBSTER_DIR"
  echo "  ✓ Removed $LOBSTER_DIR"
else
  echo "  ✓ Not installed"
fi
echo ""

# ── Step 2: Kill old proxy ──────────────────────────────────────
echo "→ Stopping old proxy..."
kill_port_processes 8402

# ── Step 3: Clean config and prepare for install ────────────────
# Single pass: clean stale entries, remove lobster, verify provider
echo "→ Cleaning config..."
node "$SCRIPT_DIR/setup-config.cjs" --clean-entries --clean-lobster --verify-provider

# ── Step 4: Install latest version ─────────────────────────────
# Back up channel config before install (may get wiped)
CREDS_DIR="$HOME/.openclaw/credentials"
CREDS_BACKUP=""
if [ -d "$CREDS_DIR" ] && [ "$(ls -A "$CREDS_DIR" 2>/dev/null)" ]; then
  CREDS_BACKUP="$(mktemp -d)/openclaw-credentials-backup"
  cp -a "$CREDS_DIR" "$CREDS_BACKUP"
  echo "  ✓ Backed up OpenClaw credentials"
fi

CHANNEL_BACKUP_FILE=""
if [ -f "$CONFIG_PATH" ]; then
  CHANNEL_BACKUP_FILE="$(mktemp)"
  node "$SCRIPT_DIR/setup-config.cjs" --backup-channels "$CHANNEL_BACKUP_FILE"
fi

echo "→ Installing latest ClawRouter..."
if command -v timeout >/dev/null 2>&1; then
  timeout 120 openclaw plugins install @blockrun/clawrouter || {
    exit_code=$?
    if [ $exit_code -eq 124 ]; then
      echo "  (install command timed out — this is normal with OpenClaw v2026.4.5)"
      echo "  Plugin was installed successfully before the hang."
    else
      exit $exit_code
    fi
  }
else
  openclaw plugins install @blockrun/clawrouter
fi

# Install is complete — clear the rollback trap immediately.
trap - EXIT INT TERM

# Restore credentials after plugin install
if [ -n "$CREDS_BACKUP" ] && [ -d "$CREDS_BACKUP" ]; then
  mkdir -p "$CREDS_DIR"
  cp -a "$CREDS_BACKUP/"* "$CREDS_DIR/"
  echo "  ✓ Restored OpenClaw credentials (channels preserved)"
  rm -rf "$(dirname "$CREDS_BACKUP")"
fi

# ── Step 4b: Verify version — force-update if openclaw served a stale cache ──
force_install_from_npm() {
  local version="$1"
  echo "  → Force-fetching v${version} directly from npm registry..."
  local TMPPACK
  TMPPACK=$(mktemp -d)
  if npm pack "@blockrun/clawrouter@${version}" --pack-destination "$TMPPACK" --prefer-online >/dev/null 2>&1; then
    local TARBALL
    TARBALL=$(ls "$TMPPACK"/blockrun-clawrouter-*.tgz 2>/dev/null | head -1)
    if [ -n "$TARBALL" ]; then
      rm -rf "$PLUGIN_DIR"
      mkdir -p "$PLUGIN_DIR"
      tar -xzf "$TARBALL" -C "$PLUGIN_DIR" --strip-components=1
      rm -rf "$TMPPACK"
      echo "  ✓ Force-installed v${version} from npm registry"
      return 0
    fi
  fi
  rm -rf "$TMPPACK"
  echo "  ✗ Force install failed"
  return 1
}

if [ -d "$PLUGIN_DIR" ] && [ -f "$PLUGIN_DIR/package.json" ]; then
  INSTALLED_VER=$(node -e "try{const p=require('$PLUGIN_DIR/package.json');console.log(p.version);}catch{console.log('');}" 2>/dev/null || echo "")
  LATEST_VER=$(npm view @blockrun/clawrouter@latest version 2>/dev/null || echo "")
  if [ -n "$LATEST_VER" ] && [ -n "$INSTALLED_VER" ] && [ "$INSTALLED_VER" != "$LATEST_VER" ]; then
    echo "  ⚠️  openclaw installed v${INSTALLED_VER} (cached) but latest is v${LATEST_VER}"
    force_install_from_npm "$LATEST_VER" || true
  fi
  INSTALLED_VER=$(node -e "try{const p=require('$PLUGIN_DIR/package.json');console.log(p.version);}catch{console.log('?');}" 2>/dev/null || echo "?")
  echo "  ✓ ClawRouter v${INSTALLED_VER} installed"
fi

# ── Step 4c: Ensure all dependencies are installed ────────────
if [ -d "$PLUGIN_DIR" ] && [ -f "$PLUGIN_DIR/package.json" ]; then
  echo "→ Installing dependencies (Solana, x402, etc.)..."
  run_dependency_install "$PLUGIN_DIR"
fi

# ── Step 5: Verify wallet survived ─────────────────────────────
echo ""
echo "→ Verifying wallet integrity..."

if [ -f "$WALLET_FILE" ]; then
  CURRENT_KEY=$(cat "$WALLET_FILE" | tr -d '[:space:]')
  CURRENT_LEN=${#CURRENT_KEY}

  if [[ "$CURRENT_KEY" == 0x* ]] && [ "$CURRENT_LEN" -eq 66 ]; then
    echo "  ✓ Wallet key intact at $WALLET_FILE"
  else
    echo "  ✗ Wallet file corrupted after update!"
    if [ -n "$WALLET_BACKUP" ] && [ -f "$WALLET_BACKUP" ]; then
      cp "$WALLET_BACKUP" "$WALLET_FILE"
      chmod 600 "$WALLET_FILE"
      echo "  ✓ Restored from backup: $WALLET_BACKUP"
    else
      echo "  ✗ No backup available — wallet key is lost"
      echo "     Restore manually: set BLOCKRUN_WALLET_KEY env var"
    fi
  fi
else
  echo "  ✗ Wallet file missing after update!"
  if [ -n "$WALLET_BACKUP" ] && [ -f "$WALLET_BACKUP" ]; then
    mkdir -p "$(dirname "$WALLET_FILE")"
    cp "$WALLET_BACKUP" "$WALLET_FILE"
    chmod 600 "$WALLET_FILE"
    echo "  ✓ Restored from backup: $WALLET_BACKUP"
  else
    echo "  ℹ New wallet will be generated on next gateway start"
  fi
fi

# ── Step 6: Post-install config setup ──────────────────────────
# Single pass: restore channels, populate allowlist, add to allow, set gateway.mode, inject auth, clean models cache
echo "→ Finalizing config..."
RESTORE_FLAG=""
if [ -n "$CHANNEL_BACKUP_FILE" ] && [ -f "$CHANNEL_BACKUP_FILE" ]; then
  RESTORE_FLAG="--restore-channels $CHANNEL_BACKUP_FILE"
fi
node "$SCRIPT_DIR/setup-config.cjs" \
  --verify-provider --populate-allowlist --add-to-allow \
  --set-gateway-mode --inject-auth $RESTORE_FLAG

if [ -n "$CHANNEL_BACKUP_FILE" ]; then
  rm -f "$CHANNEL_BACKUP_FILE"
fi

echo "→ Cleaning models cache..."
rm -f ~/.openclaw/agents/*/agent/models.json 2>/dev/null || true

# Clean up stale plugin backups
echo "→ Cleaning up stale plugin backups..."
CLEANED=0
for backup_dir in "$HOME/.openclaw/extensions/clawrouter.backup."*; do
  if [ -d "$backup_dir" ]; then
    rm -rf "$backup_dir"
    CLEANED=$((CLEANED + 1))
  fi
done
if [ "$CLEANED" -gt 0 ]; then
  echo "  ✓ Removed $CLEANED stale backup(s)"
else
  echo "  ✓ No stale backups found"
fi

# ── Summary ─────────────────────────────────────────────────────
echo ""
echo "✓ ClawRouter updated successfully!"
echo ""

# Show final wallet address
if [ -f "$WALLET_FILE" ]; then
  FINAL_KEY=$(cat "$WALLET_FILE" | tr -d '[:space:]')
  FINAL_ADDRESS=$(node -e "
    try {
      const { privateKeyToAccount } = require('$HOME/.openclaw/extensions/clawrouter/node_modules/viem/accounts/index.js');
      console.log(privateKeyToAccount('$FINAL_KEY').address);
    } catch { console.log('(run /wallet in OpenClaw to see your address)'); }
  " 2>/dev/null || echo "(run /wallet in OpenClaw to see your address)")

  echo "  Wallet: $FINAL_ADDRESS"
  echo "  Key file: $WALLET_FILE"
  if [ -n "$WALLET_BACKUP" ]; then
    echo "  Backup: $WALLET_BACKUP"
  fi
fi

echo ""

# Auto-restart gateway so new version is active immediately
echo "→ Restarting gateway..."
RESTART_OK=false
if systemctl --user is-active openclaw-gateway.service >/dev/null 2>&1 || \
   systemctl --user is-enabled openclaw-gateway.service >/dev/null 2>&1; then
  if systemctl --user restart openclaw-gateway.service 2>/dev/null; then
    for i in $(seq 1 15); do
      sleep 1
      if curl -sf --connect-timeout 1 http://localhost:8402/v1/models >/dev/null 2>&1; then
        RESTART_OK=true
        break
      fi
    done
    if $RESTART_OK; then
      echo "  ✓ Gateway restarted — ClawRouter active on port 8402"
    else
      echo "  ⚠ Gateway restarted but port 8402 not yet up (may still be starting)"
      echo "    Check: systemctl --user status openclaw-gateway.service"
    fi
  else
    echo "  ⚠ systemctl restart failed. Run manually: openclaw gateway restart"
  fi
elif command -v openclaw >/dev/null 2>&1; then
  openclaw gateway restart &>/dev/null &
  echo "  ✓ Gateway restart triggered"
else
  echo "  Run: openclaw gateway restart"
fi

echo ""
echo "  OpenClaw slash commands:"
echo "    /wallet             → wallet balance, address, chain"
echo "    /wallet export     → export private key for backup"
echo "    /wallet solana     → switch to Solana payments"
echo "    /stats             → usage & cost breakdown"
echo ""
echo "  CLI commands:"
echo "    npx @blockrun/clawrouter report            # daily usage report"
echo "    npx @blockrun/clawrouter report weekly      # weekly report"
echo "    npx @blockrun/clawrouter report monthly     # monthly report"
echo "    npx @blockrun/clawrouter doctor             # AI diagnostics"
echo ""
