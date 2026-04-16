#!/bin/bash
set -e
set -o pipefail

# ─────────────────────────────────────────────────────────────
#  ClawRouter Update Script
#  Safe update: backs up wallet key BEFORE touching anything,
#  restores it if the update process somehow wiped it.
# ─────────────────────────────────────────────────────────────

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
  PLUGIN_BACKUP="$HOME/.openclaw/blockrun/clawrouter.backup.$(date +%s)"
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
# lobster.cash is a third-party plugin that conflicts with /wallet command.
# Remove it so ClawRouter owns /wallet without conflict.
echo "→ Removing Crossmint/lobster extension..."
LOBSTER_DIR="$HOME/.openclaw/extensions/lobster.cash"
if [ -d "$LOBSTER_DIR" ]; then
  rm -rf "$LOBSTER_DIR"
  echo "  ✓ Removed $LOBSTER_DIR"
else
  echo "  ✓ Not installed"
fi
# Clean crossmint/lobster from openclaw.json
node -e "
const fs = require('fs');
const configPath = '$CONFIG_PATH';
if (!fs.existsSync(configPath)) process.exit(0);
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let changed = false;
  // Remove from plugins.entries
  for (const key of ['lobster.cash', 'lobster', 'crossmint']) {
    if (config?.plugins?.entries?.[key]) { delete config.plugins.entries[key]; changed = true; console.log('  Removed plugins.entries.' + key); }
    if (config?.plugins?.installs?.[key]) { delete config.plugins.installs[key]; changed = true; }
  }
  // Remove from plugins.allow
  if (Array.isArray(config?.plugins?.allow)) {
    const before = config.plugins.allow.length;
    config.plugins.allow = config.plugins.allow.filter(p => !['lobster.cash','lobster','crossmint'].includes(p));
    if (config.plugins.allow.length !== before) { changed = true; console.log('  Removed lobster/crossmint from plugins.allow'); }
  }
  if (changed) {
    const tmp = configPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, configPath);
  } else { console.log('  Config clean'); }
} catch (e) { console.log('  Skipped: ' + e.message); }
"
echo ""

# ── Step 2: Kill old proxy ──────────────────────────────────────
echo "→ Stopping old proxy..."
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
kill_port_processes 8402

# ── Step 3: Clean stale plugin entry from config ──────────────
# The old plugin dir is staged in a backup above. Remove the stale
# plugin entry so a fresh install can proceed, and restore it on error.
echo "→ Cleaning config..."
node -e "
const fs = require('fs');
const path = require('path');
const configPath = '$CONFIG_PATH';
if (!fs.existsSync(configPath)) process.exit(0);
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let changed = false;

  // Remove stale plugin entries (check all case variants)
  const entries = config?.plugins?.entries;
  const installs = config?.plugins?.installs;
  for (const key of ['clawrouter', 'ClawRouter', '@blockrun/clawrouter']) {
    if (entries?.[key]) { delete entries[key]; changed = true; console.log('  Removed plugins.entries.' + key); }
    if (installs?.[key]) { delete installs[key]; changed = true; console.log('  Removed plugins.installs.' + key); }
  }

  // Clean plugins.allow — remove clawrouter (re-added later) and any stale bare
  // single-word entries that aren't bundled OpenClaw plugins (e.g. "wallet" added
  // by an AI agent — shows a warning on every gateway start).
  if (Array.isArray(config?.plugins?.allow)) {
    const BUNDLED = [
      'http','mcp','computer-use','browser','code','image','voice',
      'search','memory','calendar','email','slack','discord','telegram',
      'whatsapp','matrix','teams','notion','github','jira','linear',
      'comfyui',
    ];
    const before = config.plugins.allow.length;
    config.plugins.allow = config.plugins.allow.filter(p => {
      if (p === 'clawrouter' || p === '@blockrun/clawrouter') return false;
      if (BUNDLED.includes(p)) return true;
      if (p.startsWith('@') || p.includes('/')) return true;
      return false;
    });
    const removed = before - config.plugins.allow.length;
    if (removed > 0) { changed = true; console.log('  Removed ' + removed + ' stale plugins.allow entry(ies)'); }
  }

  if (changed) {
    const tmp = configPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, configPath);
  } else {
    console.log('  Config clean');
  }
} catch (err) {
  console.log('  Skipped: ' + err.message);
}
"

