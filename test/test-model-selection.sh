#!/bin/bash
set -e

echo "🧪 Testing ClawRouter Model Selection"
echo "======================================"
echo ""

# Test 1: Fresh install
echo "→ Test 1: Fresh install (no existing config)"
rm -rf ~/.openclaw
mkdir -p ~/.openclaw

echo "  Installing ClawRouter..."
echo "  (This may take up to 2 minutes...)"
timeout 120 openclaw plugins install @blockrun/clawrouter@latest || {
    echo "  ❌ FAIL: Plugin install timed out after 120s"
    echo "  This suggests the plugin is still blocking during installation"
    exit 1
}

echo "  ✓ Plugin installed"
echo ""

# Test 2: Check config was created
echo "→ Test 2: Verify config was created"
if [ ! -f ~/.openclaw/openclaw.json ]; then
    echo "  ❌ FAIL: openclaw.json was not created"
    exit 1
fi

echo "  ✓ Config file exists"
cat ~/.openclaw/openclaw.json | jq '.models.providers.blockrun | {baseUrl, api, apiKey, modelCount: (.models | length)}'
echo ""

# Test 3: Check models are available
echo "→ Test 3: List available models"
timeout 10 openclaw models || {
    echo "  ❌ FAIL: openclaw models command timed out"
    exit 1
}
echo ""

# Test 4: Try to set a non-BlockRun model (simulate Chandler's use case)
echo "→ Test 4: Switch to a non-BlockRun model"
# First, add a dummy OpenAI provider to config
node -e "
const fs = require('fs');
const path = require('path');
const configPath = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (!config.models) config.models = {};
if (!config.models.providers) config.models.providers = {};

// Add a dummy OpenAI provider
config.models.providers.openai = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'dummy-key',
  api: 'openai-completions',
  models: [
    {
      id: 'gpt-4',
      name: 'GPT-4',
      api: 'openai-completions',
      reasoning: false,
      input: ['text'],
      cost: { input: 30, output: 60 }
    }
  ]
};

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('  Added dummy OpenAI provider');
"

# Try to switch model - this should NOT hang
echo "  Attempting to switch to openai/gpt-4..."
node -e "
const fs = require('fs');
const path = require('path');
const configPath = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Manually set model (simulating user selection)
if (!config.agents) config.agents = {};
if (!config.agents.defaults) config.agents.defaults = {};
if (!config.agents.defaults.model) config.agents.defaults.model = {};
config.agents.defaults.model.primary = 'openai/gpt-4';

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('  ✓ Switched to openai/gpt-4');
"

# Verify the change persisted
MODEL=$(node -e "
const fs = require('fs');
const path = require('path');
const configPath = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
console.log(config.agents?.defaults?.model?.primary || 'NONE');
")

if [ "$MODEL" != "openai/gpt-4" ]; then
    echo "  ❌ FAIL: Model was not set to openai/gpt-4 (got: $MODEL)"
    exit 1
fi

echo "  ✓ Model selection persisted"
echo ""

# Test 5: Reload plugin and check if model selection is preserved
echo "→ Test 5: Reload plugin and verify model selection is preserved"
echo "  Reinstalling plugin to simulate reload..."
openclaw plugins install @blockrun/clawrouter@latest

MODEL_AFTER=$(node -e "
const fs = require('fs');
const path = require('path');
const configPath = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
console.log(config.agents?.defaults?.model?.primary || 'NONE');
")

if [ "$MODEL_AFTER" != "openai/gpt-4" ]; then
    echo "  ❌ FAIL: Model was changed back to $MODEL_AFTER (should still be openai/gpt-4)"
    echo "  This is the BUG Chandler reported!"
    exit 1
fi

echo "  ✓ Model selection preserved after reload"
echo ""

echo "✅ All tests passed!"
echo ""
echo "Summary:"
echo "  - Plugin installs without hanging"
echo "  - Config is created correctly  "
echo "  - Models are available"
echo "  - Can switch to non-BlockRun models"
echo "  - Model selection persists after reload"
