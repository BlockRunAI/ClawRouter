#!/usr/bin/env bash
set -euo pipefail

PLUGIN_PKG="@blockrun/clawrouter"
PLUGIN_ID="clawrouter"

DEFAULT_CLAWCREDIT_BASE_URL="https://api.claw.credit"
DEFAULT_CHAIN="BASE"
DEFAULT_ASSET_BASE_USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

usage() {
  cat <<'EOF'
ClawRouter claw.credit Setup

This script configures OpenClaw to pay BlockRun inference via claw.credit (SDK-backed).

What it does:
  - Installs/enables @blockrun/clawrouter (if needed)
  - Writes/updates OpenClaw's global env file (~/.openclaw/.env)
  - Restarts the OpenClaw gateway service

Usage:
  setup-clawcredit.sh [options]

Options:
  --token <token>        CLAWCREDIT_API_TOKEN (if omitted: tries to read from clawcredit.json; else prompts)
  --agent <agentId>      OpenClaw agent id to read clawcredit.json from (default: main)
  --chain <CHAIN>        Payment chain passed to claw.credit (default: BASE)
  --asset <ASSET>        Payment asset passed to claw.credit (default: Base USDC)
  --base-url <URL>       claw.credit API base URL (default: https://api.claw.credit)
  --profile <name>       OpenClaw profile name (uses ~/.openclaw-<name>)
  --no-restart           Do not restart the gateway
  --dry-run              Print actions without writing/exec'ing
  -h, --help             Show help

Examples:
  bash setup-clawcredit.sh
  bash setup-clawcredit.sh --token claw_xxx
  bash setup-clawcredit.sh --chain XRPL --asset USDC
EOF
}

log() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

is_tty() {
  [[ -t 0 && -t 1 ]]
}

resolve_state_dir() {
  local profile="${1:-}"
  local home="${HOME}"

  if [[ -n "${OPENCLAW_STATE_DIR:-}" ]]; then
    printf '%s' "${OPENCLAW_STATE_DIR}"
    return 0
  fi

  if [[ -n "$profile" ]]; then
    printf '%s' "${home}/.openclaw-${profile}"
    return 0
  fi

  if [[ -d "${home}/.openclaw" ]]; then
    printf '%s' "${home}/.openclaw"
    return 0
  fi

  if [[ -d "${home}/.moltbot" ]]; then
    printf '%s' "${home}/.moltbot"
    return 0
  fi

  # Default fallback (OpenClaw will create it on demand).
  printf '%s' "${home}/.openclaw"
}

OPENCLAW_PROFILE=""
AGENT_ID="main"
CLAWCREDIT_API_TOKEN="${CLAWCREDIT_API_TOKEN:-}"
CLAWCREDIT_PAYMENT_CHAIN="${CLAWCREDIT_PAYMENT_CHAIN:-}"
CLAWCREDIT_PAYMENT_ASSET="${CLAWCREDIT_PAYMENT_ASSET:-}"
CLAWCREDIT_BASE_URL="${CLAWCREDIT_BASE_URL:-}"
NO_RESTART="0"
DRY_RUN="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)
      [[ $# -ge 2 ]] || die "--token requires a value"
      CLAWCREDIT_API_TOKEN="$2"
      shift 2
      ;;
    --agent)
      [[ $# -ge 2 ]] || die "--agent requires a value"
      AGENT_ID="$2"
      shift 2
      ;;
    --chain)
      [[ $# -ge 2 ]] || die "--chain requires a value"
      CLAWCREDIT_PAYMENT_CHAIN="$2"
      shift 2
      ;;
    --asset)
      [[ $# -ge 2 ]] || die "--asset requires a value"
      CLAWCREDIT_PAYMENT_ASSET="$2"
      shift 2
      ;;
    --base-url)
      [[ $# -ge 2 ]] || die "--base-url requires a value"
      CLAWCREDIT_BASE_URL="$2"
      shift 2
      ;;
    --profile)
      [[ $# -ge 2 ]] || die "--profile requires a value"
      OPENCLAW_PROFILE="$2"
      shift 2
      ;;
    --no-restart)
      NO_RESTART="1"
      shift
      ;;
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1 (use --help)"
      ;;
  esac
done

need_cmd openclaw
need_cmd node

STATE_DIR="$(resolve_state_dir "$OPENCLAW_PROFILE")"
ENV_FILE="${STATE_DIR}/.env"
EXT_DIR="${STATE_DIR}/extensions/${PLUGIN_ID}"
CLAWCREDIT_JSON="${STATE_DIR}/agents/${AGENT_ID}/agent/clawcredit.json"

if [[ -z "$CLAWCREDIT_BASE_URL" ]]; then
  CLAWCREDIT_BASE_URL="$DEFAULT_CLAWCREDIT_BASE_URL"
fi

if [[ -z "$CLAWCREDIT_PAYMENT_CHAIN" ]]; then
  CLAWCREDIT_PAYMENT_CHAIN="$DEFAULT_CHAIN"
fi

CLAWCREDIT_PAYMENT_CHAIN="$(printf '%s' "$CLAWCREDIT_PAYMENT_CHAIN" | tr '[:lower:]' '[:upper:]')"

if [[ -z "$CLAWCREDIT_PAYMENT_ASSET" ]]; then
  if [[ "$CLAWCREDIT_PAYMENT_CHAIN" == "BASE" ]]; then
    CLAWCREDIT_PAYMENT_ASSET="$DEFAULT_ASSET_BASE_USDC"
  fi
fi

if [[ -z "${CLAWCREDIT_API_TOKEN}" && -f "${CLAWCREDIT_JSON}" ]]; then
  token_from_json="$(node -e "
    const fs = require('fs');
    const p = process.argv[1];
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const j = JSON.parse(raw);
      const t = typeof j.apiToken === 'string' ? j.apiToken.trim() : '';
      if (t) process.stdout.write(t);
    } catch {}
  " "${CLAWCREDIT_JSON}")"
  if [[ -n "${token_from_json}" ]]; then
    CLAWCREDIT_API_TOKEN="${token_from_json}"
    log "→ Found claw.credit token in ${CLAWCREDIT_JSON}"
  fi
fi

if [[ -z "${CLAWCREDIT_API_TOKEN}" ]]; then
  if ! is_tty; then
    die "CLAWCREDIT_API_TOKEN not set and no token found at ${CLAWCREDIT_JSON}. Re-run with --token."
  fi
  printf "Enter CLAWCREDIT_API_TOKEN: " >&2
  read -r -s CLAWCREDIT_API_TOKEN
  printf "\n" >&2
  if [[ -z "${CLAWCREDIT_API_TOKEN}" ]]; then
    die "Empty token"
  fi
fi

if [[ -z "${CLAWCREDIT_PAYMENT_ASSET}" ]]; then
  if ! is_tty; then
    die "CLAWCREDIT_PAYMENT_ASSET is required for chain=${CLAWCREDIT_PAYMENT_CHAIN}. Re-run with --asset."
  fi
  printf "Enter CLAWCREDIT_PAYMENT_ASSET for chain=%s: " "${CLAWCREDIT_PAYMENT_CHAIN}" >&2
  read -r CLAWCREDIT_PAYMENT_ASSET
  if [[ -z "${CLAWCREDIT_PAYMENT_ASSET}" ]]; then
    die "Empty asset"
  fi
fi

log ""
log "ClawRouter claw.credit configuration"
log "  OpenClaw state dir: ${STATE_DIR}"
log "  Profile: ${OPENCLAW_PROFILE:-default}"
log "  Agent: ${AGENT_ID}"
log "  claw.credit baseUrl: ${CLAWCREDIT_BASE_URL}"
log "  chain: ${CLAWCREDIT_PAYMENT_CHAIN}"
log "  asset: ${CLAWCREDIT_PAYMENT_ASSET}"
log "  env file: ${ENV_FILE}"
log ""

if [[ "${DRY_RUN}" == "1" ]]; then
  log "[dry-run] Would ensure plugin installed at: ${EXT_DIR}"
  log "[dry-run] Would run: openclaw${OPENCLAW_PROFILE:+ --profile ${OPENCLAW_PROFILE}} plugins install ${PLUGIN_PKG}"
  log "[dry-run] Would run: openclaw${OPENCLAW_PROFILE:+ --profile ${OPENCLAW_PROFILE}} plugins enable ${PLUGIN_ID}"
  log "[dry-run] Would write env vars to: ${ENV_FILE}"
  if [[ "${NO_RESTART}" != "1" ]]; then
    log "[dry-run] Would run: openclaw${OPENCLAW_PROFILE:+ --profile ${OPENCLAW_PROFILE}} gateway restart"
  fi
  exit 0
fi

log "→ Installing/enabling ${PLUGIN_PKG}..."
if [[ ! -d "${EXT_DIR}" ]]; then
  openclaw ${OPENCLAW_PROFILE:+ --profile "${OPENCLAW_PROFILE}"} plugins install "${PLUGIN_PKG}"
else
  log "  Plugin already installed: ${EXT_DIR}"
fi

openclaw ${OPENCLAW_PROFILE:+ --profile "${OPENCLAW_PROFILE}"} plugins enable "${PLUGIN_ID}"

log "→ Writing ${ENV_FILE}..."
mkdir -p "${STATE_DIR}"

BLOCKRUN_PAYMENT_MODE="clawcredit" \
CLAWCREDIT_API_TOKEN="${CLAWCREDIT_API_TOKEN}" \
CLAWCREDIT_BASE_URL="${CLAWCREDIT_BASE_URL}" \
CLAWCREDIT_PAYMENT_CHAIN="${CLAWCREDIT_PAYMENT_CHAIN}" \
CLAWCREDIT_PAYMENT_ASSET="${CLAWCREDIT_PAYMENT_ASSET}" \
node -e "
  const fs = require('fs');
  const path = require('path');

  const envPath = process.argv[1];
  const pairs = {
    BLOCKRUN_PAYMENT_MODE: process.env.BLOCKRUN_PAYMENT_MODE,
    CLAWCREDIT_API_TOKEN: process.env.CLAWCREDIT_API_TOKEN,
    CLAWCREDIT_BASE_URL: process.env.CLAWCREDIT_BASE_URL,
    CLAWCREDIT_PAYMENT_CHAIN: process.env.CLAWCREDIT_PAYMENT_CHAIN,
    CLAWCREDIT_PAYMENT_ASSET: process.env.CLAWCREDIT_PAYMENT_ASSET,
  };

  let lines = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  }

  const setLine = (key, value) => {
    const encoded = JSON.stringify(String(value));
    const next = key + '=' + encoded;
    // Keys here are fixed env var names, so no regex escaping is needed.
    const re = new RegExp('^' + key + '='); // key=
    const idx = lines.findIndex((l) => re.test(l));
    if (idx >= 0) {
      lines[idx] = next;
    } else {
      lines.push(next);
    }
  };

  for (const [k, v] of Object.entries(pairs)) {
    if (v == null || String(v).trim() === '') continue;
    setLine(k, v);
  }

  // Trim trailing empty lines, then ensure file ends with newline.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const out = lines.join('\\n') + '\\n';

  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, out, 'utf8');
  try { fs.chmodSync(envPath, 0o600); } catch {}
" "${ENV_FILE}"

if [[ "${NO_RESTART}" != "1" ]]; then
  log "→ Restarting OpenClaw gateway..."
  if ! openclaw ${OPENCLAW_PROFILE:+ --profile "${OPENCLAW_PROFILE}"} gateway restart; then
    warn "Gateway restart failed. Try:"
    warn "  openclaw${OPENCLAW_PROFILE:+ --profile ${OPENCLAW_PROFILE}} gateway install"
    warn "  openclaw${OPENCLAW_PROFILE:+ --profile ${OPENCLAW_PROFILE}} gateway start"
  fi
else
  log "→ Skipping gateway restart (--no-restart)"
fi

log ""
log "✓ claw.credit mode enabled for BlockRun inference"
log ""
log "Quick checks:"
log "  openclaw${OPENCLAW_PROFILE:+ --profile ${OPENCLAW_PROFILE}} gateway status"
log "  curl -s \"http://127.0.0.1:8402/health?full=true\" | cat"
