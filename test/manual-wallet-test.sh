#!/bin/bash
# Manual test for wallet persistence bug fix
# Usage: bash test/manual-wallet-test.sh

set -e

WALLET_FILE="$HOME/.openclaw/blockrun/wallet.key"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  ClawRouter Wallet Persistence Test                       ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Clean slate
echo "→ Removing old wallet file..."
rm -f "$WALLET_FILE"

# Test 1: First start
echo ""
echo "═══ TEST 1: First Gateway Start ═══"
echo "→ Starting gateway..."
npx openclaw gateway start > /tmp/gateway-test-1.log 2>&1 &
PID1=$!
sleep 10

if [ ! -f "$WALLET_FILE" ]; then
  echo "✗ FAIL: Wallet file not created"
  kill $PID1 2>/dev/null
  exit 1
fi

WALLET1=$(cat "$WALLET_FILE")
echo "✓ Wallet created: ${WALLET1:0:30}..."

kill $PID1 2>/dev/null
wait $PID1 2>/dev/null || true
sleep 2

# Test 2: File still exists
echo ""
echo "═══ TEST 2: After Gateway Stop ═══"
if [ ! -f "$WALLET_FILE" ]; then
  echo "✗ FAIL: Wallet file deleted after stop"
  exit 1
fi

WALLET_AFTER_STOP=$(cat "$WALLET_FILE")
if [ "$WALLET1" != "$WALLET_AFTER_STOP" ]; then
  echo "✗ FAIL: Wallet changed after stop"
  exit 1
fi
echo "✓ Wallet persists after stop"

# Test 3: Second start (should reuse)
echo ""
echo "═══ TEST 3: Second Gateway Start ═══"
echo "→ Starting gateway again..."
npx openclaw gateway start > /tmp/gateway-test-2.log 2>&1 &
PID2=$!
sleep 10

if [ ! -f "$WALLET_FILE" ]; then
  echo "✗ FAIL: Wallet file missing on second start"
  kill $PID2 2>/dev/null
  exit 1
fi

WALLET2=$(cat "$WALLET_FILE")

if [ "$WALLET1" != "$WALLET2" ]; then
  echo "✗✗✗ BUG STILL EXISTS: Wallet regenerated!"
  echo "  First:  $WALLET1"
  echo "  Second: $WALLET2"
  kill $PID2 2>/dev/null
  exit 1
fi

echo "✓ Wallet reused (not regenerated)"

kill $PID2 2>/dev/null
wait $PID2 2>/dev/null || true

# Check logs for verification messages
echo ""
echo "═══ Verification Logs ═══"
echo "First start:"
grep -E "Loaded existing|Wallet saved|verified" /tmp/gateway-test-1.log | head -3 || echo "  (no verification logs)"

echo "Second start:"
grep -E "Loaded existing|Wallet saved|verified" /tmp/gateway-test-2.log | head -3 || echo "  (no verification logs)"

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  ✓✓✓ ALL TESTS PASSED - Wallet persistence fixed!        ║"
echo "╚════════════════════════════════════════════════════════════╝"
