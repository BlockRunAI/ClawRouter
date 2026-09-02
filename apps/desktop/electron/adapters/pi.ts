import { join } from "node:path";

import { upsertPiConfig, type PiModelConfig } from "../core/config.js";
import { readText } from "../core/files.js";
import { ensureNpmPackage, findCommand } from "../core/runtime.js";
import type { AdapterContext, AgentAdapter, AgentStatus, InstallOptions } from "../core/types.js";
import { statusShape } from "./shared.js";

export class PiAdapter implements AgentAdapter {
  readonly id = "pi" as const;
  readonly name = "Pi";
  readonly description =
    "Minimal terminal coding agent routed through the local ClawRouter catalog.";
  readonly activation = "immediate" as const;

  managedPaths(context: AdapterContext): string[] {
    const agentDir = join(context.homeDir, ".pi", "agent");
    return [join(agentDir, "models.json"), join(agentDir, "settings.json")];
  }

  async status(context: AdapterContext): Promise<AgentStatus> {
    const raw = await readText(this.managedPaths(context)[0]!);
    const configured = hasPiProvider(raw, context.proxyBaseUrl);
    return statusShape({
      context,
      id: this.id,
      name: this.name,
      description: this.description,
      installed: Boolean(await findCommand(context, "pi")),
      configured,
      activation: this.activation,
      restartRequired: false,
      details: configured
        ? [
            "Open /model (or press Ctrl+L) in Pi to use or refresh ClawRouter models; no restart is needed.",
          ]
        : [],
    });
  }

  async install(context: AdapterContext, options: InstallOptions): Promise<void> {
    await ensureNpmPackage(context, "@earendil-works/pi-coding-agent", "pi", {
      ignoreScripts: true,
      version: "0.84.4",
    });
    const models = await fetchPiModels(context);
    const selected =
      options.model && models.some((model) => model.id === options.model)
        ? options.model
        : models.some((model) => model.id === "auto")
          ? "auto"
          : (models[0]?.id ?? "auto");
    await upsertPiConfig(
      this.managedPaths(context)[0]!,
      this.managedPaths(context)[1]!,
      context.proxyBaseUrl,
      models,
      selected,
    );
  }

  async verify(context: AdapterContext): Promise<{ ok: boolean; details: string[] }> {
    const [models, settings] = await Promise.all(
      this.managedPaths(context).map((path) => readText(path)),
    );
    const provider = hasPiProvider(models, context.proxyBaseUrl);
    const defaults = hasPiDefaults(settings);
    return {
      ok: provider && defaults,
      details: [
        provider ? "Pi ClawRouter provider registered" : "Pi ClawRouter provider missing",
        defaults ? "Pi default route points to ClawRouter" : "Pi default route is not configured",
      ],
    };
  }
}

async function fetchPiModels(context: AdapterContext): Promise<PiModelConfig[]> {
  try {
    const response = await context.fetch(`${context.proxyBaseUrl}/models`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
    const models = (body.data ?? [])
      .map((item) => toPiModel(item))
      .filter((model): model is PiModelConfig => Boolean(model));
    if (models.length) return models;
  } catch {
    // The core routing aliases keep setup useful while a catalog refresh is pending.
  }
  return ["auto", "free", "eco", "premium"].map((id) => ({ id, name: displayName(id) }));
}

function toPiModel(item: Record<string, unknown>): PiModelConfig | null {
  const id = typeof item.id === "string" ? item.id : "";
  if (!id) return null;
  const contextWindow = numberValue(item.context_window);
  const maxTokens = numberValue(item.max_output);
  const inputPrice = numberValue(item.input_price);
  const outputPrice = numberValue(item.output_price);
  const vision = booleanValue(item.vision) ?? false;
  return {
    id,
    name: stringValue(item.name) ?? displayName(id),
    reasoning: booleanValue(item.reasoning) ?? false,
    input: vision ? ["text", "image"] : ["text"],
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(inputPrice != null && outputPrice != null
      ? { cost: { input: inputPrice, output: outputPrice, cacheRead: 0, cacheWrite: 0 } }
      : {}),
  };
}

function hasPiProvider(raw: string, baseUrl: string): boolean {
  try {
    const value = JSON.parse(raw) as { providers?: Record<string, Record<string, unknown>> };
    const provider = value.providers?.clawrouter;
    return provider?.baseUrl === baseUrl && provider?.api === "openai-completions";
  } catch {
    return false;
  }
}

function hasPiDefaults(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as { defaultProvider?: unknown; defaultModel?: unknown };
    return value.defaultProvider === "clawrouter" && typeof value.defaultModel === "string";
  } catch {
    return false;
  }
}

function displayName(id: string): string {
  if (id === "auto") return "Auto (Smart Router)";
  return id.split("/").at(-1)?.replaceAll("-", " ") ?? id;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
