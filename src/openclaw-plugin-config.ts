/** OpenClaw's bundled router owns `clawrouter`; BlockRun must never claim it. */
export const BLOCKRUN_PLUGIN_ID = "blockrun-clawrouter";

export type PluginConfigMigrationOptions = {
  /** The user explicitly asked to install/enable BlockRun ClawRouter. */
  explicitSetup?: boolean;
  /** A legacy @blockrun/clawrouter install was independently verified on disk. */
  legacyBlockRunInstall?: boolean;
  /** OpenClaw 2.0 rejected the legacy plugins.installs config key. */
  stripUnsupportedInstalls?: boolean;
};

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/**
 * Prepare openclaw.json before installation.
 *
 * This intentionally preserves the `clawrouter` entry itself. That id belongs
 * to OpenClaw's bundled router now, so deleting or renaming the entry can
 * change an unrelated official plugin. When the old package directory was
 * proven to contain @blockrun/clawrouter, only BlockRun-owned fields are moved
 * to the new id and removed from the official plugin's entry.
 */
export function prepareBlockRunPluginConfig(
  config: JsonObject,
  options: PluginConfigMigrationOptions = {},
): boolean {
  if (
    !options.explicitSetup &&
    !options.legacyBlockRunInstall &&
    !options.stripUnsupportedInstalls
  ) {
    return false;
  }

  let changed = false;
  let plugins = asObject(config.plugins);
  if (!plugins) {
    plugins = {};
    config.plugins = plugins;
    changed = true;
  }

  let entries = asObject(plugins.entries);
  if (!entries) {
    entries = {};
    plugins.entries = entries;
    changed = true;
  }

  const legacyEntry = asObject(entries.clawrouter);
  const currentEntry = asObject(entries[BLOCKRUN_PLUGIN_ID]);
  if (options.legacyBlockRunInstall && legacyEntry) {
    const migratedEntry = currentEntry ?? {};
    if (!currentEntry && typeof legacyEntry.enabled === "boolean") {
      migratedEntry.enabled = legacyEntry.enabled;
    }
    for (const key of ["walletKey", "routing"] as const) {
      if (!(key in migratedEntry) && key in legacyEntry) {
        migratedEntry[key] = legacyEntry[key];
      }
      if (key in legacyEntry) {
        delete legacyEntry[key];
        changed = true;
      }
    }

    const legacyConfig = asObject(legacyEntry.config);
    if (legacyConfig) {
      const currentConfig = asObject(migratedEntry.config) ?? {};
      for (const key of ["walletKey", "routing"] as const) {
        if (!(key in currentConfig) && key in legacyConfig) {
          currentConfig[key] = legacyConfig[key];
        }
        if (key in legacyConfig) {
          delete legacyConfig[key];
          changed = true;
        }
      }
      if (Object.keys(currentConfig).length > 0) migratedEntry.config = currentConfig;
      if (Object.keys(legacyConfig).length === 0) {
        delete legacyEntry.config;
        changed = true;
      }
    }

    if (!currentEntry || entries[BLOCKRUN_PLUGIN_ID] !== migratedEntry) {
      entries[BLOCKRUN_PLUGIN_ID] = migratedEntry;
      changed = true;
    }
  }
  if (options.explicitSetup) {
    const next = asObject(entries[BLOCKRUN_PLUGIN_ID]) ?? {};
    if (next.enabled !== true) {
      entries[BLOCKRUN_PLUGIN_ID] = { ...next, enabled: true };
      changed = true;
    }
  }

  const allow = plugins.allow;
  if (Array.isArray(allow)) {
    const shouldAllow =
      options.explicitSetup || (options.legacyBlockRunInstall && allow.includes("clawrouter"));
    if (shouldAllow && !allow.includes(BLOCKRUN_PLUGIN_ID)) {
      allow.push(BLOCKRUN_PLUGIN_ID);
      changed = true;
    }
  }

  const deny = plugins.deny;
  if (Array.isArray(deny)) {
    if (options.explicitSetup) {
      const next = deny.filter((id) => id !== BLOCKRUN_PLUGIN_ID);
      if (next.length !== deny.length) {
        plugins.deny = next;
        changed = true;
      }
    } else if (
      options.legacyBlockRunInstall &&
      deny.includes("clawrouter") &&
      !deny.includes(BLOCKRUN_PLUGIN_ID)
    ) {
      deny.push(BLOCKRUN_PLUGIN_ID);
      changed = true;
    }
  }

  // OpenClaw 2.0 stores install provenance outside openclaw.json and rejects
  // this legacy key at schema-validation time. Never rename it to a new key.
  if (options.stripUnsupportedInstalls && "installs" in plugins) {
    delete plugins.installs;
    changed = true;
  }

  return changed;
}