# ── Step 3b: Ensure baseUrl is set (must happen BEFORE install, which validates config) ──
echo "→ Verifying provider config..."
node -e "
const fs = require('fs');
const configPath = '$CONFIG_PATH';
if (!fs.existsSync(configPath)) { console.log('  No config, skipping'); process.exit(0); }
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const provider = config?.models?.providers?.blockrun;
  if (!provider) { console.log('  No blockrun provider, skipping'); process.exit(0); }
  let changed = false;
  if (!provider.baseUrl) { provider.baseUrl = 'http://127.0.0.1:8402/v1'; changed = true; console.log('  Fixed missing baseUrl'); }
  if (!provider.apiKey) { provider.apiKey = 'x402-proxy-handles-auth'; changed = true; console.log('  Fixed missing apiKey'); }
  if (changed) {
    const tmp = configPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, configPath);
  } else { console.log('  Provider config OK'); }
} catch (err) { console.log('  Skipped: ' + err.message); }
"

# ── Step 4: Install latest version ─────────────────────────────
# Back up OpenClaw credentials (channels, WhatsApp/Telegram state) before plugin install
CREDS_DIR="$HOME/.openclaw/credentials"
CREDS_BACKUP=""
if [ -d "$CREDS_DIR" ] && [ "$(ls -A "$CREDS_DIR" 2>/dev/null)" ]; then
  CREDS_BACKUP="$(mktemp -d)/openclaw-credentials-backup"
  cp -a "$CREDS_DIR" "$CREDS_BACKUP"
  echo "  ✓ Backed up OpenClaw credentials"
fi

# Extract channel config (Telegram tokens, etc.) from openclaw.json before install
# openclaw plugins install can overwrite config and wipe channel settings
CHANNEL_CONFIG_BACKUP=""
if [ -f "$CONFIG_PATH" ]; then
  CHANNEL_CONFIG_BACKUP="$(mktemp)"
  node -e "
const fs = require('fs');
try {
  const config = JSON.parse(fs.readFileSync('$CONFIG_PATH', 'utf8'));
  const preserved = {};
  if (config.channels) preserved.channels = config.channels;
  if (config.gateway) preserved.gateway = config.gateway;
  fs.writeFileSync('$CHANNEL_CONFIG_BACKUP', JSON.stringify(preserved, null, 2));
  const channelCount = Object.keys(config.channels || {}).length;
  if (channelCount > 0) console.log('  ✓ Preserved config for channels: ' + Object.keys(config.channels).join(', '));
} catch (e) { fs.writeFileSync('$CHANNEL_CONFIG_BACKUP', '{}'); }
"
fi

# Pre-install cleanup: remove any backup/stage dirs from extensions/ BEFORE
# openclaw plugins install scans the directory. If they exist during install,
# OpenClaw writes them into config as duplicate plugins.
for stale in "$HOME/.openclaw/extensions/clawrouter.backup."* "$HOME/.openclaw/extensions/.openclaw-install-stage-"*; do
  [ -d "$stale" ] && rm -rf "$stale"
done

echo "→ Installing latest ClawRouter..."
# Run with timeout — openclaw plugins install may hang after printing
# "Installed plugin: clawrouter" in OpenClaw v2026.4.5 (parallel plugin loading).
# 120s is enough for slow connections; the install itself completes in ~30s.
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
# From this point on, Ctrl+C or errors should NOT roll back the install.
trap - EXIT INT TERM

# Restore credentials after plugin install (always restore to preserve user's channels)
if [ -n "$CREDS_BACKUP" ] && [ -d "$CREDS_BACKUP" ]; then
  mkdir -p "$CREDS_DIR"
  cp -a "$CREDS_BACKUP/"* "$CREDS_DIR/"
  echo "  ✓ Restored OpenClaw credentials (channels preserved)"
  rm -rf "$(dirname "$CREDS_BACKUP")"
fi

