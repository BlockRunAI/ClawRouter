#!/bin/bash
set -e

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
if (fs.existsSync(f)) {
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  // Clean plugin entries
  if (c.plugins?.entries?.clawrouter) delete c.plugins.entries.clawrouter;
  if (c.plugins?.installs?.clawrouter) delete c.plugins.installs.clawrouter;
  // Clean plugins.allow (removes stale clawrouter reference)
  if (Array.isArray(c.plugins?.allow)) {
    c.plugins.allow = c.plugins.allow.filter(p => p !== 'clawrouter' && p !== '@blockrun/clawrouter');
  }
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
}
"

# 3. Kill old proxy
echo "→ Stopping old proxy..."
lsof -ti :8402 | xargs kill -9 2>/dev/null || true

# 4. Reinstall
echo "→ Installing ClawRouter..."
openclaw plugins install @blockrun/clawrouter

# 5. Inject auth profile (ensures blockrun provider is recognized)
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
  } catch {}
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

# 6. Enable smart routing by default
echo "→ Enabling smart routing..."
node -e "
const os = require('os');
const fs = require('fs');
const path = require('path');
const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');

if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    // Ensure agents.defaults.model.primary exists
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    if (!config.agents.defaults.model) config.agents.defaults.model = {};

    // Set smart routing as default
    config.agents.defaults.model.primary = 'blockrun/auto';

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('  Smart routing enabled: blockrun/auto');
  } catch (e) {
    console.log('  Could not update config:', e.message);
  }
} else {
  console.log('  No openclaw.json found, skipping');
}
"

echo ""
echo "✓ Done! Run: openclaw gateway restart"
