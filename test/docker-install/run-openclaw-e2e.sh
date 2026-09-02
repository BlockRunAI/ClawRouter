#!/bin/bash
set +e
OVERALL_FAIL=0
pass() { echo "✅ $1"; }
fail() { echo "❌ $1"; OVERALL_FAIL=1; }

echo "=== Step 1: Environment ==="
echo "OpenClaw: $(openclaw --version)"
echo ""

OPENCLAW_CAPABILITY_ARGS=()
if openclaw plugins install --help 2>&1 | grep -q -- '--accept-capabilities'; then
  OPENCLAW_CAPABILITY_ARGS=(--accept-capabilities)
fi

mkdir -p $HOME/.openclaw
echo '{}' > $HOME/.openclaw/openclaw.json

echo "=== Step 2: Fresh install on clean OpenClaw 2026.5.4 ==="
INSTALL_A=$(mktemp)
openclaw plugins install --force "${OPENCLAW_CAPABILITY_ARGS[@]}" /tmp/clawrouter.tgz 2>&1 | tee $INSTALL_A | tail -8
echo ""

echo "=== Step 3: Install-time assertions ==="
grep -q "unknown web_search provider" $INSTALL_A && fail "validator collision" || pass "No 'unknown web_search provider'"
grep -q "Config write rejected" $INSTALL_A && fail "size-drop rejection" || pass "No 'Config write rejected'"
grep -q "Installed plugin: blockrun-clawrouter" $INSTALL_A && pass "Plugin install committed" || fail "Plugin install did NOT commit"
grep -q "blockrun_predexon_endpoint_call" $INSTALL_A && pass "NEW TOOL blockrun_predexon_endpoint_call registered" || fail "NEW TOOL missing"
echo ""

echo "=== Step 4: clawrouter setup (writes models config + web_search enabled) ==="
BLOCKRUN_CLAWROUTER_INSTALL_SPEC=/tmp/clawrouter.tgz node /root/.openclaw/extensions/blockrun-clawrouter/dist/cli.js setup 2>&1 | tail -12
echo ""
BLOCKRUN_MODELS=$(jq -r '.models.providers.blockrun.models | length' $HOME/.openclaw/openclaw.json 2>/dev/null || echo 0)
ALLOWLIST=$(jq -r '.agents.defaults.models | to_entries | map(select(.key | startswith("blockrun/"))) | length' $HOME/.openclaw/openclaw.json 2>/dev/null || echo 0)
PROVIDER=$(jq -r '.tools.web.search.provider // "absent"' $HOME/.openclaw/openclaw.json)
ENABLED=$(jq -r '.tools.web.search.enabled // "absent"' $HOME/.openclaw/openclaw.json)

[ "$PROVIDER" = "absent" ] && pass "tools.web.search.provider absent (validator-safe)" || fail "Provider unexpectedly = $PROVIDER"
[ "$ENABLED" = "true" ] && pass "tools.web.search.enabled = true" || fail "tools.web.search.enabled = $ENABLED (expected true)"
[ "$BLOCKRUN_MODELS" -ge 30 ] 2>/dev/null && pass "blockrun models ≥ 30 ($BLOCKRUN_MODELS)" || fail "blockrun models = $BLOCKRUN_MODELS"
[ "$ALLOWLIST" -ge 30 ] 2>/dev/null && pass "allowlist blockrun ≥ 30 ($ALLOWLIST)" || fail "allowlist = $ALLOWLIST"
openclaw config validate 2>&1 | grep -q "Config valid" && pass "config validate clean" || fail "config validate failed"
echo ""

echo "=== Step 5: v0.12.185 upgrade scenario (legacy provider on disk) ==="
TMPF=$(mktemp)
jq '.tools.web.search.provider = "blockrun-exa"' $HOME/.openclaw/openclaw.json > $TMPF && mv $TMPF $HOME/.openclaw/openclaw.json
echo "Injected legacy. provider=$(jq -r '.tools.web.search.provider' $HOME/.openclaw/openclaw.json)"

echo ""
echo "=== Step 5b: Install WITHOUT migration → expected to fail with validator collision ==="
INSTALL_NOMIG=$(mktemp)
openclaw plugins install --force "${OPENCLAW_CAPABILITY_ARGS[@]}" /tmp/clawrouter.tgz 2>&1 | tee $INSTALL_NOMIG | tail -8
grep -q "unknown web_search provider" $INSTALL_NOMIG && pass "Validator failure reproduced (root cause)" || fail "Did NOT reproduce validator failure"
echo ""

echo "=== Step 6: Apply migration (matches scripts/update.sh) ==="
node -e "
const fs = require('fs');
const path = require('os').homedir() + '/.openclaw/openclaw.json';
const config = JSON.parse(fs.readFileSync(path, 'utf8'));
if (config?.tools?.web?.search?.provider === 'blockrun-exa') {
  delete config.tools.web.search.provider;
  fs.writeFileSync(path, JSON.stringify(config, null, 2));
  console.log('Removed legacy provider');
}
"
echo "Post-migration provider: $(jq -r '.tools.web.search.provider // "absent"' $HOME/.openclaw/openclaw.json)"

echo ""
echo "=== Step 7: Re-install AFTER migration → should succeed ==="
INSTALL_B=$(mktemp)
openclaw plugins install --force "${OPENCLAW_CAPABILITY_ARGS[@]}" /tmp/clawrouter.tgz 2>&1 | tee $INSTALL_B | tail -25
echo ""

if grep -q "unknown web_search provider" $INSTALL_B; then
  fail "Re-install hit validator collision (migration ineffective)"
elif grep -q "Config write rejected" $INSTALL_B; then
  fail "Re-install hit size-drop"
elif grep -q "Installed plugin: blockrun-clawrouter" $INSTALL_B; then
  pass "Re-install after migration succeeded"
else
  fail "Re-install: unknown failure"
fi

echo ""
echo "============================="
[ $OVERALL_FAIL -eq 0 ] && echo "🎉 ALL E2E ASSERTIONS PASSED" || echo "💥 SOME E2E ASSERTIONS FAILED"
exit $OVERALL_FAIL
