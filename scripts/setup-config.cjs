#!/usr/bin/env node
/**
 * Consolidated OpenClaw config setup for ClawRouter.
 *
 * Replaces 6-8 separate inline `node -e` snippets in reinstall.sh / update.sh
 * with a single read-modify-write pass over openclaw.json + auth-profiles.json.
 *
 * Usage:
 *   node scripts/setup-config.cjs [options]
 *
 * Options:
 *   --clean-entries       Remove stale ClawRouter plugin entries before install
 *   --clean-lobster       Remove Crossmint/lobster plugin entries
 *   --verify-provider     Ensure blockrun provider has baseUrl + apiKey
 *   --populate-allowlist  Add/refresh top models in agents.defaults.models
 *   --add-to-allow        Add clawrouter to plugins.allow list
 *   --set-gateway-mode    Ensure gateway.mode is set (default: "local")
 *   --inject-auth         Inject blockrun auth profile into agent stores
 *   --all                 Run all of the above (default if no options given)
 *   --backup-channels FILE  Save channels/gateway config to FILE before changes
 *   --restore-channels FILE Restore channels/gateway config from FILE after changes
 */

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");

// ── Helpers ──────────────────────────────────────────────────────

function atomicWrite(filePath, data) {
  const tmpPath = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (!content) return null;
  return JSON.parse(content);
}

function log(msg) {
  console.log("  " + msg);
}

// ── Constants ────────────────────────────────────────────────────

// All case variants for plugin entries (OpenClaw may use id or name as key)
const CLAWROUTER_KEYS = ["clawrouter", "ClawRouter", "@blockrun/clawrouter"];

// Lobster/Crossmint keys to remove
const LOBSTER_KEYS = ["lobster.cash", "lobster", "crossmint"];

// Bundled OpenClaw plugins (safe to keep in plugins.allow)
const BUNDLED_OPENCLAW_PLUGINS = [
  "http", "mcp", "computer-use", "browser", "code", "image", "voice",
  "search", "memory", "calendar", "email", "slack", "discord", "telegram",
  "whatsapp", "matrix", "teams", "notion", "github", "jira", "linear",
  "comfyui",
];

// Curated models for the /model picker — single source of truth for install scripts
const TOP_MODELS = [
  "auto", "free", "eco", "premium",
  "anthropic/claude-sonnet-4.6", "anthropic/claude-opus-4.6", "anthropic/claude-haiku-4.5",
  "openai/gpt-5.4", "openai/gpt-5.4-mini", "openai/gpt-5.4-pro",
  "openai/gpt-5.3", "openai/gpt-5.3-codex",
  "openai/gpt-5-mini", "openai/gpt-5-nano", "openai/gpt-5.4-nano",
  "openai/gpt-4o", "openai/gpt-4o-mini", "openai/o3", "openai/o4-mini",
  "google/gemini-3.1-pro", "google/gemini-3.1-flash-lite",
  "google/gemini-3-pro-preview", "google/gemini-3-flash-preview",
  "google/gemini-2.5-pro", "google/gemini-2.5-flash", "google/gemini-2.5-flash-lite",
  "deepseek/deepseek-chat", "deepseek/deepseek-reasoner", "nvidia/kimi-k2.5",
  "xai/grok-3", "xai/grok-4-0709", "xai/grok-4-1-fast-reasoning",
  "minimax/minimax-m2.7", "minimax/minimax-m2.5",
  "free/gpt-oss-120b", "free/gpt-oss-20b",
  "free/nemotron-ultra-253b", "free/deepseek-v3.2", "free/mistral-large-3-675b",
  "free/qwen3-coder-480b", "free/devstral-2-123b", "free/llama-4-maverick",
  "free/nemotron-3-super-120b", "free/nemotron-super-49b", "free/glm-4.7",
  "zai/glm-5", "zai/glm-5-turbo",
];

// ── Parse CLI args ───────────────────────────────────────────────

const args = new Set(process.argv.slice(2));

// Extract value args (--key value)
function getArgValue(key) {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(key);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return null;
}

const backupChannelsFile = getArgValue("--backup-channels");
const restoreChannelsFile = getArgValue("--restore-channels");

// If no action flags given, run all
const runAll = args.has("--all") || ![
  "--clean-entries", "--clean-lobster", "--verify-provider",
  "--populate-allowlist", "--add-to-allow", "--set-gateway-mode",
  "--inject-auth", "--backup-channels", "--restore-channels",
].some(f => args.has(f));

