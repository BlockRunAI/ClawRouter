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
  PLUGIN_BACKUP="$HOME/.openclaw/extensions/clawrouter.backup.$(date +%s)"
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

// Clean plugin entries
if (c.plugins?.entries?.clawrouter) delete c.plugins.entries.clawrouter;
if (c.plugins?.installs?.clawrouter) delete c.plugins.installs.clawrouter;
// Clean plugins.allow (removes stale clawrouter reference)
if (Array.isArray(c.plugins?.allow)) {
  c.plugins.allow = c.plugins.allow.filter(p => p !== 'clawrouter' && p !== '@blockrun/clawrouter');
}
// Remove deprecated model aliases from picker
const deprecated = [
  'blockrun/xai/grok-code-fast-1', // delisted 2026-03-12
  'blockrun/xai/grok-3-fast',      // removed (too expensive)
];
if (c.agents?.defaults?.models) {
  for (const key of deprecated) {
    if (c.agents.defaults.models[key]) {
      delete c.agents.defaults.models[key];
      console.log('  Removed deprecated alias: ' + key);
    }
  }
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

# 6. Install plugin (config is ready, but no allow list yet to avoid validation error)
echo "→ Installing ClawRouter..."
openclaw plugins install @blockrun/clawrouter

# 6.1. Verify installation (check dist/ files exist)
echo "→ Verifying installation..."
DIST_PATH="$PLUGIN_DIR/dist/index.js"
if [ ! -f "$DIST_PATH" ]; then
  echo "  ⚠️  dist/ files missing, clearing npm cache and retrying..."
  npm cache clean --force 2>/dev/null || true
  rm -rf "$PLUGIN_DIR"
  openclaw plugins install @blockrun/clawrouter

  if [ ! -f "$DIST_PATH" ]; then
    echo "  ❌ Installation failed - dist/index.js still missing"
    echo "  Please report this issue at https://github.com/BlockRunAI/ClawRouter/issues"
    exit 1
  fi
fi
echo "  ✓ dist/index.js verified"

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
    'anthropic/claude-sonnet-4.6', 'anthropic/claude-opus-4.6', 'anthropic/claude-haiku-4.5',
    'openai/gpt-5.4', 'openai/gpt-5.4-pro', 'openai/gpt-5.3', 'openai/gpt-5.3-codex',
    'openai/gpt-5-mini', 'openai/gpt-5-nano', 'openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/o3', 'openai/o4-mini',
    'google/gemini-3.1-pro', 'google/gemini-3-pro-preview', 'google/gemini-3-flash-preview',
    'google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite',
    'deepseek/deepseek-chat', 'deepseek/deepseek-reasoner', 'moonshot/kimi-k2.5',
    'xai/grok-3', 'xai/grok-4-0709', 'xai/grok-4-1-fast-reasoning',
    'minimax/minimax-m2.7', 'minimax/minimax-m2.5',
    'nvidia/gpt-oss-120b',
    'zai/glm-5', 'zai/glm-5-turbo'
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
echo "Run: openclaw gateway restart"
echo ""
echo "Model aliases available:"
echo "  /model sonnet    → claude-sonnet-4"
echo "  /model opus      → claude-opus-4"
echo "  /model codex     → openai/gpt-5.3-codex"
echo "  /model deepseek  → deepseek/deepseek-chat"
echo "  /model minimax   → minimax/minimax-m2.5"
echo "  /model free      → gpt-oss-120b (FREE)"
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
