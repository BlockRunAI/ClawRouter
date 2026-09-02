import { join } from "node:path";
import { parse } from "yaml";

import { upsertDshConfig } from "../core/config.js";
import { readText } from "../core/files.js";
import { ensureNpmPackage, findCommand } from "../core/runtime.js";
import type { AdapterContext, AgentAdapter, AgentStatus, InstallOptions } from "../core/types.js";
import { assertCommand, statusShape } from "./shared.js";

export class DshAdapter implements AgentAdapter {
  readonly id = "dsh" as const;
  readonly name = "DeepSeek Harness";
  readonly description =
    "Official DSH provider configuration with hot-reload and no separate API key.";
  readonly activation = "immediate" as const;

  managedPaths(context: AdapterContext): string[] {
    const home = dshHome(context);
    return [join(home, "settings.yaml"), join(home, ".credentials.yaml")];
  }

  async status(context: AdapterContext): Promise<AgentStatus> {
    const settings = await readText(this.managedPaths(context)[0]!);
    const installed = Boolean(await findCommand(context, "dsh"));
    const configured = /llm-pi-ai:[\s\S]*clawrouter:/m.test(settings);
    return statusShape({
      context,
      id: this.id,
      name: this.name,
      description: this.description,
      installed,
      configured,
      activation: this.activation,
      restartRequired: false,
      details: ["DSH settings are hot-reloaded.", "DSH is currently a developer preview."],
    });
  }

  async install(context: AdapterContext, options: InstallOptions): Promise<void> {
    const dsh = await ensureNpmPackage(context, "@deepseek-ai/dsh", "dsh");
    const models = await fetchModelIds(context);
    await upsertDshConfig(
      this.managedPaths(context)[0]!,
      this.managedPaths(context)[1]!,
      context.proxyBaseUrl,
      models,
      options.model ?? "auto",
    );
    const dump = await context.runCommand(dsh, ["--profile", "web", "--dump-config"], {
      env: { ...process.env, HOME: context.homeDir, DSH_HOME: dshHome(context) },
      timeoutMs: 60_000,
    });
    assertCommand(dump, "DSH config validation");
  }

  async verify(context: AdapterContext): Promise<{ ok: boolean; details: string[] }> {
    try {
      const settings = parse(await readText(this.managedPaths(context)[0]!)) as Record<string, any>;
      const provider = settings?.["llm-pi-ai"]?.providers?.clawrouter;
      const selected = settings?.["agent-default-model"];
      const ok = provider?.baseURL === context.proxyBaseUrl && selected?.provider === "clawrouter";
      return {
        ok,
        details: [
          provider ? "DSH provider registered" : "DSH provider missing",
          selected?.provider === "clawrouter"
            ? "ClawRouter is the DSH default"
            : "DSH default model not configured",
        ],
      };
    } catch (error) {
      return {
        ok: false,
        details: [`Invalid DSH YAML: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }
}

function dshHome(context: AdapterContext): string {
  return process.env.DSH_HOME || join(context.homeDir, ".dsh");
}

async function fetchModelIds(context: AdapterContext): Promise<string[]> {
  try {
    const response = await context.fetch(`${context.proxyBaseUrl}/models`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    const models =
      body.data?.map((item) => item.id).filter((id): id is string => Boolean(id)) ?? [];
    if (models.length) return models;
  } catch {
    // Keep setup useful while the proxy is being installed; the catalog refreshes later.
  }
  return ["auto", "free", "eco", "premium"];
}
