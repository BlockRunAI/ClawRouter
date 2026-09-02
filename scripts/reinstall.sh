#!/bin/bash
set -e
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$HOME/.openclaw/extensions/blockrun-clawrouter"
LEGACY_PLUGIN_DIR="$HOME/.openclaw/extensions/clawrouter"
CONFIG_PATH="$HOME/.openclaw/openclaw.json"
WALLET_FILE="$HOME/.openclaw/blockrun/wallet.key"
WALLET_BACKUP=""
WALLET_EXISTED=0
PLUGIN_BACKUP=""
LEGACY_PLUGIN_BACKUP=""
LEGACY_BLOCKRUN_INSTALL=0
CONFIG_BACKUP=""
CONFIG_EXISTED=0
CREDS_DIR="$HOME/.openclaw/credentials"
CREDS_BACKUP=""
CREDS_EXISTED=0
INSTALL_SPEC="${BLOCKRUN_CLAWROUTER_INSTALL_SPEC:-@blockrun/clawrouter}"

[ -f "$WALLET_FILE" ] && WALLET_EXISTED=1
[ -f "$CONFIG_PATH" ] && CONFIG_EXISTED=1
[ -d "$CREDS_DIR" ] && CREDS_EXISTED=1

is_blockrun_plugin_dir() {
  local candidate_dir="$1"
  [ -d "$candidate_dir" ] || return 1
  node -e '
const fs = require("fs");
const path = require("path");
const dir = process.argv[1];
for (const candidate of [path.join(dir, "package.json"), path.join(dir, "package", "package.json")]) {
  try {
    if (JSON.parse(fs.readFileSync(candidate, "utf8")).name === "@blockrun/clawrouter") process.exit(0);
  } catch {}
}
process.exit(1);
' "$candidate_dir"
}

