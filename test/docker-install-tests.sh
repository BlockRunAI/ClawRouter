#!/bin/bash

# ClawRouter Docker Installation Tests
# Tests installation, upgrade, and uninstall workflows

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0
SKIPPED=0

log_test() {
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}TEST $1: $2${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

log_pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    ((PASSED++))
}

log_fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    ((FAILED++))
}

log_skip() {
    echo -e "${YELLOW}⊘ SKIP${NC}: $1"
    ((SKIPPED++))
}

log_info() {
    echo -e "  $1"
}

# Test 1: Fresh npm global installation
test_fresh_install() {
    log_test "1" "Fresh npm global installation"

    npm install -g @blockrun/clawrouter

    if command -v clawrouter &> /dev/null; then
        log_pass "ClawRouter installed successfully"
    else
        log_fail "ClawRouter command not found after installation"
        return 1
    fi

    VERSION=$(clawrouter --version 2>/dev/null || echo "")
    if [ -n "$VERSION" ]; then
        log_pass "Version command works: $VERSION"
    else
        log_fail "Version command failed"
        return 1
    fi
}

# Test 2: Uninstall verification
test_uninstall() {
    log_test "2" "Uninstall verification"

    npm uninstall -g @blockrun/clawrouter

    if ! command -v clawrouter &> /dev/null; then
        log_pass "ClawRouter uninstalled successfully"
    else
        log_fail "ClawRouter command still available after uninstall"
        return 1
    fi
}

# Test 3: Reinstall after uninstall
test_reinstall() {
    log_test "3" "Reinstall after uninstall"

    npm install -g @blockrun/clawrouter

    if command -v clawrouter &> /dev/null; then
        log_pass "ClawRouter reinstalled successfully"
    else
        log_fail "ClawRouter command not found after reinstall"
        return 1
    fi
}

# Test 4: OpenClaw plugin installation
test_openclaw_install() {
    log_test "4" "OpenClaw plugin installation"

    # Check if openclaw.plugin.json exists in the package
    PLUGIN_FILE="$HOME/.npm-global/lib/node_modules/@blockrun/clawrouter/openclaw.plugin.json"

    if [ -f "$PLUGIN_FILE" ]; then
        log_pass "OpenClaw plugin file exists"

        # Validate JSON structure
        if jq empty "$PLUGIN_FILE" 2>/dev/null; then
            log_pass "OpenClaw plugin JSON is valid"
        else
            log_fail "OpenClaw plugin JSON is invalid"
            return 1
        fi
    else
        log_skip "OpenClaw plugin not available in this version"
    fi
}

# Test 5: OpenClaw plugin uninstall verification
test_openclaw_uninstall() {
    log_test "5" "OpenClaw plugin uninstall verification"

    PLUGIN_FILE="$HOME/.npm-global/lib/node_modules/@blockrun/clawrouter/openclaw.plugin.json"

    if [ -f "$PLUGIN_FILE" ]; then
        npm uninstall -g @blockrun/clawrouter

        if [ ! -f "$PLUGIN_FILE" ]; then
            log_pass "OpenClaw plugin removed with package"
        else
            log_fail "OpenClaw plugin still exists after uninstall"
            return 1
        fi

        # Reinstall for next tests
        npm install -g @blockrun/clawrouter
    else
        log_skip "OpenClaw plugin not available to test uninstall"
    fi
}

# Test 6: Upgrade from version 0.8.25
test_upgrade() {
    log_test "6" "Upgrade from version 0.8.25"

    # Uninstall current version
    npm uninstall -g @blockrun/clawrouter 2>/dev/null || true

    # Install old version
    npm install -g @blockrun/clawrouter@0.8.25

    OLD_VERSION=$(clawrouter --version 2>/dev/null || echo "")
    log_info "Installed version: $OLD_VERSION"

    # Upgrade to latest
    npm install -g @blockrun/clawrouter

    NEW_VERSION=$(clawrouter --version 2>/dev/null || echo "")
    log_info "Upgraded version: $NEW_VERSION"

    if [ "$NEW_VERSION" != "$OLD_VERSION" ]; then
        log_pass "Successfully upgraded from 0.8.25"
    else
        log_fail "Upgrade did not change version"
        return 1
    fi
}