# Restore channel config (Telegram tokens etc.) that may have been wiped by plugin install
if [ -n "$CHANNEL_CONFIG_BACKUP" ] && [ -f "$CHANNEL_CONFIG_BACKUP" ] && [ -f "$CONFIG_PATH" ]; then
  node -e "
const fs = require('fs');
function atomicWrite(filePath, data) {
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}
try {
  const config = JSON.parse(fs.readFileSync('$CONFIG_PATH', 'utf8'));
  const preserved = JSON.parse(fs.readFileSync('$CHANNEL_CONFIG_BACKUP', 'utf8'));
  let changed = false;
  if (preserved.channels && Object.keys(preserved.channels).length > 0) {
    if (!config.channels || Object.keys(config.channels).length === 0) {
      config.channels = preserved.channels;
      changed = true;
      console.log('  ✓ Restored channel config (Telegram/WhatsApp/etc.)');
    } else {
      let merged = 0;
      for (const [ch, val] of Object.entries(preserved.channels)) {
        if (!config.channels[ch]) { config.channels[ch] = val; merged++; }
      }
      if (merged > 0) { changed = true; console.log('  ✓ Merged ' + merged + ' missing channel(s) back into config'); }
      else { console.log('  Channel config intact'); }
    }
  }
  if (preserved.gateway?.mode && (!config.gateway || !config.gateway.mode)) {
    if (!config.gateway) config.gateway = {};
    config.gateway.mode = preserved.gateway.mode;
    changed = true;
  }
  if (changed) atomicWrite('$CONFIG_PATH', JSON.stringify(config, null, 2));
} catch (e) {
  console.log('  Warning: could not restore channel config:', e.message);
}
"
  rm -f "$CHANNEL_CONFIG_BACKUP"
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
# openclaw's plugin installer may skip native/optional deps like @solana/kit.
# Run npm install in the plugin directory to fill any gaps.
if [ -d "$PLUGIN_DIR" ] && [ -f "$PLUGIN_DIR/package.json" ]; then
  echo "→ Installing dependencies (Solana, x402, etc.)..."
  run_dependency_install "$PLUGIN_DIR"
fi

# ── Step 5: Verify wallet survived ─────────────────────────────
# ── Step 4d: Post-install duplicate cleanup ──────────────────────
# openclaw plugins install writes plugins.entries.ClawRouter (PascalCase, from
# plugin name) AND plugins.installs.clawrouter (lowercase, from plugin id).
# The extensions/ directory scan also discovers the plugin by id.
# Having both entries + directory causes "duplicate plugin" warnings.
# Fix: keep only the installs record (used by OpenClaw's matchInstalledPlugin),
# remove the entries record that duplicates it.
echo "→ Cleaning duplicate plugin entries..."
node -e "
const fs = require('fs');
const configPath = '$CONFIG_PATH';
if (!fs.existsSync(configPath)) process.exit(0);
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let changed = false;
  // Remove entries that duplicate the installs record
  for (const key of ['clawrouter', 'ClawRouter', '@blockrun/clawrouter']) {
    if (config?.plugins?.entries?.[key]) {
      delete config.plugins.entries[key];
      changed = true;
      console.log('  Removed duplicate plugins.entries.' + key);
    }
  }
  if (changed) {
    const tmp = configPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, configPath);
    console.log('  ✓ Duplicate entries cleaned');
  } else {
    console.log('  ✓ No duplicates found');
  }
} catch (e) { console.log('  Skipped: ' + e.message); }
"

# ── Step 4e: Re-verify baseUrl after install ─────────────────────
# OpenClaw's plugin install can overwrite openclaw.json and drop the baseUrl
# that step 3b set. Re-apply it unconditionally after install.
echo "→ Verifying provider baseUrl (post-install)..."
node -e "
const fs = require('fs');
const configPath = '$CONFIG_PATH';
if (!fs.existsSync(configPath)) { console.log('  No config, skipping'); process.exit(0); }
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const provider = config?.models?.providers?.blockrun;
  if (!provider) { console.log('  No blockrun provider, skipping'); process.exit(0); }
  let changed = false;
  const expected = 'http://127.0.0.1:8402/v1';
  if (provider.baseUrl !== expected) { provider.baseUrl = expected; changed = true; console.log('  Fixed baseUrl → ' + expected); }
  if (!provider.apiKey) { provider.apiKey = 'x402-proxy-handles-auth'; changed = true; console.log('  Fixed missing apiKey'); }
  if (changed) {
    const tmp = configPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, configPath);
  } else { console.log('  ✓ Provider config OK'); }
} catch (err) { console.log('  Skipped: ' + err.message); }
"

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

