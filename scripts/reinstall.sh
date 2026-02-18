#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🦞 ClawRouter Reinstall"
echo ""

# 1. Remove plugin files
echo "→ Removing plugin files..."
rm -rf ~/.openclaw/extensions/clawrouter

# 2. Clean config entries
echo "→ Cleaning config entries..."
node -e "
const f = require('os').homedir() + '/.openclaw/openclaw.json';
const fs = require('fs');
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
const deprecated = ['blockrun/mini', 'blockrun/nvidia', 'blockrun/gpt', 'blockrun/o3', 'blockrun/grok'];
if (c.agents?.defaults?.models) {
  for (const key of deprecated) {
    if (c.agents.defaults.models[key]) {
      delete c.agents.defaults.models[key];
      console.log('  Removed deprecated alias: ' + key);
    }
  }
}
fs.writeFileSync(f, JSON.stringify(c, null, 2));
console.log('  Config cleaned');
"

# 3. Kill old proxy
echo "→ Stopping old proxy..."
lsof -ti :8402 | xargs kill -9 2>/dev/null || true

# 3.1. Remove stale models.json so it gets regenerated with apiKey
echo "→ Cleaning models cache..."
rm -f ~/.openclaw/agents/main/agent/models.json 2>/dev/null || true

# 4. Inject auth profile (ensures blockrun provider is recognized)
echo "→ Injecting auth profile..."
node -e "
const os = require('os');
const fs = require('fs');
const path = require('path');
const authDir = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'agent');
const authPath = path.join(authDir, 'auth-profiles.json');

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
  fs.writeFileSync(authPath, JSON.stringify(store, null, 2));
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
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
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
DIST_PATH="$HOME/.openclaw/extensions/clawrouter/dist/index.js"
if [ ! -f "$DIST_PATH" ]; then
  echo "  ⚠️  dist/ files missing, clearing npm cache and retrying..."
  npm cache clean --force 2>/dev/null || true
  rm -rf ~/.openclaw/extensions/clawrouter
  openclaw plugins install @blockrun/clawrouter

  if [ ! -f "$DIST_PATH" ]; then
    echo "  ❌ Installation failed - dist/index.js still missing"
    echo "  Please report this issue at https://github.com/BlockRunAI/ClawRouter/issues"
    exit 1
  fi
fi
echo "  ✓ dist/index.js verified"

# 6.2. Refresh blockrun model catalog from installed package
echo "→ Refreshing BlockRun models catalog..."
node -e "
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

  // Ensure provider exists
  if (!config.models) config.models = {};
  if (!config.models.providers) config.models.providers = {};
  if (!config.models.providers.blockrun) {
    config.models.providers.blockrun = { api: 'openai-completions', models: [] };
    changed = true;
  }

  const blockrun = config.models.providers.blockrun;
  if (!blockrun.apiKey) {
    blockrun.apiKey = 'x402-proxy-handles-auth';
    changed = true;
  }
  if (!Array.isArray(blockrun.models)) {
    blockrun.models = [];
    changed = true;
  }

  // Ensure minimax model exists in provider catalog
  const hasMiniMaxModel = blockrun.models.some(m => m && m.id === 'minimax/minimax-m2.5');
  if (!hasMiniMaxModel) {
    blockrun.models.push({
      id: 'minimax/minimax-m2.5',
      name: 'MiniMax M2.5',
      api: 'openai-completions',
      reasoning: true,
      input: ['text'],
      cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 204800,
      maxTokens: 16384
    });
    changed = true;
    console.log('  Added minimax model to blockrun provider catalog');
  }

  // Ensure minimax alias is present in model picker allowlist
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.models || typeof config.agents.defaults.models !== 'object') {
    config.agents.defaults.models = {};
    changed = true;
  }
  const allowlist = config.agents.defaults.models;
  if (!allowlist['blockrun/minimax'] || allowlist['blockrun/minimax'].alias !== 'minimax') {
    allowlist['blockrun/minimax'] = { alias: 'minimax' };
    changed = true;
    console.log('  Added minimax to model picker allowlist');
  }

  if (changed) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } else {
    console.log('  blockrun minimax config already up to date');
  }
} catch (err) {
  console.log('  Could not update minimax config:', err.message);
}
"

# 7. Add plugin to allow list (done AFTER install so plugin files exist for validation)
echo "→ Adding to plugins allow list..."
node -e "
const os = require('os');
const fs = require('fs');
const path = require('path');
const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');

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

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.log('  Could not update config:', e.message);
  }
} else {
  console.log('  No openclaw.json found, skipping');
}
"

echo ""
echo "✓ Done! Smart routing enabled by default."
echo ""
echo "Run: openclaw gateway restart"
echo ""
echo "Model aliases available:"
echo "  /model sonnet4.6 → anthropic/claude-sonnet-4.6"
echo "  /model opus4.6   → anthropic/claude-opus-4.6"
echo "  /model codex     → openai/gpt-5.2-codex"
echo "  /model deepseek  → deepseek/deepseek-chat"
echo "  /model minimax   → minimax/minimax-m2.5"
echo "  /model free      → gpt-oss-120b (FREE)"
echo ""
echo "To uninstall: bash ~/.openclaw/extensions/clawrouter/scripts/uninstall.sh"