# Test 7: Installation with custom wallet key
test_custom_wallet() {
    log_test "7" "Installation with custom wallet key"

    # Uninstall
    npm uninstall -g @blockrun/clawrouter 2>/dev/null || true

    # Install and set custom key
    npm install -g @blockrun/clawrouter

    CUSTOM_KEY="0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
    export CLAWROUTER_WALLET_PRIVATE_KEY="$CUSTOM_KEY"

    # Verify installation with custom key works
    if command -v clawrouter &> /dev/null; then
        log_pass "ClawRouter installed with custom wallet key"
    else
        log_fail "Installation failed with custom wallet key"
        return 1
    fi

    unset CLAWROUTER_WALLET_PRIVATE_KEY
}

# Test 8: Package files verification
test_package_files() {
    log_test "8" "Package files verification"

    PKG_DIR="$HOME/.npm-global/lib/node_modules/@blockrun/clawrouter"

    REQUIRED_FILES=(
        "dist/index.js"
        "dist/cli.js"
        "package.json"
    )

    ALL_FOUND=true
    for FILE in "${REQUIRED_FILES[@]}"; do
        if [ -f "$PKG_DIR/$FILE" ]; then
            log_pass "Found: $FILE"
        else
            log_fail "Missing: $FILE"
            ALL_FOUND=false
        fi
    done

    if [ "$ALL_FOUND" = false ]; then
        return 1
    fi
}

# Test 9: Version command accuracy
test_version_accuracy() {
    log_test "9" "Version command accuracy"

    PKG_DIR="$HOME/.npm-global/lib/node_modules/@blockrun/clawrouter"

    CLI_VERSION=$(clawrouter --version 2>/dev/null || echo "")
    PKG_VERSION=$(jq -r '.version' "$PKG_DIR/package.json" 2>/dev/null || echo "")

    log_info "CLI version: $CLI_VERSION"
    log_info "Package.json version: $PKG_VERSION"

    if [ "$CLI_VERSION" = "$PKG_VERSION" ]; then
        log_pass "Version command matches package.json"
    else
        log_fail "Version mismatch (CLI: $CLI_VERSION, package.json: $PKG_VERSION)"
        return 1
    fi
}

# Test 10: Full cleanup verification
test_full_cleanup() {
    log_test "10" "Full cleanup verification"

    npm uninstall -g @blockrun/clawrouter

    PKG_DIR="$HOME/.npm-global/lib/node_modules/@blockrun/clawrouter"

    if [ ! -d "$PKG_DIR" ]; then
        log_pass "Package directory removed"
    else
        log_fail "Package directory still exists: $PKG_DIR"
        return 1
    fi

    if ! command -v clawrouter &> /dev/null; then
        log_pass "ClawRouter command removed from PATH"
    else
        log_fail "ClawRouter command still in PATH"
        return 1
    fi
}

# Run all tests
main() {
    echo ""
    echo "╔═══════════════════════════════════════════════════════╗"
    echo "║     ClawRouter Docker Installation Test Suite        ║"
    echo "╚═══════════════════════════════════════════════════════╝"
    echo ""

    test_fresh_install || true
    test_uninstall || true
    test_reinstall || true
    test_openclaw_install || true
    test_openclaw_uninstall || true
    test_upgrade || true
    test_custom_wallet || true
    test_package_files || true
    test_version_accuracy || true
    test_full_cleanup || true

    echo ""
    echo "╔═══════════════════════════════════════════════════════╗"
    echo "║                   Test Summary                        ║"
    echo "╚═══════════════════════════════════════════════════════╝"
    echo -e "${GREEN}Passed: $PASSED${NC}"
    echo -e "${RED}Failed: $FAILED${NC}"
    echo -e "${YELLOW}Skipped: $SKIPPED${NC}"
    echo ""

    if [ $FAILED -eq 0 ]; then
        echo -e "${GREEN}✓ All tests passed!${NC}"
        exit 0
    else
        echo -e "${RED}✗ Some tests failed${NC}"
        exit 1
    fi
}

main