# ── Step 6: Inject auth profile ─────────────────────────────────
echo "→ Refreshing auth profile..."
node -e "
const os = require('os');
const fs = require('fs');
const path = require('path');
const authDir = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'agent');
const authPath = path.join(authDir, 'auth-profiles.json');
function atomicWrite(filePath, data) {
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

fs.mkdirSync(authDir, { recursive: true });

let store = { version: 1, profiles: {} };
if (fs.existsSync(authPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    if (existing.version && existing.profiles) store = existing;
  } catch {}
}

const profileKey = 'blockrun:default';
if (!store.profiles[profileKey]) {
  store.profiles[profileKey] = { type: 'api_key', provider: 'blockrun', key: 'x402-proxy-handles-auth' };
  atomicWrite(authPath, JSON.stringify(store, null, 2));
  console.log('  Auth profile created');
} else {
  console.log('  Auth profile already exists');
}
"

# ── Step 7: Clean models cache ──────────────────────────────────
echo "→ Cleaning models cache..."
rm -f ~/.openclaw/agents/*/agent/models.json 2>/dev/null || true

# ── Step 8: Populate model allowlist with top 16 models ────────
echo "→ Populating model allowlist..."
node -e "
const os = require('os');
const fs = require('fs');
const path = require('path');
const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');

if (!fs.existsSync(configPath)) {
  console.log('  No config file found, skipping');
  process.exit(0);
}

try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Curated models for the /model picker
  const TOP_MODELS = [
    'auto', 'free', 'eco', 'premium',
    'anthropic/claude-sonnet-4.6', 'anthropic/claude-opus-4.7', 'anthropic/claude-opus-4.6', 'anthropic/claude-haiku-4.5',
    'openai/gpt-5.4', 'openai/gpt-5.4-mini', 'openai/gpt-5.4-pro', 'openai/gpt-5.3', 'openai/gpt-5.3-codex',
    'openai/gpt-5-mini', 'openai/gpt-5-nano', 'openai/gpt-5.4-nano', 'openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/o3', 'openai/o4-mini',
    'google/gemini-3.1-pro', 'google/gemini-3.1-flash-lite', 'google/gemini-3-pro-preview', 'google/gemini-3-flash-preview',
    'google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite',
    'deepseek/deepseek-chat', 'deepseek/deepseek-reasoner', 'nvidia/kimi-k2.5',
    'xai/grok-3', 'xai/grok-4-0709', 'xai/grok-4-1-fast-reasoning',
    'minimax/minimax-m2.7', 'minimax/minimax-m2.5',
    'free/gpt-oss-120b', 'free/gpt-oss-20b',
    'free/nemotron-ultra-253b', 'free/deepseek-v3.2', 'free/mistral-large-3-675b',
    'free/qwen3-coder-480b', 'free/devstral-2-123b', 'free/llama-4-maverick',
    'free/nemotron-3-super-120b', 'free/nemotron-super-49b', 'free/glm-4.7',
    'zai/glm-5.1', 'zai/glm-5', 'zai/glm-5-turbo'
  ];

  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.models || typeof config.agents.defaults.models !== 'object') {
    config.agents.defaults.models = {};
  }

  const allowlist = config.agents.defaults.models;
  const currentKeys = new Set(TOP_MODELS.map(id => 'blockrun/' + id));

  // Remove any blockrun/* entries not in the current TOP_MODELS list
  let removed = 0;
  for (const key of Object.keys(allowlist)) {
    if (key.startsWith('blockrun/') && !currentKeys.has(key)) {
      delete allowlist[key];
      removed++;
    }
  }

  // Add any missing current models
  let added = 0;
  for (const id of TOP_MODELS) {
    const key = 'blockrun/' + id;
    if (!allowlist[key]) {
      allowlist[key] = {};
      added++;
    }
  }

  // Atomic write
  const tmpPath = configPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
  fs.renameSync(tmpPath, configPath);

  if (removed > 0) {
    console.log('  Removed ' + removed + ' deprecated models from allowlist');
  }
  if (added > 0) {
    console.log('  Added ' + added + ' models to allowlist (' + TOP_MODELS.length + ' total)');
  }
  if (added === 0 && removed === 0) {
    console.log('  Allowlist already up to date');
  }
} catch (err) {
  console.log('  Migration skipped: ' + err.message);
}
"

# Ensure gateway.mode is set (required by OpenClaw v2026.4.5+)
echo "→ Ensuring gateway.mode is set..."
node -e "
const os = require('os');
const fs = require('fs');
const path = require('path');
const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
function atomicWrite(filePath, data) {
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config.gateway) config.gateway = {};
    if (!config.gateway.mode) {
      config.gateway.mode = 'local';
      atomicWrite(configPath, JSON.stringify(config, null, 2));
      console.log('  Set gateway.mode = local (required by OpenClaw v2026.4.5+)');
    } else {
      console.log('  gateway.mode already set: ' + config.gateway.mode);
    }
  } catch (e) {
    console.log('  Could not update config:', e.message);
    console.log('  Fix manually: openclaw config set gateway.mode local');
  }
} else {
  console.log('  No openclaw.json found, skipping');
}
"

# Clean up stale install-stage directories — these contain old plugin versions
# that OpenClaw may auto-load instead of the current install, causing payment
# failures and "duplicate plugin" warnings.
echo "→ Cleaning up stale install stages..."
CLEANED=0
for stage_dir in "$HOME/.openclaw/extensions/.openclaw-install-stage-"*; do
  if [ -d "$stage_dir" ]; then
    rm -rf "$stage_dir"
    CLEANED=$((CLEANED + 1))
  fi
done
if [ "$CLEANED" -gt 0 ]; then
  echo "  ✓ Removed $CLEANED stale install stage(s)"
else
  echo "  ✓ No stale install stages found"
fi

# Clean up stale plugin backups — old ones lived in extensions/ (caused duplicate
# plugin detection), new ones live in blockrun/. Clean both locations.
echo "→ Cleaning up stale plugin backups..."
CLEANED=0
for backup_dir in "$HOME/.openclaw/extensions/clawrouter.backup."* "$HOME/.openclaw/blockrun/clawrouter.backup."*; do
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

# Clean plugin registry — remove entries pointing to stale stage/backup paths
echo "→ Cleaning plugin registry..."
node -e "
const fs = require('fs');
const configPath = '$CONFIG_PATH';
if (!fs.existsSync(configPath)) process.exit(0);
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let changed = false;
  const isStale = (p) => p.includes('.openclaw-install-stage-') || p.includes('clawrouter.backup.');
  // Remove plugins.entries pointing to stale directories
  if (config?.plugins?.entries) {
    for (const [key, val] of Object.entries(config.plugins.entries)) {
      const path = typeof val === 'string' ? val : val?.path || val?.main || '';
      if (isStale(path)) {
        delete config.plugins.entries[key];
        changed = true;
        console.log('  Removed plugins.entries.' + key + ' (stale)');
      }
    }
  }
  // Remove plugins.installs pointing to stale directories
  if (config?.plugins?.installs) {
    for (const [key, val] of Object.entries(config.plugins.installs)) {
      const path = typeof val === 'string' ? val : val?.path || val?.main || '';
      if (isStale(path)) {
        delete config.plugins.installs[key];
        changed = true;
        console.log('  Removed plugins.installs.' + key + ' (stale)');
      }
    }
  }
  if (changed) {
    const tmp = configPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, configPath);
    console.log('  ✓ Registry cleaned');
  } else {
    console.log('  ✓ Registry clean');
  }
} catch (e) { console.log('  Skipped: ' + e.message); }
"

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
