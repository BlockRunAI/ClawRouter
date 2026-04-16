#!/bin/bash
set -e
set -o pipefail

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
    echo "✗ Reinstall failed. Restoring previous ClawRouter install..."

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
  local log_file
  log_file="$(mktemp -t clawrouter-reinstall-npm.XXXXXX.log)"

  if (cd "$plugin_dir" && npm install --omit=dev >"$log_file" 2>&1); then
    tail -1 "$log_file"
    rm -f "$log_file"
  else
    echo "  npm install failed. Last 20 log lines:" >&2
    tail -20 "$log_file" >&2 || true
    echo "  Full log: $log_file" >&2
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
  elif command -v ss >/dev/null 2>&1; then
    pids="$(ss -lptn "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | sort -u)"
  elif command -v netstat >/dev/null 2>&1; then
    pids="$(netstat -nlpt 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" {split($7,a,"/"); if (a[1] ~ /^[0-9]+$/) print a[1]}' | sort -u)"
  else
    echo "  Warning: could not find lsof/fuser/ss/netstat; skipping proxy stop"
    return 0
  fi

  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
}

echo "🦞 ClawRouter Reinstall"
echo ""

# Pre-flight: fail fast if config is corrupt
validate_config

# 0. Back up wallet key BEFORE removing anything
echo "→ Backing up wallet..."
if [ -f "$WALLET_FILE" ]; then
  WALLET_KEY=$(cat "$WALLET_FILE" | tr -d '[:space:]')
  KEY_LEN=${#WALLET_KEY}
  if [[ "$WALLET_KEY" == 0x* ]] && [ "$KEY_LEN" -eq 66 ]; then
    WALLET_BACKUP="$HOME/.openclaw/blockrun/wallet.key.bak.$(date +%s)"
    cp "$WALLET_FILE" "$WALLET_BACKUP"
    chmod 600 "$WALLET_BACKUP"
    echo "  ✓ Wallet backed up to: $WALLET_BACKUP"
  else
    echo "  ⚠ Wallet file exists but has invalid format — skipping backup"
  fi
else
  echo "  ℹ No existing wallet found"
fi
echo ""

# 0.5 Back up existing install for rollback
echo "→ Backing up existing install..."
if [ -d "$PLUGIN_DIR" ]; then
  PLUGIN_BACKUP="$HOME/.openclaw/blockrun/clawrouter.backup.$(date +%s)"
  mv "$PLUGIN_DIR" "$PLUGIN_BACKUP"
  echo "  ✓ Plugin files staged at: $PLUGIN_BACKUP"
else
  echo "  ℹ No existing plugin files found"
fi

if [ -f "$CONFIG_PATH" ]; then
  CONFIG_BACKUP="$CONFIG_PATH.clawrouter-reinstall.$(date +%s).bak"
  cp "$CONFIG_PATH" "$CONFIG_BACKUP"
  echo "  ✓ Config backed up to: $CONFIG_BACKUP"
fi
echo ""

# 1b. Remove Crossmint/lobster extension
# lobster.cash conflicts with /wallet command — remove it so ClawRouter owns /wallet.
echo "→ Removing Crossmint/lobster extension..."
LOBSTER_DIR="$HOME/.openclaw/extensions/lobster.cash"
if [ -d "$LOBSTER_DIR" ]; then
  rm -rf "$LOBSTER_DIR"
  echo "  ✓ Removed $LOBSTER_DIR"
else
  echo "  ✓ Not installed"
fi
node -e "
const fs = require('fs');
const configPath = '$CONFIG_PATH';
if (!fs.existsSync(configPath)) process.exit(0);
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let changed = false;
  for (const key of ['lobster.cash', 'lobster', 'crossmint']) {
    if (config?.plugins?.entries?.[key]) { delete config.plugins.entries[key]; changed = true; console.log('  Removed plugins.entries.' + key); }
    if (config?.plugins?.installs?.[key]) { delete config.plugins.installs[key]; changed = true; }
  }
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

# 2. Clean config entries
echo "→ Cleaning config entries..."
node -e "
const f = require('os').homedir() + '/.openclaw/openclaw.json';
const fs = require('fs');
function atomicWrite(filePath, data) {
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}
if (!fs.existsSync(f)) {
  console.log('  No openclaw.json found, skipping');
  process.exit(0);
}

let c;
try {
  c = JSON.parse(fs.readFileSync(f, 'utf8'));
} catch (err) {
  const backupPath = f + '.corrupt.' + Date.now();
  console.error('  ERROR: Invalid JSON in openclaw.json');
  console.error('  ' + err.message);
  try {
    fs.copyFileSync(f, backupPath);
    console.log('  Backed up to: ' + backupPath);
  } catch {}
  console.log('  Skipping config cleanup...');
  process.exit(0);
}

// Clean plugin entries (all case variants to prevent duplicate plugin warnings)
for (const key of ['clawrouter', 'ClawRouter', '@blockrun/clawrouter']) {
  if (c.plugins?.entries?.[key]) delete c.plugins.entries[key];
  if (c.plugins?.installs?.[key]) delete c.plugins.installs[key];
}

// Clean plugins.allow — remove clawrouter (will be re-added after install)
// and strip any non-bundled plugin names that don't exist (e.g. "wallet" added
// by an AI agent trying to fix a different problem — causes a warning on every start).
if (Array.isArray(c.plugins?.allow)) {
  const BUNDLED_OPENCLAW_PLUGINS = [
    // OpenClaw v2026.x bundled plugin IDs (safe to keep in allow list)
    'http', 'mcp', 'computer-use', 'browser', 'code', 'image', 'voice',
    'search', 'memory', 'calendar', 'email', 'slack', 'discord', 'telegram',
    'whatsapp', 'matrix', 'teams', 'notion', 'github', 'jira', 'linear',
    'comfyui',
  ];
  const before = c.plugins.allow.length;
  c.plugins.allow = c.plugins.allow.filter(p => {
    if (p === 'clawrouter' || p === '@blockrun/clawrouter') return false; // re-added later
    if (BUNDLED_OPENCLAW_PLUGINS.includes(p)) return true; // known-good bundled plugins
    // Keep entries that look like npm package names (scoped or plain)
    if (p.startsWith('@') || p.includes('/')) return true;
    // Drop bare single-word entries that aren't bundled (e.g. "wallet" added by mistake)
    return false;
  });
  const removed = before - c.plugins.allow.length;
  if (removed > 0) console.log('  Removed ' + removed + ' stale plugins.allow entry(ies)');
}

atomicWrite(f, JSON.stringify(c, null, 2));
console.log('  Config cleaned');
"

# 3. Kill old proxy
echo "→ Stopping old proxy..."
kill_port_processes 8402

# 3.1. Remove stale models.json so it gets regenerated with apiKey
echo "→ Cleaning models cache..."
rm -f ~/.openclaw/agents/*/agent/models.json 2>/dev/null || true

# 4. Inject auth profile (ensures blockrun provider is recognized)
echo "→ Injecting auth profile..."
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

// Create directory if needed
fs.mkdirSync(authDir, { recursive: true });

// Load or create auth-profiles.json with correct OpenClaw format
let store = { version: 1, profiles: {} };
if (fs.existsSync(authPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    // Migrate if old format (no version field)
    if (existing.version && existing.profiles) {
      store = existing;
    } else {
      // Old format - keep version/profiles structure, old data is discarded
      store = { version: 1, profiles: {} };
    }
  } catch (err) {
    console.log('  Warning: Could not parse auth-profiles.json, creating fresh');
  }
}

// Inject blockrun auth if missing (OpenClaw format: profiles['provider:profileId'])
const profileKey = 'blockrun:default';
if (!store.profiles[profileKey]) {
  store.profiles[profileKey] = {
    type: 'api_key',
    provider: 'blockrun',
    key: 'x402-proxy-handles-auth'
  };
  atomicWrite(authPath, JSON.stringify(store, null, 2));
  console.log('  Auth profile created');
} else {
  console.log('  Auth profile already exists');
}
"

# 5. Ensure apiKey is present for /model picker (but DON'T override default model)
echo "→ Finalizing setup..."
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
    let changed = false;

    // Ensure blockrun provider has apiKey (required by ModelRegistry for /model picker)
    if (config.models?.providers?.blockrun && !config.models.providers.blockrun.apiKey) {
      config.models.providers.blockrun.apiKey = 'x402-proxy-handles-auth';
      console.log('  Added apiKey to blockrun provider config');
      changed = true;
    }

    if (changed) {
      atomicWrite(configPath, JSON.stringify(config, null, 2));
    }
  } catch (e) {
    console.log('  Could not update config:', e.message);
  }
} else {
  console.log('  No openclaw.json found, skipping');
}
"

# 5b. Ensure provider baseUrl is set (must happen BEFORE openclaw plugins install,
#     which validates the config and fails if baseUrl is missing)
echo "→ Verifying provider config..."
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
  const provider = config?.models?.providers?.blockrun;
  if (!provider) {
    console.log('  No blockrun provider found, skipping');
    process.exit(0);
  }

  let changed = false;
  if (!provider.baseUrl) {
    provider.baseUrl = 'http://127.0.0.1:8402/v1';
    changed = true;
    console.log('  Fixed missing baseUrl');
  }
  if (!provider.apiKey) {
    provider.apiKey = 'x402-proxy-handles-auth';
    changed = true;
    console.log('  Fixed missing apiKey');
  }

  if (changed) {
    const tmpPath = configPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    fs.renameSync(tmpPath, configPath);
  } else {
    console.log('  Provider config OK');
  }
} catch (err) {
  console.log('  Skipped: ' + err.message);
}
"

# 6. Install plugin (config is ready, but no allow list yet to avoid validation error)
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
  // Save channels block and gateway block (gateway.mode etc.)
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

echo "→ Installing ClawRouter..."
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

  // Restore channels block if it was wiped or is now empty
  if (preserved.channels && Object.keys(preserved.channels).length > 0) {
    if (!config.channels || Object.keys(config.channels).length === 0) {
      config.channels = preserved.channels;
      changed = true;
      console.log('  ✓ Restored channel config (Telegram/WhatsApp/etc.)');
    } else {
      // Merge: restore any channels that are now missing
      let merged = 0;
      for (const [ch, val] of Object.entries(preserved.channels)) {
        if (!config.channels[ch]) {
          config.channels[ch] = val;
          merged++;
        }
      }
      if (merged > 0) {
        changed = true;
        console.log('  ✓ Merged ' + merged + ' missing channel(s) back into config');
      } else {
        console.log('  Channel config intact');
      }
    }
  }

  // Restore gateway.mode if missing
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

# 6.1. Verify installation and force-update if openclaw installed a stale cached version
echo "→ Verifying installation..."
DIST_PATH="$PLUGIN_DIR/dist/index.js"

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

if [ ! -f "$DIST_PATH" ]; then
  echo "  ⚠️  dist/ files missing — openclaw install may have cached an old version"
  LATEST_VER=$(npm view @blockrun/clawrouter@latest version 2>/dev/null || echo "")
  if [ -n "$LATEST_VER" ]; then
    force_install_from_npm "$LATEST_VER" || exit 1
  else
    echo "  ❌ Cannot determine latest version — check npm registry connection"
    exit 1
  fi
  if [ ! -f "$DIST_PATH" ]; then
    echo "  ❌ Installation failed - dist/index.js still missing"
    echo "  Please report this issue at https://github.com/BlockRunAI/ClawRouter/issues"
    exit 1
  fi
else
  # dist/ exists — verify we have the latest version (openclaw may have served cached old version)
  INSTALLED_VER=$(node -e "try{const p=require('$PLUGIN_DIR/package.json');console.log(p.version);}catch{console.log('');}" 2>/dev/null || echo "")
  LATEST_VER=$(npm view @blockrun/clawrouter@latest version 2>/dev/null || echo "")
  if [ -n "$LATEST_VER" ] && [ -n "$INSTALLED_VER" ] && [ "$INSTALLED_VER" != "$LATEST_VER" ]; then
    echo "  ⚠️  openclaw installed v${INSTALLED_VER} (cached) but latest is v${LATEST_VER}"
    force_install_from_npm "$LATEST_VER" || true
  fi
fi

INSTALLED_VER=$(node -e "try{const p=require('$PLUGIN_DIR/package.json');console.log(p.version);}catch{console.log('?');}" 2>/dev/null || echo "?")
echo "  ✓ ClawRouter v${INSTALLED_VER} installed"

# 6.1b. Ensure all dependencies are installed (Solana, x402, etc.)
# openclaw's plugin installer may skip native deps like @solana/kit.
if [ -d "$PLUGIN_DIR" ] && [ -f "$PLUGIN_DIR/package.json" ]; then
  echo "→ Installing dependencies (Solana, x402, etc.)..."
  run_dependency_install "$PLUGIN_DIR"
fi

# 6.2. Populate model allowlist so top BlockRun models appear in /model picker
echo "→ Populating model allowlist..."
node -e "
const os = require('os');
const fs = require('fs');
const path = require('path');
function atomicWrite(filePath, data) {
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
if (!fs.existsSync(configPath)) {
  console.log('  No openclaw.json found, skipping');
  process.exit(0);
}

try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let changed = false;

  // Ensure provider exists with apiKey
  if (!config.models) config.models = {};
  if (!config.models.providers) config.models.providers = {};
  if (!config.models.providers.blockrun) {
    config.models.providers.blockrun = { api: 'openai-completions', models: [] };
    changed = true;
  }
  if (!config.models.providers.blockrun.apiKey) {
    config.models.providers.blockrun.apiKey = 'x402-proxy-handles-auth';
    changed = true;
  }

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
    changed = true;
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
  if (added > 0) {
    changed = true;
    console.log('  Added ' + added + ' models to allowlist (' + TOP_MODELS.length + ' total)');
  }
  if (removed > 0) {
    console.log('  Removed ' + removed + ' deprecated models from allowlist');
  }
  if (added === 0 && removed === 0) {
    console.log('  Allowlist already up to date');
  }
  if (changed) {
    atomicWrite(configPath, JSON.stringify(config, null, 2));
  }
} catch (err) {
  console.log('  Could not update config:', err.message);
}
"

# 6.3. Re-verify baseUrl after install (OpenClaw's async config persistence can overwrite it)
echo "→ Verifying provider baseUrl (post-install)..."
node -e "
const os = require('os');
const fs = require('fs');
const path = require('path');
function atomicWrite(filePath, data) {
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}
const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
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
    atomicWrite(configPath, JSON.stringify(config, null, 2));
  } else { console.log('  ✓ Provider config OK'); }
} catch (err) { console.log('  Skipped: ' + err.message); }
"

# 7. Add plugin to allow list (done AFTER install so plugin files exist for validation)
echo "→ Adding to plugins allow list..."
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

    // Ensure plugins.allow exists and includes clawrouter
    if (!config.plugins) config.plugins = {};
    if (!Array.isArray(config.plugins.allow)) {
      config.plugins.allow = [];
    }
    if (!config.plugins.allow.includes('clawrouter') && !config.plugins.allow.includes('@blockrun/clawrouter')) {
      config.plugins.allow.push('clawrouter');
      console.log('  Added clawrouter to plugins.allow');
    } else {
      console.log('  Plugin already in allow list');
    }

    atomicWrite(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.log('  Could not update config:', e.message);
  }
} else {
  console.log('  No openclaw.json found, skipping');
}
"

# 8. Ensure gateway.mode is set (required by OpenClaw v2026.4.5+)
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

# Final: verify wallet survived reinstall
echo "→ Verifying wallet integrity..."
if [ -f "$WALLET_FILE" ]; then
  CURRENT_KEY=$(cat "$WALLET_FILE" | tr -d '[:space:]')
  CURRENT_LEN=${#CURRENT_KEY}
  if [[ "$CURRENT_KEY" == 0x* ]] && [ "$CURRENT_LEN" -eq 66 ]; then
    echo "  ✓ Wallet key intact"
  else
    if [ -n "$WALLET_BACKUP" ] && [ -f "$WALLET_BACKUP" ]; then
      cp "$WALLET_BACKUP" "$WALLET_FILE"
      chmod 600 "$WALLET_FILE"
      echo "  ✓ Wallet restored from backup"
    fi
  fi
else
  if [ -n "$WALLET_BACKUP" ] && [ -f "$WALLET_BACKUP" ]; then
    mkdir -p "$(dirname "$WALLET_FILE")"
    cp "$WALLET_BACKUP" "$WALLET_FILE"
    chmod 600 "$WALLET_FILE"
    echo "  ✓ Wallet restored from backup: $WALLET_BACKUP"
  fi
fi

echo ""
echo "✓ Done! Smart routing enabled by default."
echo ""

# Auto-restart gateway so new version is active immediately
echo "→ Restarting gateway..."
RESTART_OK=false
if systemctl --user is-active openclaw-gateway.service >/dev/null 2>&1 || \
   systemctl --user is-enabled openclaw-gateway.service >/dev/null 2>&1; then
  if systemctl --user restart openclaw-gateway.service 2>/dev/null; then
    # Wait up to 15s for ClawRouter proxy port to come up
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
  # Fallback: use openclaw CLI restart (background, don't hang)
  openclaw gateway restart &>/dev/null &
  echo "  ✓ Gateway restart triggered"
else
  echo "  Run: openclaw gateway restart"
fi
echo ""
echo "Model aliases available:"
echo "  /model sonnet    → claude-sonnet-4.6"
echo "  /model opus      → claude-opus-4.7"
echo "  /model codex     → openai/gpt-5.3-codex"
echo "  /model deepseek  → deepseek/deepseek-chat"
echo "  /model free      → nemotron-ultra-253b (strongest free)"
echo ""
echo "Free models (no wallet needed):"
echo "  /model nemotron       → nemotron-ultra-253b (strongest free)"
echo "  /model deepseek-free  → deepseek-v3.2"
echo "  /model mistral-free   → mistral-large-675b"
echo "  /model devstral       → devstral-2-123b (coding)"
echo "  /model qwen-coder     → qwen3-coder-480b (coding)"
echo "  /model maverick       → llama-4-maverick"
echo ""
echo "OpenClaw slash commands:"
echo "  /wallet             → wallet balance, address, chain"
echo "  /wallet export     → export private key for backup"
echo "  /wallet solana     → switch to Solana payments"
echo "  /wallet base       → switch to Base (EVM) payments"
echo "  /stats             → usage & cost breakdown"
echo "  /exclude add <model>  → block a model from routing"
echo ""
echo "Image generation:"
echo "  /imagegen <prompt>                           # default: nano-banana"
echo "  /imagegen --model dall-e-3 <prompt>          # DALL-E 3"
echo "  /imagegen --model gpt-image <prompt>         # GPT Image 1"
echo ""
echo "CLI commands:"
echo "  npx @blockrun/clawrouter report            # daily usage report"
echo "  npx @blockrun/clawrouter report weekly      # weekly report"
echo "  npx @blockrun/clawrouter report monthly     # monthly report"
echo "  npx @blockrun/clawrouter doctor             # AI diagnostics"
echo ""
echo "To uninstall: bash ~/.openclaw/extensions/clawrouter/scripts/uninstall.sh"