cleanup_backups() {
  if [ -n "$PLUGIN_BACKUP" ] && [ -d "$PLUGIN_BACKUP" ]; then
    rm -rf "$PLUGIN_BACKUP"
  fi
  if [ -n "$LEGACY_PLUGIN_BACKUP" ] && [ -d "$LEGACY_PLUGIN_BACKUP" ]; then
    rm -rf "$LEGACY_PLUGIN_BACKUP"
  fi
  if [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ]; then
    rm -f "$CONFIG_BACKUP"
  fi
  if [ -n "$CREDS_BACKUP" ] && [ -d "$CREDS_BACKUP" ]; then
    rm -rf "$(dirname "$CREDS_BACKUP")"
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

    if [ -n "$LEGACY_PLUGIN_BACKUP" ] && [ -d "$LEGACY_PLUGIN_BACKUP" ]; then
      mv "$LEGACY_PLUGIN_BACKUP" "$LEGACY_PLUGIN_DIR"
      echo "  ✓ Restored previous legacy BlockRun plugin files"
    fi

    if [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ]; then
      cp "$CONFIG_BACKUP" "$CONFIG_PATH"
      echo "  ✓ Restored previous OpenClaw config"
    elif [ "$CONFIG_EXISTED" = "0" ]; then
      rm -f "$CONFIG_PATH"
    fi

    if [ "$WALLET_EXISTED" = "1" ] && [ -n "$WALLET_BACKUP" ] && [ -f "$WALLET_BACKUP" ]; then
      mkdir -p "$(dirname "$WALLET_FILE")"
      cp "$WALLET_BACKUP" "$WALLET_FILE"
      chmod 600 "$WALLET_FILE"
      echo "  ✓ Restored previous wallet"
    elif [ "$WALLET_EXISTED" = "0" ]; then
      rm -f "$WALLET_FILE"
    fi

    if [ "$CREDS_EXISTED" = "1" ] && [ -n "$CREDS_BACKUP" ] && [ -d "$CREDS_BACKUP" ]; then
      rm -rf "$CREDS_DIR"
      mkdir -p "$CREDS_DIR"
      cp -a "$CREDS_BACKUP/." "$CREDS_DIR/"
      echo "  ✓ Restored OpenClaw credentials"
    elif [ "$CREDS_EXISTED" = "0" ]; then
      rm -rf "$CREDS_DIR"
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
  WALLET_EXISTED=1
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

if is_blockrun_plugin_dir "$LEGACY_PLUGIN_DIR"; then
  LEGACY_BLOCKRUN_INSTALL=1
  LEGACY_PLUGIN_BACKUP="$HOME/.openclaw/blockrun/clawrouter.legacy.backup.$(date +%s)"
  mv "$LEGACY_PLUGIN_DIR" "$LEGACY_PLUGIN_BACKUP"
  echo "  ✓ Legacy BlockRun plugin staged at: $LEGACY_PLUGIN_BACKUP"
fi

if [ -f "$CONFIG_PATH" ]; then
  CONFIG_EXISTED=1
  CONFIG_BACKUP="$CONFIG_PATH.clawrouter-reinstall.$(date +%s).bak"
  cp "$CONFIG_PATH" "$CONFIG_BACKUP"
  echo "  ✓ Config backed up to: $CONFIG_BACKUP"
fi
echo ""

# Third-party plugins are never removed by a ClawRouter reinstall. OpenClaw's
# conflict diagnostics let the user choose which slash-command owner wins.

# 2. Clean config entries
echo "→ Cleaning config entries..."
LEGACY_BLOCKRUN_INSTALL="$LEGACY_BLOCKRUN_INSTALL" node -e "
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

// Never remove lowercase clawrouter: OpenClaw's official router owns it.
for (const key of ['blockrun-clawrouter', 'ClawRouter', '@blockrun/clawrouter']) {
  if (c.plugins?.entries?.[key]) delete c.plugins.entries[key];
  if (c.plugins?.installs?.[key]) delete c.plugins.installs[key];
}
if (process.env.LEGACY_BLOCKRUN_INSTALL === '1' && c.plugins?.entries?.clawrouter) {
  const legacy = c.plugins.entries.clawrouter;
  for (const key of ['walletKey', 'routing']) {
    delete legacy[key];
    if (legacy.config) delete legacy.config[key];
  }
  if (legacy.config && Object.keys(legacy.config).length === 0) delete legacy.config;
}

// Clean plugins.allow — remove only ClawRouter entries; preserve every other
// plugin the user has allowed, including bare local/custom plugin IDs.
if (Array.isArray(c.plugins?.allow)) {
  const before = c.plugins.allow.length;
  c.plugins.allow = c.plugins.allow.filter(
    p => p !== 'blockrun-clawrouter' && p !== 'ClawRouter' && p !== '@blockrun/clawrouter'
  );
  const removed = before - c.plugins.allow.length;
  if (removed > 0) console.log('  Staged BlockRun plugin config for reinstall');
}

// OpenClaw 2026.5.2+ validates tools.web.search.provider at config-load time.
// Pre-v0.12.186 ClawRouter persisted 'blockrun-exa' here, which is unknown to
// the validator BEFORE our register() callback declares it, causing install
// rollback. Strip the legacy value; v0.12.186+ sets it only on the runtime
// config after registerWebSearchProvider() succeeds.
if (c?.tools?.web?.search?.provider === 'blockrun-exa') {
  delete c.tools.web.search.provider;
  console.log('  Removed legacy tools.web.search.provider=blockrun-exa (set at runtime now)');
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
const fs = require('fs');
const os = require('os');
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
if [ -d "$CREDS_DIR" ]; then
  CREDS_EXISTED=1
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
  if is_blockrun_plugin_dir "$stale"; then
    rm -rf "$stale"
  fi
done

echo "→ Installing ClawRouter..."
OPENCLAW_CAPABILITY_ARGS=()
if openclaw plugins install --help 2>&1 | grep -q -- '--accept-capabilities'; then
  OPENCLAW_CAPABILITY_ARGS=(--accept-capabilities)
fi
# `--force` is required when the plugin is already installed at the same path.
# Reinstall.sh covers both fresh and re-install flows; without --force the
# re-install flow fails with "plugin already exists", our EXIT trap rolls back,
# and the user is stranded on whatever they had before. --force is idempotent.
#
# Run with timeout — openclaw plugins install may hang after printing
# "Installed plugin: clawrouter" in OpenClaw v2026.4.5 (parallel plugin loading).
# 120s is enough for slow connections; the install itself completes in ~30s.
if command -v timeout >/dev/null 2>&1; then
  timeout 120 openclaw plugins install --force "${OPENCLAW_CAPABILITY_ARGS[@]}" "$INSTALL_SPEC" || {
    exit_code=$?
    if [ $exit_code -eq 124 ]; then
      echo "  (install command timed out — this is normal with OpenClaw v2026.4.5)"
      echo "  Plugin was installed successfully before the hang."
    else
      exit $exit_code
    fi
  }
else
  openclaw plugins install --force "${OPENCLAW_CAPABILITY_ARGS[@]}" "$INSTALL_SPEC"
fi

# Restore credentials after plugin install (always restore to preserve user's channels)
if [ -n "$CREDS_BACKUP" ] && [ -d "$CREDS_BACKUP" ]; then
  mkdir -p "$CREDS_DIR"
  cp -a "$CREDS_BACKUP/." "$CREDS_DIR/"
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
    echo "  See https://blockrun.ai/clawrouter.md for troubleshooting"
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
const topModelsPath = '$SCRIPT_DIR/../src/top-models.json';
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

  const TOP_MODELS = JSON.parse(fs.readFileSync(topModelsPath, 'utf8'));
  if (!Array.isArray(TOP_MODELS)) {
    throw new Error('src/top-models.json must contain an array');
  }

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
node - "$CONFIG_PATH" "$CONFIG_BACKUP" "$LEGACY_BLOCKRUN_INSTALL" <<'NODE'
const fs = require('fs');
const [configPath, backupPath, legacyOwned] = process.argv.slice(2);
function atomicWrite(filePath, data) {
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    // Ensure the distinct BlockRun id is enabled only after its package exists.
    if (!config.plugins) config.plugins = {};
    if (!config.plugins.entries) config.plugins.entries = {};
    const preserved = backupPath && fs.existsSync(backupPath)
      ? JSON.parse(fs.readFileSync(backupPath, 'utf8'))
      : {};
    const current = config.plugins.entries['blockrun-clawrouter'] || {};
    const moveOwnedFields = (source, destination, removeFromSource = false) => {
      if (!source || typeof source !== 'object') return;
      for (const key of ['walletKey', 'routing']) {
        if (!(key in destination) && key in source) destination[key] = source[key];
        if (removeFromSource) delete source[key];
      }
      if (source.config && typeof source.config === 'object') {
        destination.config ??= {};
        for (const key of ['walletKey', 'routing']) {
          if (!(key in destination.config) && key in source.config) destination.config[key] = source.config[key];
          if (removeFromSource) delete source.config[key];
        }
        if (Object.keys(destination.config).length === 0) delete destination.config;
        if (removeFromSource && Object.keys(source.config).length === 0) delete source.config;
      }
    };
    moveOwnedFields(preserved?.plugins?.entries?.['blockrun-clawrouter'], current);
    if (legacyOwned === '1') {
      const legacy = config.plugins.entries.clawrouter;
      const preservedLegacy = preserved?.plugins?.entries?.clawrouter;
      if (typeof preservedLegacy?.enabled === 'boolean' && typeof current.enabled !== 'boolean') {
        current.enabled = preservedLegacy.enabled;
      }
      moveOwnedFields(preservedLegacy, current);
      moveOwnedFields(legacy, current, true);
    }
    current.enabled = true;
    config.plugins.entries['blockrun-clawrouter'] = current;
    if (!Array.isArray(config.plugins.allow)) {
      config.plugins.allow = [];
    }
    if (!config.plugins.allow.includes('blockrun-clawrouter')) {
      config.plugins.allow.push('blockrun-clawrouter');
      console.log('  Added blockrun-clawrouter to plugins.allow');
    } else {
      console.log('  Plugin already in allow list');
    }
    if (Array.isArray(config.plugins.deny)) {
      config.plugins.deny = config.plugins.deny.filter(id => id !== 'blockrun-clawrouter');
    }

    atomicWrite(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.log('  Could not update config:', e.message);
  }
} else {
  console.log('  No openclaw.json found, skipping');
}
NODE

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
  if is_blockrun_plugin_dir "$stage_dir"; then
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
for backup_dir in "$HOME/.openclaw/extensions/clawrouter.backup."*; do
  if is_blockrun_plugin_dir "$backup_dir"; then
    rm -rf "$backup_dir"
    CLEANED=$((CLEANED + 1))
  fi
done
for backup_dir in "$HOME/.openclaw/blockrun/clawrouter.backup."*; do
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
  const blockrunIds = new Set(['blockrun-clawrouter', 'ClawRouter', '@blockrun/clawrouter']);
  // Remove plugins.entries pointing to stale directories
  if (config?.plugins?.entries) {
    for (const [key, val] of Object.entries(config.plugins.entries)) {
      const path = typeof val === 'string' ? val : val?.path || val?.main || '';
      if (blockrunIds.has(key) && isStale(path)) {
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
      if (blockrunIds.has(key) && isStale(path)) {
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

cleanup_backups
trap - EXIT INT TERM
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
echo "  /model opus      → claude-opus-5"
echo "  /model codex     → openai/gpt-5.3-codex"
echo "  /model deepseek  → deepseek/deepseek-chat"
echo "  /model free      → nemotron-3.5-lightning (default free)"
echo ""
echo "Free models (no wallet needed):"
echo "  /model lightning      → nemotron-3.5-lightning (1M ctx, reasoning)"
echo "  /model nano-30b       → nemotron-3-nano-30b (fastest, ~121 tok/s)"
echo "  /model north-mini     → north-mini-code (Cohere, coding, sub-second)"
echo "  /model laguna         → laguna-xs-2.1 (Poolside, coding, ~161 tok/s)"
echo "  /model vision-free    → nemotron-3-nano-omni (text/image/video/audio)"
echo "  /model ultra-550b     → nemotron-3-ultra-550b (550B MoE, 1M ctx)"
echo "  /model llama-vision   → llama-3.2-11b-vision (Meta Llama, images)"
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
echo "  /imagegen --model gpt-image-2 <prompt>       # GPT Image 2"
echo "  /imagegen --model gpt-image <prompt>         # GPT Image 1"
echo ""
echo "CLI commands:"
echo "  npx @blockrun/clawrouter report            # daily usage report"
echo "  npx @blockrun/clawrouter report weekly      # weekly report"
echo "  npx @blockrun/clawrouter report monthly     # monthly report"
echo "  npx @blockrun/clawrouter doctor             # AI diagnostics"
echo ""
echo "To uninstall: bash ~/.openclaw/extensions/blockrun-clawrouter/scripts/uninstall.sh"
