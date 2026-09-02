#!/bin/bash
set -e
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─────────────────────────────────────────────────────────────
#  ClawRouter Update Script
#  Safe update: backs up wallet key BEFORE touching anything,
#  restores it if the update process somehow wiped it.
# ─────────────────────────────────────────────────────────────

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
ACTIVE_PACKAGE_DIR=""
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

NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo "")"
if [ -n "$NPM_PREFIX" ] && [ -d "$NPM_PREFIX/bin" ]; then
  PATH="$NPM_PREFIX/bin:$PATH"
  export PATH
fi

find_clawrouter_package_dir() {
  node <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = os.homedir();
const candidates = [
  { packagePath: path.join(home, '.openclaw', 'extensions', 'blockrun-clawrouter', 'package.json'), priority: 0 },
  { packagePath: path.join(home, '.openclaw', 'extensions', 'clawrouter', 'package.json'), priority: 3 },
  { packagePath: path.join(home, '.openclaw', 'npm', 'node_modules', '@blockrun', 'clawrouter', 'package.json'), priority: 2 },
];

const projectsDir = path.join(home, '.openclaw', 'npm', 'projects');
try {
  for (const name of fs.readdirSync(projectsDir)) {
    candidates.push({
      packagePath: path.join(projectsDir, name, 'node_modules', '@blockrun', 'clawrouter', 'package.json'),
      priority: 1,
    });
  }
} catch {}

function versionParts(version) {
  return String(version || '').split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

let best = null;
for (const candidate of candidates) {
  try {
    const stat = fs.statSync(candidate.packagePath);
    const pkg = JSON.parse(fs.readFileSync(candidate.packagePath, 'utf8'));
    if (pkg?.name !== '@blockrun/clawrouter') continue;
    const versionOrder = best ? compareVersions(pkg.version, best.pkg.version) : 1;
    if (
      !best ||
      versionOrder > 0 ||
      (versionOrder === 0 &&
        (candidate.priority < best.priority ||
          (candidate.priority === best.priority && stat.mtimeMs > best.mtimeMs)))
    ) {
      best = { ...candidate, pkg, mtimeMs: stat.mtimeMs };
    }
  } catch {}
}

if (best) console.log(path.dirname(best.packagePath));
NODE
}

sync_cli_shim() {
  local package_dir="$1"
  if [ -z "$package_dir" ] || [ ! -f "$package_dir/dist/cli.js" ]; then
    echo "  ⚠ Could not update CLI shim: ClawRouter CLI not found"
    return 1
  fi

  local prefix
  prefix=$(npm config get prefix 2>/dev/null || echo "")
  if [ -z "$prefix" ]; then
    echo "  ⚠ Could not update CLI shim: npm prefix unavailable"
    return 1
  fi

  local bin_dir="$prefix/bin"
  mkdir -p "$bin_dir"
  rm -f "$bin_dir/clawrouter"
  cat >"$bin_dir/clawrouter" <<EOF
#!/bin/sh
exec node "$package_dir/dist/cli.js" "\$@"
EOF
  chmod +x "$bin_dir/clawrouter"
  echo "  ✓ CLI shim updated: $bin_dir/clawrouter → $package_dir/dist/cli.js"
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
    echo "✗ Update failed. Restoring previous ClawRouter install..."

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
ACTIVE_PACKAGE_DIR=$(find_clawrouter_package_dir)

echo "→ Checking wallet..."

if [ -f "$WALLET_FILE" ]; then
  WALLET_EXISTED=1
  # Validate the key looks correct before backing up
  WALLET_KEY=$(cat "$WALLET_FILE" | tr -d '[:space:]')
  KEY_LEN=${#WALLET_KEY}

  if [[ "$WALLET_KEY" == 0x* ]] && [ "$KEY_LEN" -eq 66 ]; then
    # Derive wallet address via node (viem is available post-install)
    WALLET_ADDRESS=$(node -e "
      try {
        const { privateKeyToAccount } = require(require.resolve('viem/accounts', { paths: ['$ACTIVE_PACKAGE_DIR'] }));
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

# Stage a pre-rename directory only when its package metadata proves ownership.
# The same path may otherwise belong to OpenClaw's official bundled router.
if is_blockrun_plugin_dir "$LEGACY_PLUGIN_DIR"; then
  LEGACY_BLOCKRUN_INSTALL=1
  LEGACY_PLUGIN_BACKUP="$HOME/.openclaw/blockrun/clawrouter.legacy.backup.$(date +%s)"
  mv "$LEGACY_PLUGIN_DIR" "$LEGACY_PLUGIN_BACKUP"
  echo "  ✓ Legacy BlockRun plugin staged at: $LEGACY_PLUGIN_BACKUP"
fi

if [ -f "$CONFIG_PATH" ]; then
  CONFIG_EXISTED=1
  CONFIG_BACKUP="$CONFIG_PATH.clawrouter-update.$(date +%s).bak"
  cp "$CONFIG_PATH" "$CONFIG_BACKUP"
  echo "  ✓ Config backed up to: $CONFIG_BACKUP"
fi

echo ""

# Third-party plugins are never removed by a ClawRouter update. If another
# plugin owns the same slash command, OpenClaw reports the conflict and the
# user can choose which plugin to disable.

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
LEGACY_BLOCKRUN_INSTALL="$LEGACY_BLOCKRUN_INSTALL" node -e "
const fs = require('fs');
const path = require('path');
const configPath = '$CONFIG_PATH';
if (!fs.existsSync(configPath)) process.exit(0);
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let changed = false;

  // Never remove lowercase clawrouter: OpenClaw's official router owns it.
  const entries = config?.plugins?.entries;
  const installs = config?.plugins?.installs;
  for (const key of ['blockrun-clawrouter', 'ClawRouter', '@blockrun/clawrouter']) {
    if (entries?.[key]) { delete entries[key]; changed = true; console.log('  Removed plugins.entries.' + key); }
    if (installs?.[key]) { delete installs[key]; changed = true; console.log('  Removed plugins.installs.' + key); }
  }
  if (process.env.LEGACY_BLOCKRUN_INSTALL === '1' && entries?.clawrouter) {
    const legacy = entries.clawrouter;
    for (const key of ['walletKey', 'routing']) {
      if (Object.prototype.hasOwnProperty.call(legacy, key)) { delete legacy[key]; changed = true; }
      if (legacy.config && Object.prototype.hasOwnProperty.call(legacy.config, key)) {
        delete legacy.config[key];
        changed = true;
      }
    }
    if (legacy.config && Object.keys(legacy.config).length === 0) delete legacy.config;
  }

  // Clean plugins.allow — remove only ClawRouter entries; preserve every other
  // plugin the user has allowed, including bare local/custom plugin IDs.
  if (Array.isArray(config?.plugins?.allow)) {
    const before = config.plugins.allow.length;
    config.plugins.allow = config.plugins.allow.filter(
      p => p !== 'blockrun-clawrouter' && p !== 'ClawRouter' && p !== '@blockrun/clawrouter'
    );
    const removed = before - config.plugins.allow.length;
    if (removed > 0) { changed = true; console.log('  Staged BlockRun plugin config for reinstall'); }
  }

  // OpenClaw 2026.5.2+ validates tools.web.search.provider at config-load
  // time. Pre-v0.12.186 ClawRouter persisted 'blockrun-exa' here, which is
  // unknown to the validator BEFORE our register() callback declares it,
  // causing an install rollback. Strip the legacy value; v0.12.186+ sets it
  // only on the runtime config after registerWebSearchProvider() succeeds.
  if (config?.tools?.web?.search?.provider === 'blockrun-exa') {
    delete config.tools.web.search.provider;
    changed = true;
    console.log('  Removed legacy tools.web.search.provider=blockrun-exa (set at runtime now)');
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

apply_scoped_model_trim() {
  local rejected_path="$1"
  if [ -z "$rejected_path" ] || [ ! -f "$rejected_path" ] || [ ! -f "$CONFIG_PATH" ]; then
    return 1
  fi

  CONFIG_PATH="$CONFIG_PATH" REJECTED_CONFIG_PATH="$rejected_path" node <<'NODE'
const fs = require('fs');

const activePath = process.env.CONFIG_PATH;
const rejectedPath = process.env.REJECTED_CONFIG_PATH;

function fail(message) {
  console.log(`  Skipped scoped config trim: ${message}`);
  process.exit(1);
}

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null, null, 2));
}

function objectKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getBlockrunModels(config) {
  return config?.models?.providers?.blockrun?.models;
}

const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
const rejected = JSON.parse(fs.readFileSync(rejectedPath, 'utf8'));

const activeTopKeys = objectKeys(active);
const rejectedTopKeys = objectKeys(rejected);
if (activeTopKeys.join('\0') !== rejectedTopKeys.join('\0')) {
  fail('top-level config keys changed');
}

for (const key of ['auth', 'channels', 'gateway', 'plugins', 'models']) {
  if (!(key in active) || !(key in rejected)) fail(`missing required ${key} section`);
}

const activeModels = getBlockrunModels(active);
const rejectedModels = getBlockrunModels(rejected);
if (!Array.isArray(activeModels) || !Array.isArray(rejectedModels)) {
  fail('blockrun model list is missing or invalid');
}

if (activeModels.length <= rejectedModels.length) {
  fail(`model count did not shrink (${activeModels.length} -> ${rejectedModels.length})`);
}

if (rejectedModels.length < 20 || rejectedModels.length > 100) {
  fail(`unexpected curated model count (${rejectedModels.length})`);
}

let activeCursor = 0;
for (const model of rejectedModels) {
  const id = model?.id;
  if (typeof id !== 'string' || id.length === 0) fail('rejected model list contains an invalid id');
  const nextIndex = activeModels.findIndex((candidate, index) => index >= activeCursor && candidate?.id === id);
  if (nextIndex === -1) fail(`rejected model ${id} is not present in active model list order`);
  activeCursor = nextIndex + 1;
}

for (const key of activeTopKeys) {
  if (key === 'models') continue;
  const delta = Math.abs(byteSize(active[key]) - byteSize(rejected[key]));
  if (delta > 2048) fail(`non-model section changed too much: ${key}`);
}

const activeWithoutModelList = clone(active.models);
const rejectedWithoutModelList = clone(rejected.models);
activeWithoutModelList.providers.blockrun.models = [];
rejectedWithoutModelList.providers.blockrun.models = [];
const residualModelDelta = Math.abs(byteSize(activeWithoutModelList) - byteSize(rejectedWithoutModelList));
if (residualModelDelta > 4096) {
  fail('models section changed beyond the blockrun model list');
}

const totalDrop = byteSize(active) - byteSize(rejected);
const modelListDrop = byteSize(activeModels) - byteSize(rejectedModels);
if (totalDrop <= 0 || modelListDrop / totalDrop < 0.65) {
  fail('size drop is not primarily from the blockrun model list');
}

active.models.providers.blockrun.models = rejectedModels;
const tmpPath = `${activePath}.tmp.${process.pid}`;
fs.writeFileSync(tmpPath, JSON.stringify(active, null, 2));
fs.renameSync(tmpPath, activePath);

console.log(
  `  ✓ Applied scoped BlockRun model-list trim (${activeModels.length} -> ${rejectedModels.length})`,
);
NODE
}

handle_openclaw_install_failure() {
  local exit_code="$1"
  if [ "$exit_code" -eq 124 ]; then
    echo "  (install command timed out — this is normal with OpenClaw v2026.4.5)"
    if [ -f "$PLUGIN_DIR/package.json" ]; then
      echo "  Plugin package.json is present; treating install as completed before the hang."
      return 0
    fi
    echo "  Plugin package.json is missing after timeout; continuing with direct npm install."
    OPENCLAW_INSTALL_RECOVERABLE=1
    return "$exit_code"
  fi

  if grep -q "Config write rejected: .*size-drop:" "$OPENCLAW_INSTALL_LOG"; then
    local rejected_path
    rejected_path=$(node -e "const fs=require('fs'); const text=fs.readFileSync(process.argv[1],'utf8'); const m=text.match(/Rejected payload saved to ([^\\s]+)\\./); if (m) console.log(m[1]);" "$OPENCLAW_INSTALL_LOG")
    echo "  ⚠ OpenClaw rejected a config size-drop during plugin registration."
    if apply_scoped_model_trim "$rejected_path"; then
      echo "  Continuing with direct npm install after the scoped config update."
    else
      echo "  Continuing with direct npm install while preserving your existing config."
    fi
    OPENCLAW_INSTALL_RECOVERABLE=1
    return 0
  fi

  return "$exit_code"
}

echo "→ Installing latest ClawRouter..."
OPENCLAW_CAPABILITY_ARGS=()
if openclaw plugins install --help 2>&1 | grep -q -- '--accept-capabilities'; then
  OPENCLAW_CAPABILITY_ARGS=(--accept-capabilities)
fi
# `--force` is required when the plugin is already installed at the same path
# (which is always true on update). Without it, OpenClaw exits non-zero with
# "plugin already exists" and our EXIT trap rolls back, stranding the user on
# the previous version. `--force` is idempotent for both fresh + upgrade flows.
#
# OpenClaw can also reject its own config rewrite when it would shrink a large
# user config. Treat that as recoverable: keep the user's restored config and
# install ClawRouter files directly from npm below.
OPENCLAW_INSTALL_RECOVERABLE=0
OPENCLAW_INSTALL_LOG="$(mktemp)"
#
# Run with timeout — openclaw plugins install may hang after printing
# "Installed plugin: clawrouter" in OpenClaw v2026.4.5 (parallel plugin loading).
# 120s is enough for slow connections; the install itself completes in ~30s.
if command -v timeout >/dev/null 2>&1; then
  timeout 120 openclaw plugins install --force "${OPENCLAW_CAPABILITY_ARGS[@]}" "$INSTALL_SPEC" 2>&1 | tee "$OPENCLAW_INSTALL_LOG" || {
    exit_code=$?
    handle_openclaw_install_failure "$exit_code" || {
      [ "$OPENCLAW_INSTALL_RECOVERABLE" = "1" ] || exit $exit_code
    }
  }
else
  openclaw plugins install --force "${OPENCLAW_CAPABILITY_ARGS[@]}" "$INSTALL_SPEC" 2>&1 | tee "$OPENCLAW_INSTALL_LOG" || {
    exit_code=$?
    handle_openclaw_install_failure "$exit_code" || {
      [ "$OPENCLAW_INSTALL_RECOVERABLE" = "1" ] || exit $exit_code
    }
  }
fi
rm -f "$OPENCLAW_INSTALL_LOG"

# Enable only after the package exists so OpenClaw does not report a stale id
# while the previous install is staged outside extensions/.
node - "$CONFIG_PATH" "$CONFIG_BACKUP" "$LEGACY_BLOCKRUN_INSTALL" <<'NODE'
const fs = require('fs');
const [configPath, backupPath, legacyOwned] = process.argv.slice(2);
if (!fs.existsSync(configPath)) process.exit(0);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const preserved = backupPath && fs.existsSync(backupPath)
  ? JSON.parse(fs.readFileSync(backupPath, 'utf8'))
  : {};
config.plugins ??= {};
config.plugins.entries ??= {};
const current = config.plugins.entries['blockrun-clawrouter'] || {};
const preservedCurrent = preserved?.plugins?.entries?.['blockrun-clawrouter'];
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
moveOwnedFields(preservedCurrent, current);
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
if (Array.isArray(config.plugins.allow) && !config.plugins.allow.includes('blockrun-clawrouter')) {
  config.plugins.allow.push('blockrun-clawrouter');
}
if (Array.isArray(config.plugins.deny)) {
  config.plugins.deny = config.plugins.deny.filter(id => id !== 'blockrun-clawrouter');
}
const tmp = configPath + '.tmp.' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
fs.renameSync(tmp, configPath);
NODE

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

LATEST_VER=$(npm view @blockrun/clawrouter@latest version 2>/dev/null || echo "")
if [ -z "$LATEST_VER" ]; then
  echo "  ✗ Could not resolve latest ClawRouter version from npm"
  exit 1
fi

ACTIVE_PACKAGE_DIR=$(find_clawrouter_package_dir)
INSTALLED_VER=""
if [ -n "$ACTIVE_PACKAGE_DIR" ] && [ -f "$ACTIVE_PACKAGE_DIR/package.json" ]; then
  INSTALLED_VER=$(node -e "try{const p=require('$ACTIVE_PACKAGE_DIR/package.json');console.log(p.version);}catch{console.log('');}" 2>/dev/null || echo "")
fi

if [ "$OPENCLAW_INSTALL_RECOVERABLE" = "1" ] || [ -z "$INSTALLED_VER" ] || [ "$INSTALLED_VER" != "$LATEST_VER" ]; then
  if [ -n "$INSTALLED_VER" ] && [ "$INSTALLED_VER" != "$LATEST_VER" ]; then
    echo "  ⚠️  OpenClaw installed v${INSTALLED_VER} but latest is v${LATEST_VER}"
  fi
  force_install_from_npm "$LATEST_VER"
  ACTIVE_PACKAGE_DIR=$(find_clawrouter_package_dir)
  INSTALLED_VER=$(node -e "try{const p=require('$ACTIVE_PACKAGE_DIR/package.json');console.log(p.version);}catch{console.log('');}" 2>/dev/null || echo "")
fi

if [ -z "$ACTIVE_PACKAGE_DIR" ] || [ -z "$INSTALLED_VER" ]; then
  echo "  ✗ Could not verify ClawRouter install"
  exit 1
fi

echo "  ✓ ClawRouter v${INSTALLED_VER} installed at $ACTIVE_PACKAGE_DIR"
sync_cli_shim "$ACTIVE_PACKAGE_DIR"
# ── Step 4c: Ensure all dependencies are installed ────────────
# openclaw's plugin installer may skip native/optional deps like @solana/kit.
# Run npm install in the plugin directory to fill any gaps.
if [ -n "$ACTIVE_PACKAGE_DIR" ] && [ -f "$ACTIVE_PACKAGE_DIR/package.json" ]; then
  echo "→ Installing dependencies (Solana, x402, etc.)..."
  run_dependency_install "$ACTIVE_PACKAGE_DIR"
fi

# ── Step 5: Verify wallet survived ─────────────────────────────
# ── Step 4d: Post-install duplicate cleanup ──────────────────────
# Remove only obsolete BlockRun aliases. Preserve both the current
# blockrun-clawrouter entry and OpenClaw's official clawrouter entry.
echo "→ Cleaning duplicate plugin entries..."
node -e "
const fs = require('fs');
const configPath = '$CONFIG_PATH';
if (!fs.existsSync(configPath)) process.exit(0);
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let changed = false;
  // Remove entries that duplicate the installs record
  for (const key of ['ClawRouter', '@blockrun/clawrouter']) {
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

# ── Step 8: Populate model allowlist from shared curated list ──
echo "→ Populating model allowlist..."
node -e "
const os = require('os');
const fs = require('fs');
const path = require('path');
const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const topModelsPath = path.join('$ACTIVE_PACKAGE_DIR', 'src', 'top-models.json');

if (!fs.existsSync(configPath)) {
  console.log('  No config file found, skipping');
  process.exit(0);
}

try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const TOP_MODELS = JSON.parse(fs.readFileSync(topModelsPath, 'utf8'));
  if (!Array.isArray(TOP_MODELS)) {
    throw new Error('src/top-models.json must contain an array');
  }

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

# OpenClaw 2026.6 migrates the legacy plugin install index into shared SQLite.
# If the old JSON index still contains a stale ClawRouter record, OpenClaw keeps
# warning about conflicting install metadata on every doctor/restart. Clean only
# ClawRouter's legacy record after this updater has verified the current install.
echo "→ Cleaning stale ClawRouter install metadata..."
node -e "
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = os.homedir();
const legacyPath = path.join(home, '.openclaw', 'plugins', 'installs.json');

function currentPackageCandidates() {
  const candidates = [
    { packagePath: path.join(home, '.openclaw', 'extensions', 'blockrun-clawrouter', 'package.json'), priority: 0 },
    { packagePath: path.join(home, '.openclaw', 'extensions', 'clawrouter', 'package.json'), priority: 3 },
    {
      packagePath: path.join(home, '.openclaw', 'npm', 'node_modules', '@blockrun', 'clawrouter', 'package.json'),
      priority: 2,
    },
  ];
  const projectsDir = path.join(home, '.openclaw', 'npm', 'projects');
  try {
    for (const name of fs.readdirSync(projectsDir)) {
      candidates.push({
        packagePath: path.join(projectsDir, name, 'node_modules', '@blockrun', 'clawrouter', 'package.json'),
        priority: 1,
      });
    }
  } catch {}
  return candidates;
}

function versionParts(version) {
  return String(version || '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function newestCurrentPackage() {
  let best = null;
  for (const candidate of currentPackageCandidates()) {
    try {
      const { packagePath, priority } = candidate;
      const stat = fs.statSync(packagePath);
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      if (pkg?.name !== '@blockrun/clawrouter') continue;
      const versionOrder = best ? compareVersions(pkg.version, best.pkg.version) : 1;
      if (
        !best ||
        versionOrder > 0 ||
        (versionOrder === 0 &&
          (priority < best.priority || (priority === best.priority && stat.mtimeMs > best.mtimeMs)))
      ) {
        best = { packagePath, pkg, mtimeMs: stat.mtimeMs, priority };
      }
    } catch {}
  }
  return best;
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

try {
  if (!fs.existsSync(legacyPath)) {
    console.log('  ✓ No legacy install index found');
    process.exit(0);
  }
  const current = newestCurrentPackage();
  if (!current) {
    console.log('  Skipped: current ClawRouter package.json not found');
    process.exit(0);
  }

  const index = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  const currentPkg = current.pkg;
  const legacyRecord = index?.installRecords?.clawrouter;

  if (!legacyRecord) {
    console.log('  ✓ Legacy install index has no ClawRouter record');
    process.exit(0);
  }

  const recordText = JSON.stringify(legacyRecord);
  let provenBlockRun = recordText.includes('@blockrun/clawrouter');
  if (!provenBlockRun) {
    try {
      const packagePath = path.join(String(legacyRecord.installPath || ''), 'package.json');
      provenBlockRun = JSON.parse(fs.readFileSync(packagePath, 'utf8')).name === '@blockrun/clawrouter';
    } catch {}
  }
  if (!provenBlockRun) {
    console.log('  Preserved ambiguous official clawrouter install metadata');
    process.exit(0);
  }

  const currentVersion = String(currentPkg.version || '');
  const legacyVersion = String(legacyRecord.version || legacyRecord.resolvedVersion || '');
  const legacyPathValue = String(legacyRecord.installPath || '');
  const currentPath = path.dirname(current.packagePath);
  const stale = legacyVersion !== currentVersion || path.resolve(legacyPathValue) !== path.resolve(currentPath);

  if (!stale) {
    console.log('  ✓ Legacy ClawRouter install metadata already matches current install');
    process.exit(0);
  }

  delete index.installRecords.clawrouter;
  if (Array.isArray(index.plugins)) {
    index.plugins = index.plugins.filter((plugin) => {
      if (plugin?.pluginId !== 'clawrouter') return true;
      const text = JSON.stringify(plugin);
      if (text.includes('@blockrun/clawrouter')) return false;
      const pluginPath = String(plugin?.installPath || plugin?.path || '');
      return !pluginPath || path.resolve(pluginPath) !== path.resolve(legacyPathValue);
    });
  }
  index.refreshReason = 'clawrouter-stale-metadata-cleanup';
  index.generatedAtMs = Date.now();
  atomicWrite(legacyPath, JSON.stringify(index, null, 2));
  console.log('  ✓ Removed stale legacy ClawRouter install metadata (' + (legacyVersion || 'unknown') + ' -> ' + currentVersion + ')');
} catch (e) {
  console.log('  Skipped: ' + e.message);
}
"

# ── Summary ─────────────────────────────────────────────────────
cleanup_backups
trap - EXIT INT TERM
echo ""
echo "✓ ClawRouter updated successfully!"
echo ""

# Show final wallet address
if [ -f "$WALLET_FILE" ]; then
  FINAL_KEY=$(cat "$WALLET_FILE" | tr -d '[:space:]')
  FINAL_ADDRESS=$(node -e "
    try {
      const { privateKeyToAccount } = require(require.resolve('viem/accounts', { paths: ['$ACTIVE_PACKAGE_DIR'] }));
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
