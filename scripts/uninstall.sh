#!/bin/bash
set -e

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

echo "🦞 ClawRouter Uninstall"
echo ""

# 1. Stop proxy
echo "→ Stopping proxy..."
kill_port_processes "${BLOCKRUN_PROXY_PORT:-8402}"

# 2. Remove plugin files
echo "→ Removing plugin files..."
if command -v openclaw >/dev/null 2>&1; then
  openclaw plugins uninstall --force blockrun-clawrouter >/dev/null 2>&1 || true
fi
rm -rf ~/.openclaw/extensions/blockrun-clawrouter

# Remove the pre-rename directory only when package metadata proves that it is
# BlockRun's package. Never remove an unrelated official `clawrouter` plugin.
LEGACY_PLUGIN_DIR="$HOME/.openclaw/extensions/clawrouter"
LEGACY_BLOCKRUN_INSTALL=0
if [ -f "$LEGACY_PLUGIN_DIR/package.json" ] && node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.exit(pkg.name === "@blockrun/clawrouter" ? 0 : 1);
' "$LEGACY_PLUGIN_DIR/package.json"; then
  LEGACY_BLOCKRUN_INSTALL=1
  rm -rf "$LEGACY_PLUGIN_DIR"
fi

# 3. Clean openclaw.json
echo "→ Cleaning openclaw.json..."
LEGACY_BLOCKRUN_INSTALL="$LEGACY_BLOCKRUN_INSTALL" node -e "
const os = require('os');
const fs = require('fs');
const path = require('path');
const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');

if (!fs.existsSync(configPath)) {
  console.log('  No openclaw.json found, skipping');
  process.exit(0);
}

try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let changed = false;

  // Remove blockrun provider
  if (config.models?.providers?.blockrun) {
    delete config.models.providers.blockrun;
    console.log('  Removed blockrun provider');
    changed = true;
  }

  // Never remove lowercase clawrouter: OpenClaw's bundled router owns it.
  for (const key of ['blockrun-clawrouter', 'ClawRouter', '@blockrun/clawrouter']) {
    if (config.plugins?.entries?.[key]) {
      delete config.plugins.entries[key];
      console.log('  Removed plugins.entries.' + key);
      changed = true;
    }
    if (config.plugins?.installs?.[key]) {
      delete config.plugins.installs[key];
      console.log('  Removed plugins.installs.' + key);
      changed = true;
    }
  }

  // If the directory proved the old id was our pre-rename package, remove
  // only BlockRun-owned fields from the now-official entry. Preserve its
  // enabled state and all unrelated official settings.
  if (process.env.LEGACY_BLOCKRUN_INSTALL === '1' && config.plugins?.entries?.clawrouter) {
    const legacy = config.plugins.entries.clawrouter;
    for (const key of ['walletKey', 'routing']) {
      if (Object.prototype.hasOwnProperty.call(legacy, key)) {
        delete legacy[key];
        changed = true;
      }
      if (legacy.config && Object.prototype.hasOwnProperty.call(legacy.config, key)) {
        delete legacy.config[key];
        changed = true;
      }
    }
    if (legacy.config && Object.keys(legacy.config).length === 0) delete legacy.config;
  }

  // Remove from plugins.allow
  if (Array.isArray(config.plugins?.allow)) {
    const before = config.plugins.allow.length;
    config.plugins.allow = config.plugins.allow.filter(
      p => p !== 'blockrun-clawrouter' && p !== 'ClawRouter' && p !== '@blockrun/clawrouter'
    );
    if (config.plugins.allow.length !== before) {
      console.log('  Removed from plugins.allow');
      changed = true;
    }
  }

  // Remove BlockRun ids from plugins.deny while preserving official clawrouter.
  if (Array.isArray(config.plugins?.deny)) {
    const before = config.plugins.deny.length;
    config.plugins.deny = config.plugins.deny.filter(
      p => p !== 'blockrun-clawrouter' && p !== 'ClawRouter' && p !== '@blockrun/clawrouter'
    );
    if (config.plugins.deny.length !== before) changed = true;
  }

  // Reset default model if it's blockrun/auto
  if (config.agents?.defaults?.model?.primary === 'blockrun/auto') {
    delete config.agents.defaults.model.primary;
    console.log('  Reset default model (was blockrun/auto)');
    changed = true;
  }

  // Remove blockrun models from allowlist
  if (config.agents?.defaults?.models) {
    const models = config.agents.defaults.models;
    let removedCount = 0;
    for (const key of Object.keys(models)) {
      if (key.startsWith('blockrun/')) {
        delete models[key];
        removedCount++;
      }
    }
    if (removedCount > 0) {
      console.log('  Removed ' + removedCount + ' blockrun models from allowlist');
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('  Config cleaned');
  } else {
    console.log('  No changes needed');
  }
} catch (err) {
  console.error('  Error:', err.message);
}
"

# 4. Clean auth-profiles.json
echo "→ Cleaning auth profiles..."
node -e "
const os = require('os');
const fs = require('fs');
const path = require('path');
const agentsDir = path.join(os.homedir(), '.openclaw', 'agents');

if (!fs.existsSync(agentsDir)) {
  console.log('  No agents directory found');
  process.exit(0);
}

const agents = fs.readdirSync(agentsDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

for (const agentId of agents) {
  const authPath = path.join(agentsDir, agentId, 'agent', 'auth-profiles.json');
  if (!fs.existsSync(authPath)) continue;

  try {
    const store = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    if (store.profiles?.['blockrun:default']) {
      delete store.profiles['blockrun:default'];
      fs.writeFileSync(authPath, JSON.stringify(store, null, 2));
      console.log('  Removed blockrun auth from ' + agentId);
    }
  } catch {}
}
"

# 5. Clean models cache
echo "→ Cleaning models cache..."
rm -f ~/.openclaw/agents/*/agent/models.json 2>/dev/null || true

echo ""
echo "✓ ClawRouter uninstalled"
echo ""
echo "Restart OpenClaw to apply changes:"
echo "  openclaw gateway restart"