const doCleanEntries = runAll || args.has("--clean-entries");
const doCleanLobster = runAll || args.has("--clean-lobster");
const doVerifyProvider = runAll || args.has("--verify-provider");
const doPopulateAllowlist = runAll || args.has("--populate-allowlist");
const doAddToAllow = runAll || args.has("--add-to-allow");
const doSetGatewayMode = runAll || args.has("--set-gateway-mode");
const doInjectAuth = runAll || args.has("--inject-auth");
const doBackupChannels = !!backupChannelsFile;
const doRestoreChannels = !!restoreChannelsFile;

// ── Main ─────────────────────────────────────────────────────────

const configDir = path.join(os.homedir(), ".openclaw");
const configPath = path.join(configDir, "openclaw.json");

// Load config (single read for all operations)
let config;
try {
  config = loadJson(configPath);
} catch (err) {
  const backupPath = configPath + ".corrupt." + Date.now();
  try { fs.copyFileSync(configPath, backupPath); } catch {}
  console.error("  ERROR: Invalid JSON in openclaw.json: " + err.message);
  console.error("  Backed up to: " + backupPath);
  process.exit(1);
}

if (!config) {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  config = {};
  log("No openclaw.json found, creating");
}

let changed = false;

// ── Backup channels (before any modifications) ──────────────────

if (doBackupChannels) {
  const preserved = {};
  if (config.channels) preserved.channels = config.channels;
  if (config.gateway) preserved.gateway = config.gateway;
  fs.writeFileSync(backupChannelsFile, JSON.stringify(preserved, null, 2));
  const channelCount = Object.keys(config.channels || {}).length;
  if (channelCount > 0) {
    log("Preserved config for channels: " + Object.keys(config.channels).join(", "));
  }
}

// ── Clean stale plugin entries ───────────────────────────────────

if (doCleanEntries) {
  const plugins = config.plugins;
  if (plugins) {
    for (const key of CLAWROUTER_KEYS) {
      if (plugins.entries && plugins.entries[key]) {
        delete plugins.entries[key];
        changed = true;
        log("Removed plugins.entries." + key);
      }
      if (plugins.installs && plugins.installs[key]) {
        delete plugins.installs[key];
        changed = true;
      }
    }

    // Clean plugins.allow — remove clawrouter (re-added later by --add-to-allow)
    // and strip stale bare single-word entries not in bundled list
    if (Array.isArray(plugins.allow)) {
      const before = plugins.allow.length;
      plugins.allow = plugins.allow.filter(function (p) {
        if (CLAWROUTER_KEYS.includes(p)) return false;
        if (BUNDLED_OPENCLAW_PLUGINS.includes(p)) return true;
        if (p.startsWith("@") || p.includes("/")) return true;
        return false; // drop bare unknown entries (e.g. "wallet" added by mistake)
      });
      const removed = before - plugins.allow.length;
      if (removed > 0) {
        changed = true;
        log("Removed " + removed + " stale plugins.allow entry(ies)");
      }
    }
  }
}

// ── Clean lobster/crossmint entries ──────────────────────────────

if (doCleanLobster) {
  const plugins = config.plugins;
  if (plugins) {
    for (const key of LOBSTER_KEYS) {
      if (plugins.entries && plugins.entries[key]) {
        delete plugins.entries[key];
        changed = true;
        log("Removed plugins.entries." + key);
      }
      if (plugins.installs && plugins.installs[key]) {
        delete plugins.installs[key];
        changed = true;
      }
    }
    if (Array.isArray(plugins.allow)) {
      const before = plugins.allow.length;
      plugins.allow = plugins.allow.filter(function (p) {
        return !LOBSTER_KEYS.includes(p);
      });
      if (plugins.allow.length !== before) {
        changed = true;
        log("Removed lobster/crossmint from plugins.allow");
      }
    }
  }
}

// ── Verify/fix provider config ───────────────────────────────────

if (doVerifyProvider) {
  if (!config.models) config.models = {};
  if (!config.models.providers) config.models.providers = {};
  const provider = config.models.providers.blockrun;
  if (provider) {
    if (!provider.baseUrl) {
      provider.baseUrl = "http://127.0.0.1:8402/v1";
      changed = true;
      log("Fixed missing baseUrl");
    }
    if (!provider.apiKey) {
      provider.apiKey = "x402-proxy-handles-auth";
      changed = true;
      log("Fixed missing apiKey");
    }
    if (!provider.api) {
      provider.api = "openai-completions";
      changed = true;
    }
  } else {
    config.models.providers.blockrun = {
      baseUrl: "http://127.0.0.1:8402/v1",
      api: "openai-completions",
      apiKey: "x402-proxy-handles-auth",
      models: [],
    };
    changed = true;
    log("Created blockrun provider config");
  }
}

// ── Populate model allowlist ─────────────────────────────────────

if (doPopulateAllowlist) {
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.models || typeof config.agents.defaults.models !== "object" ||
      Array.isArray(config.agents.defaults.models)) {
    config.agents.defaults.models = {};
    changed = true;
  }

  const allowlist = config.agents.defaults.models;
  const currentKeys = new Set(TOP_MODELS.map(function (id) { return "blockrun/" + id; }));

  // Remove deprecated blockrun/* entries not in the current list
  let removed = 0;
  for (const key of Object.keys(allowlist)) {
    if (key.startsWith("blockrun/") && !currentKeys.has(key)) {
      delete allowlist[key];
      removed++;
    }
  }

  // Add missing current models
  let added = 0;
  for (const id of TOP_MODELS) {
    const key = "blockrun/" + id;
    if (!allowlist[key]) {
      allowlist[key] = {};
      added++;
    }
  }

  if (removed > 0) {
    changed = true;
    log("Removed " + removed + " deprecated models from allowlist");
  }
  if (added > 0) {
    changed = true;
    log("Added " + added + " models to allowlist (" + TOP_MODELS.length + " total)");
  }
  if (added === 0 && removed === 0) {
    log("Allowlist already up to date");
  }
}

// ── Add clawrouter to plugins.allow ──────────────────────────────

if (doAddToAllow) {
  if (!config.plugins) config.plugins = {};
  if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
  if (!config.plugins.allow.includes("clawrouter") &&
      !config.plugins.allow.includes("@blockrun/clawrouter")) {
    config.plugins.allow.push("clawrouter");
    changed = true;
    log("Added clawrouter to plugins.allow");
  } else {
    log("Plugin already in allow list");
  }
}

// ── Set gateway.mode ─────────────────────────────────────────────

if (doSetGatewayMode) {
  if (!config.gateway) config.gateway = {};
  if (!config.gateway.mode) {
    config.gateway.mode = "local";
    changed = true;
    log("Set gateway.mode = local (required by OpenClaw v2026.4.5+)");
  } else {
    log("gateway.mode already set: " + config.gateway.mode);
  }
}

// ── Restore channels (after all modifications) ──────────────────

if (doRestoreChannels) {
  try {
    const preserved = JSON.parse(fs.readFileSync(restoreChannelsFile, "utf8"));

    if (preserved.channels && Object.keys(preserved.channels).length > 0) {
      if (!config.channels || Object.keys(config.channels).length === 0) {
        config.channels = preserved.channels;
        changed = true;
        log("Restored channel config (Telegram/WhatsApp/etc.)");
      } else {
        let merged = 0;
        for (const [ch, val] of Object.entries(preserved.channels)) {
          if (!config.channels[ch]) {
            config.channels[ch] = val;
            merged++;
          }
        }
        if (merged > 0) {
          changed = true;
          log("Merged " + merged + " missing channel(s) back into config");
        } else {
          log("Channel config intact");
        }
      }
    }

    if (preserved.gateway && preserved.gateway.mode &&
        (!config.gateway || !config.gateway.mode)) {
      if (!config.gateway) config.gateway = {};
      config.gateway.mode = preserved.gateway.mode;
      changed = true;
    }
  } catch (e) {
    log("Warning: could not restore channel config: " + e.message);
  }
}

// ── Write config (single atomic write) ───────────────────────────

if (changed) {
  atomicWrite(configPath, JSON.stringify(config, null, 2));
  log("Config updated");
} else {
  log("Config unchanged");
}

// ── Inject auth profile ─────────────────────────────────────────

if (doInjectAuth) {
  const agentsDir = path.join(configDir, "agents");
  const mainAuthDir = path.join(agentsDir, "main", "agent");
  fs.mkdirSync(mainAuthDir, { recursive: true });

  // Collect all agent dirs + ensure "main" is included
  let agentDirs = ["main"];
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "main") {
        agentDirs.push(entry.name);
      }
    }
  } catch {}

  let injected = 0;
  for (const agentId of agentDirs) {
    const authDir = path.join(agentsDir, agentId, "agent");
    const authPath = path.join(authDir, "auth-profiles.json");

    fs.mkdirSync(authDir, { recursive: true });

    let store = { version: 1, profiles: {} };
    if (fs.existsSync(authPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(authPath, "utf8"));
        if (existing.version && existing.profiles) {
          store = existing;
        }
      } catch {}
    }

    const profileKey = "blockrun:default";
    if (!store.profiles[profileKey]) {
      store.profiles[profileKey] = {
        type: "api_key",
        provider: "blockrun",
        key: "x402-proxy-handles-auth",
      };
      atomicWrite(authPath, JSON.stringify(store, null, 2));
      injected++;
    }
  }

  if (injected > 0) {
    log("Injected auth profile for " + injected + " agent(s)");
  } else {
    log("Auth profiles already exist");
  }
}
